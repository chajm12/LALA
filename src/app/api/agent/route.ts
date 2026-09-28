import { NextResponse } from "next/server";
import { agentLog } from "@/lib/log";
import { callInternalJson } from "@/lib/internal-route-client";

type TraceEvent = {
  type: "tool_call" | "tool_result";
  tool: string;
  message: string;
};

type TraceEmitter = (event: TraceEvent) => void;

type AgentAction =
  | "prepare"
  | "consult"
  | "plan"
  | "lookbook"
  | "refine"
  | "shopping"
  | "full";

type AgentState = {
  keyword: string;
  intent: unknown;
  trend: string | null;
  weather: unknown;
  evaluationProcess: Record<string, unknown> | null;
  variants: unknown[];
};

async function runNatWorkflow(keyword: string) {
  const workflowUrl = process.env.NAT_WORKFLOW_URL?.trim();
  if (!workflowUrl) return null;

  const endpoint = workflowUrl.endsWith("/generate") ? workflowUrl : `${workflowUrl.replace(/\/$/, "")}/generate`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: keyword }),
    cache: "no-store",
    signal: AbortSignal.timeout(180_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const result = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(`NeMo Agent Toolkit Workflow 요청 실패 (${response.status})`);
  return {
    workflow: "nvidia-nat",
    input: keyword,
    output: result,
    trace: [{
      type: "tool_result" as const,
      tool: "nemo_agent_toolkit",
      message: "공식 NeMo Agent Toolkit Workflow가 등록된 DDP Tool들을 실행했습니다.",
    }],
  };
}

async function callInternalRoute(req: Request, path: string, body: unknown) {
  return callInternalJson(req, path, body, path === "/api/shopping" ? {
    timeoutMs: 120_000,
    timeoutMessage: "상품 검색 시간이 초과됐어요. 이 룩의 상품을 다시 찾아주세요.",
  } : {});
}

function actionToolName(action: Exclude<AgentAction, "full">) {
  return action === "prepare"
    ? "context_agent"
    : action === "consult"
      ? "style_consultation"
      : action === "plan"
        ? "outfit_planner"
        : action === "lookbook"
          ? "lookbook_generator"
          : action === "refine"
            ? "look_refinement"
            : "shopping_link_search";
}

function pushTrace(trace: TraceEvent[], event: TraceEvent, emit?: TraceEmitter) {
  trace.push(event);
  emit?.(event);
  agentLog(
    event.type === "tool_call" ? "concept" : "evaluate",
    event.message,
    `Agent Tool · ${event.tool}`,
  );
}

