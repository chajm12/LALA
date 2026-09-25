import type OpenAI from "openai";
import { nim, PLANNER_MODEL, RESERVE_MODEL } from "@/lib/nim";
import { agentLog, type TraceEvent } from "@/lib/log";
import { executeTool, TOOL_DEFS } from "./tools";
import { emptyState, serializeState, summarizeState, type AgentState } from "./state";

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentEvent =
  | { type: "trace"; event: TraceEvent }
  | { type: "state"; patch: Partial<AgentState> }
  | { type: "assistant"; text: string }
  | { type: "question"; text: string }
  | { type: "done"; state: AgentState }
  | { type: "error"; message: string };

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 16);

const SYSTEM_PROMPT = `너는 패션 이커머스의 퍼스널 스타일링 에이전트다. 목표를 받으면 스스로 계획을 세우고 도구를 골라 호출해 해결한다.

목표: 사용자의 요청에 맞는 "검증된 룩북 2안 + 각 룩의 실제 상품 매칭"을 완성한다.

원칙:
- 도구 호출 순서는 네가 정한다. 보통 parse_request → (get_weather) → catalog_summary → analyze_style → run_styling_loop → render_lookbook×2 → match_products×2 → finish 이지만, 상황에 맞게 바꾼다.
  · 실내 행사이거나 사용자가 날씨는 무관하다고 하면 get_weather 를 건너뛰고 그 이유를 analyze_style 의 extra_context 에 적는다.
  · 사용자가 특정 품목(예: 로퍼)을 요구하면 search_catalog 로 재고를 확인하고, 없으면 대안을 analyze_style 에 반영한다.
  · 카탈로그에 없는 카테고리는 후보에 넣지 않도록 analyze_style 에 반영한다.
- 후속 요청(이미 looks 가 있는 상태)에서는 전체를 다시 돌리지 말고 필요한 것만 한다: 특정 룩의 아이템 변경 → revise_look → render_lookbook → match_products → finish. 날짜/장소가 바뀌면 parse_request 와 get_weather 부터 다시.
- ask_user 는 정말 진행이 불가능할 때만, 대화당 1번. 성별·날짜·장소가 없으면 기본값(남성, 다음 주말, 서울)으로 진행한다.
- 한 턴에 독립적인 도구(예: 두 룩의 render_lookbook)는 동시에 여러 개 호출해도 된다.
- 반드시 finish 로 끝낸다. summary 에는 결과와 함께 "어떤 판단을 했는지"(예: 강수확률이 낮아 스웨이드 허용, 카탈로그에 코트가 없어 재킷 위주)를 한국어로 적는다.
- 도구 결과의 오류 메시지를 읽고 스스로 수정한다 (예: 잘못된 concept_id).`;

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function stepLabel(name: string, args: Record<string, unknown>) {
  const a = Object.entries(args).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(", ");
  return a ? `${name}(${a})` : `${name}()`;
}

async function callPlanner(messages: Msg[], trace: TraceEvent[], toolChoice: "auto" | "required" = "auto") {
  const models = [PLANNER_MODEL, RESERVE_MODEL];
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await nim.chat.completions.create(
          {
            model,
            messages,
            tools: TOOL_DEFS,
            tool_choice: toolChoice,
            temperature: 0.2,
            max_tokens: 1500,
            // @ts-expect-error NVIDIA 확장 필드
            chat_template_kwargs: { enable_thinking: false },
          },
          { timeout: 60_000, maxRetries: 0 },
        );
        return { message: res.choices[0].message, model };
      } catch (e) {
        lastError = e;
        const status = (e as { status?: number })?.status;
        if (status !== undefined && status >= 500) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
        break;
      }
    }
    agentLog("agent", `⚠ ${model} 플래너 호출 실패 → 대체 모델`, "fallback", trace);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 에이전트 루프: 플래너가 도구를 고르고 → 실행 → 결과를 보고 다음을 정한다.
 * emit 으로 진행 상황을 스트리밍한다.
 */