async function executeTool(
  req: Request,
  name: string,
  state: AgentState,
  trace: TraceEvent[],
  emit?: TraceEmitter,
) {
  if (name === "user_intent_extractor") {
    pushTrace(trace, { type: "tool_call", tool: name, message: "Agent가 사용자 요구사항 추출 Tool을 선택했습니다." }, emit);
    const result = await callInternalRoute(req, "/api/intent", { keyword: state.keyword });
    state.intent = result.intent ?? null;
    pushTrace(trace, {
      type: "tool_result",
      tool: name,
      message: "직접 요구, 회피 요소, 무드·핏·소재 방향과 부족한 정보를 구조화했습니다.",
    }, emit);
    return { ok: true, summary: "intent_ready" };
  }

  if (name === "analyze_context") {
    pushTrace(trace, { type: "tool_call", tool: name, message: "Agent가 컨텍스트 분석 Tool을 선택했습니다." }, emit);
    const result = await callInternalRoute(req, "/api/trend", { keyword: state.keyword });
    state.trend = typeof result.trend === "string" ? result.trend : "";
    state.weather = result.weather ?? null;
    pushTrace(trace, { type: "tool_result", tool: name, message: "날씨·장소·트렌드 컨텍스트가 준비됐습니다." }, emit);
    return { ok: true, summary: "context_ready" };
  }

  if (name === "build_outfit_plan") {
    pushTrace(trace, { type: "tool_call", tool: name, message: "Agent가 후보 생성·평가·수정·재평가 Tool을 선택했습니다." }, emit);
    const result = await callInternalRoute(req, "/api/plan", {
      keyword: state.keyword,
      trend: state.trend,
      weather: state.weather,
      intent: state.intent,
    });
    state.evaluationProcess = result;
    const finalConcepts = Array.isArray(result.finalConcepts) ? result.finalConcepts : [];
    pushTrace(trace, {
      type: "tool_result",
      tool: name,
      message: `${result.planStatus === "partial" ? "보완 미완료 항목을 표시하고 확보한 후보에서" : "후보를 평가하고"} 최종 ${finalConcepts.length}안을 선택했습니다.`,
    }, emit);
    return { ok: true, summary: "plan_ready", finalConcepts };
  }

  if (name === "build_lookbook") {
    pushTrace(trace, { type: "tool_call", tool: name, message: "Agent가 최종 2안의 룩북 생성·Vision 검증 Tool을 선택했습니다." }, emit);
    const process = state.evaluationProcess ?? {};
    const concepts = Array.isArray(process.finalConcepts) ? process.finalConcepts : [];
    const evaluations = Array.isArray(process.round2) ? process.round2 : [];
    const results = await Promise.all(
      concepts.map(async (concept) => {
        const item = concept as Record<string, unknown>;
        const evaluation = evaluations.find((candidate) => {
          const current = candidate as Record<string, unknown>;
          return current.id === item.id || current.name === item.name;
        });
        return callInternalRoute(req, "/api/lookbook", {
          concept,
          evaluation,
          trend: state.trend,
          weather: state.weather,
        }).catch((error) => ({ imageUrl: null, verified: false, error: error instanceof Error ? error.message : "이미지 생성 실패" }) as Record<string, unknown>);
      }),
    );
    state.variants = results.map((result, index) => ({
      ...(concepts[index] as Record<string, unknown>),
      ...result,
      concept: result.concept ?? concepts[index],
      shoppingLinks: [],
      shoppingError: null,
      shoppingLoading: false,
    }));
    const verifiedCount = results.filter((result) => result.verified === true).length;
    pushTrace(trace, {
      type: "tool_result",
      tool: name,
      message: `${results.length}개 중 ${results.filter((result) => result.imageUrl).length}개 룩북을 생성했습니다. 이미지 비교 통과: ${verifiedCount}개. 나머지는 확인 상태를 표시합니다.`,
    }, emit);
    return { ok: true, summary: "lookbook_ready", verifiedCount };
  }

  pushTrace(trace, { type: "tool_result", tool: name, message: "필요한 Tool 실행을 모두 완료했습니다." }, emit);
  return { ok: true, summary: "finished" };
}

async function runAgentPipeline(req: Request, keyword: string, emit?: TraceEmitter) {
  const state: AgentState = {
    keyword,
    intent: null,
    trend: null,
    weather: null,
    evaluationProcess: null,
    variants: [],
  };
  const trace: TraceEvent[] = [];
  pushTrace(
    trace,
    {
      type: "tool_call",
      tool: "agent",
      message: "사용자 요청을 공유 스타일 상태로 만들고 필요한 Agent Tool 실행 그래프를 시작합니다.",
    },
    emit,
  );
  await executeTool(req, "user_intent_extractor", state, trace, emit);
  await executeTool(req, "analyze_context", state, trace, emit);
  await executeTool(req, "build_outfit_plan", state, trace, emit);
  await executeTool(req, "build_lookbook", state, trace, emit);
  pushTrace(
    trace,
    {
      type: "tool_result",
      tool: "agent",
      message: "컨텍스트 분석부터 최종 룩북 생성까지 완료했습니다.",
    },
    emit,
  );

  if (!state.evaluationProcess || !state.variants.length) {
    throw new Error("Agent가 최종 결과를 완성하지 못했어요.");
  }

  return {
    intent: state.intent,
    trend: state.trend,
    weather: state.weather,
    evaluationProcess: state.evaluationProcess,
    variants: state.variants,
    trace,
  };
}