export async function runAgent(
  history: ChatTurn[],
  incomingState: AgentState | null,
  emit: (e: AgentEvent) => void,
) {
  const latestUser = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const state: AgentState = incomingState ?? emptyState(latestUser);
  if (!incomingState) state.keyword = latestUser;
  else if (history.filter((t) => t.role === "user").length > 1) state.keyword = `${state.keyword} / 후속: ${latestUser}`;

  const trace: TraceEvent[] = [];
  const origPush = trace.push.bind(trace);
  trace.push = (...events: TraceEvent[]) => { for (const ev of events) emit({ type: "trace", event: ev }); return origPush(...events); };
  const emitState = (patch: Partial<AgentState>) => emit({ type: "state", patch: serializeState({ ...emptyState(""), ...patch } as AgentState) });

  const messages: Msg[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\n오늘: ${new Date().toISOString().slice(0, 10)}\n현재 작업 상태:\n${JSON.stringify(summarizeState(state))}` },
    ...history.map((t) => ({ role: t.role, content: t.content }) as Msg),
  ];

  agentLog("agent", incomingState ? "후속 요청 처리 시작 (기존 상태 이어서)" : "에이전트 시작: 목표를 받고 도구 계획 수립", `chat.completions · ${PLANNER_MODEL}`, trace);
  let asked = false;
  let toolsExecuted = 0;
  let nudges = 0;

  for (let step = 1; step <= MAX_STEPS; step++) {
    const { message, model } = await callPlanner(messages, trace, nudges > 0 && toolsExecuted === 0 ? "required" : "auto");
    messages.push(message as Msg);
    const calls = (message.tool_calls ?? []).filter(
      (c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => c.type === "function",
    );

    if (!calls.length) {
      const text = (message.content ?? "").trim();
      // 도구를 하나도 안 쓰고 말로만 "했다"고 하는 경우(환각 행동) → 실제 도구 호출을 강제
      if (toolsExecuted === 0 && nudges < 2) {
        nudges++;
        agentLog("agent", `⚠ 플래너가 도구 없이 답변만 생성 → 실제 도구 호출 요구 (${nudges}/2)`, `chat.completions · ${model}`, trace);
        messages.push({
          role: "user",
          content: "지금 아무 도구도 호출하지 않았다. 말로 설명하지 말고 필요한 도구(예: revise_look, render_lookbook, match_products)를 실제로 호출해서 작업을 수행하라. 작업이 필요 없다면 finish 를 호출해 이유를 설명하라.",
        });
        continue;
      }
      agentLog("agent", `플래너가 도구 없이 응답 → 종료 처리`, `chat.completions · ${model}`, trace);
      emit({ type: "assistant", text: text || "작업을 마쳤어요." });
      emit({ type: "done", state: serializeState(state) });
      return state;
    }

    agentLog("agent", `[${step}] 플래너 결정: ${calls.map((c) => stepLabel(c.function.name, safeArgs(c.function.arguments))).join(" · ")}`, `chat.completions · ${model}`, trace);

    // 종료성 도구는 단독 처리
    const terminal = calls.find((c) => c.function.name === "finish" || c.function.name === "ask_user");
    if (terminal) {
      const args = safeArgs(terminal.function.arguments);
      if (terminal.function.name === "ask_user") {
        if (asked) {
          messages.push({ role: "tool", tool_call_id: terminal.id, content: "이미 한 번 물었다. 기본값으로 진행하고 finish 로 끝내라." });
          continue;
        }
        asked = true;
        const q = String(args.question ?? "추가 정보가 필요해요.");
        agentLog("agent", `사용자에게 질문: ${q}`, undefined, trace);
        emit({ type: "question", text: q });
        emit({ type: "done", state: serializeState(state) });
        return state;
      }
      const summary = String(args.summary ?? "작업을 마쳤어요.");
      agentLog("agent", `완료: ${summary.slice(0, 80)}`, undefined, trace);
      emit({ type: "assistant", text: summary });
      emit({ type: "done", state: serializeState(state) });
      return state;
    }

    // 나머지 도구는 병렬 실행 (플래너가 한 턴에 여러 개 낸 경우)
    const results = await Promise.all(
      calls.map(async (c) => {
        const args = safeArgs(c.function.arguments);
        try {
          return { id: c.id, content: await executeTool(c.function.name, args, { state, trace, emitState }) };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          agentLog("agent", `✗ 도구 ${c.function.name} 실패: ${msg.slice(0, 120)}`, undefined, trace);
          return { id: c.id, content: `오류: ${msg.slice(0, 300)}` };
        }
      }),
    );
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    toolsExecuted += results.length;
  }

  agentLog("agent", `최대 단계(${MAX_STEPS}) 도달 → 종료`, undefined, trace);
  emit({ type: "assistant", text: "단계 한도에 도달해 여기까지의 결과를 보여드려요." });
  emit({ type: "done", state: serializeState(state) });
  return state;
}

function safeArgs(raw: string | undefined): Record<string, unknown> {
  try { return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { return {}; }
}