async function runAgentAction(req: Request, action: Exclude<AgentAction, "full">, body: Record<string, unknown>) {
  const trace: TraceEvent[] = [];
  const tool = actionToolName(action);
  pushTrace(
    trace,
    {
      type: "tool_call",
      tool: "agent",
      message: `Agent Orchestrator가 ${tool} 실행을 선택했습니다.`,
    },
  );

  if (action === "prepare") {
    const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    if (!keyword) throw new Error("사용자 요청을 입력해주세요.");

    pushTrace(trace, {
      type: "tool_call",
      tool: "user_intent_extractor",
      message: "사용자 요구사항과 부족한 정보를 구조화합니다.",
    });
    pushTrace(trace, {
      type: "tool_call",
      tool: "analyze_context",
      message: "날짜·장소·날씨·트렌드 컨텍스트를 병렬로 분석합니다.",
    });

    const [intentResult, contextResult] = await Promise.all([
      callInternalRoute(req, "/api/intent", { keyword }),
      callInternalRoute(req, "/api/trend", { keyword }),
    ]);

    pushTrace(trace, {
      type: "tool_result",
      tool: "user_intent_extractor",
      message: "직접 요구, 회피 요소, 무드·핏·소재 방향과 부족한 정보를 구조화했습니다.",
    });
    pushTrace(trace, {
      type: "tool_result",
      tool: "analyze_context",
      message: "날씨·계절과 장소·상황 컨텍스트가 준비됐습니다.",
    });
    return {
      ...contextResult,
      intent: intentResult.intent ?? null,
      trace,
      runtime: "next-agent-orchestrator",
    };
  }

  const payload = { ...body };
  delete payload.action;
  const route = action === "consult"
    ? "/api/consult"
    : action === "plan"
      ? "/api/plan"
      : action === "lookbook"
        ? "/api/lookbook"
        : action === "refine"
          ? "/api/refine"
          : "/api/shopping";

  const result = await callInternalRoute(req, route, payload);
  pushTrace(trace, {
    type: "tool_result",
    tool,
    message: action === "consult"
      ? "사용자 피드백을 반영한 스타일 상담을 완료했습니다."
      : action === "plan"
        ? result.planStatus === "partial" ? "확보한 대안 후보를 평가했습니다. 보완 미완료 상태로 룩북 선택을 계속합니다." : "후보 생성·평가·수정·재평가를 완료했습니다."
        : action === "lookbook"
          ? result.imageUrl ? result.verified ? "룩북 생성과 이미지 비교를 완료했습니다." : "룩북을 생성했습니다. 이미지 비교 미완료 또는 불일치 항목은 카드에 표시합니다." : "룩북 이미지를 생성하지 못했습니다. 착장 명세는 유지합니다."
          : action === "refine"
            ? "사용자 수정 요청을 반영한 룩을 생성했습니다."
            : result.warning ? String(result.warning) : "착장 아이템별 상품 링크를 확인했습니다.",
  });
  return { ...result, trace, runtime: "next-agent-orchestrator" };
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없어요." }, { status: 400 });
  }
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";

  const requestedAction = typeof body.action === "string" ? body.action : "full";
  const action: AgentAction = ["prepare", "consult", "plan", "lookbook", "refine", "shopping", "full"].includes(requestedAction)
    ? requestedAction as AgentAction
    : "full";

  if (!keyword && !["lookbook", "refine"].includes(action)) {
    return NextResponse.json({ error: "사용자 요청을 입력해주세요." }, { status: 400 });
  }

  if (action !== "full") {
    try {
      return NextResponse.json(await runAgentAction(req, action, body));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent Tool 실행 중 알 수 없는 오류";
      agentLog("evaluate", `✗ ${action} Agent Action 실패: ${message}`, "Agent Orchestrator");
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const wantsStream = req.headers.get("accept")?.includes("text/event-stream");
  if (!wantsStream && process.env.NAT_WORKFLOW_URL?.trim()) {
    try {
      const natResult = await runNatWorkflow(keyword);
      if (natResult) return NextResponse.json(natResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : "NeMo Agent Toolkit Workflow 실행 실패";
      agentLog("evaluate", `✗ NAT Workflow 실패: ${message}`, "strict NeMo Agent Toolkit");
      return NextResponse.json({ error: `NeMo Agent Toolkit Workflow를 완료하지 못했습니다. ${message}` }, { status: 503 });
    }
  }
  if (wantsStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch {
            // The browser may have navigated away while a tool was running.
          }
        };
        const emit: TraceEmitter = (event) => send({ type: "trace", event });

        void runAgentPipeline(req, keyword, emit)
          .then((data) => {
            send({ type: "complete", data });
            controller.close();
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : "Agent 실행 중 알 수 없는 오류";
            agentLog("evaluate", `✗ Orchestrator 실패: ${message}`, "Agent Tool Graph");
            send({ type: "error", error: message });
            controller.close();
          });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  try {
    return NextResponse.json(await runAgentPipeline(req, keyword));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Agent 실행 중 알 수 없는 오류";
    agentLog("evaluate", `✗ Orchestrator 실패: ${message}`, "Agent Tool Graph");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
