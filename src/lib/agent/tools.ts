import type OpenAI from "openai";
import { chatJson, PLANNER_MODEL } from "@/lib/nim";
import { agentLog, fallbackLogger, type TraceEvent } from "@/lib/log";
import { normalizeConcepts, rankEvaluations, type ParsedRequest } from "@/lib/styling";
import { describeCatalog, fetchWeather, parseRequest, synthesizeTrend } from "@/lib/pipeline/trend";
import { judgeCandidates, runStylingLoop } from "@/lib/pipeline/loop";
import { renderLookbook } from "@/lib/pipeline/lookbook";
import { matchProducts } from "@/lib/pipeline/shopping";
import { retrieveProducts } from "@/lib/tools/catalog";
import type { AgentState } from "./state";

/**
 * 에이전트가 고를 수 있는 도구 목록 (OpenAI function-calling 스키마) 과 실행기.
 * 각 도구는 state 를 갱신하고, LLM 에게 돌려줄 "짧은 결과 요약" 문자열을 반환한다 (이미지·전체 JSON 은 절대 LLM 에 넣지 않는다).
 */
export type ToolContext = {
  state: AgentState;
  trace: TraceEvent[];
  emitState: (patch: Partial<AgentState>) => void;
};

export const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "parse_request",
      description: "사용자 요청 문장에서 날짜·장소·상황·성별·키·몸무게·제약을 구조화한다. 새 요청이 들어오면 가장 먼저 호출.",
      parameters: { type: "object", properties: { text: { type: "string", description: "해석할 요청 문장 (후속 요청이면 원 요청 + 변경 사항을 합쳐서)" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "장소·날짜의 실제 예보(16일 이내) 또는 작년 동기 기후를 조회한다. 실내 행사이거나 사용자가 날씨는 무관하다고 하면 건너뛰어도 된다.",
      parameters: { type: "object", properties: { place: { type: "string" }, date: { type: "string", description: "yyyy-mm-dd" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "catalog_summary",
      description: "매칭 가능한 상품 카탈로그의 카테고리별 재고 수를 확인한다. 특정 카테고리가 없으면 후보 생성 시 반영해야 한다.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_catalog",
      description: "카탈로그에서 특정 품목을 검색해 실제로 있는지 확인한다 (예: 사용자가 '로퍼'를 원할 때 로퍼 재고 확인).",
      parameters: { type: "object", properties: { query: { type: "string", description: "영어 검색어" }, category: { type: "string", description: "상의|아우터|하의|신발|가방|악세사리|모자" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_style",
      description: "지금까지 모은 정보(해석, 날씨, 카탈로그)로 스타일 방향 분석문을 작성한다. 후보 생성 전에 필요.",
      parameters: { type: "object", properties: { extra_context: { type: "string", description: "추가로 반영할 판단 (예: '카탈로그에 코트가 없어 아우터는 재킷 위주로')" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "run_styling_loop",
      description: "착장 후보 5개 생성 → 별도 평가 모델 채점 → 미달 시 수정 → 재평가를 반복해 최종 2안을 고른다. 분석문이 있어야 한다.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "render_lookbook",
      description: "지정한 룩의 룩북 이미지를 생성하고 VLM 으로 스펙 일치를 검증한다. 최종 2안 각각에 호출.",
      parameters: { type: "object", properties: { concept_id: { type: "string" } }, required: ["concept_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "match_products",
      description: "지정한 룩의 착용 아이템마다 카탈로그에서 실제 상품을 매칭한다.",
      parameters: { type: "object", properties: { concept_id: { type: "string" } }, required: ["concept_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "revise_look",
      description: "사용자 후속 요청대로 특정 룩을 수정하고(예: 신발을 로퍼로), 평가 모델로 재채점한다. 수정 후엔 render_lookbook 과 match_products 를 다시 호출해야 한다.",
      parameters: { type: "object", properties: { concept_id: { type: "string" }, instruction: { type: "string", description: "무엇을 어떻게 바꿀지 (한국어)" } }, required: ["concept_id", "instruction"] },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "진행에 꼭 필요한 정보가 없을 때만 사용자에게 한 가지를 묻고 멈춘다. 기본값(남성, 다음 주말, 서울)으로 진행 가능하면 묻지 말 것. 대화당 최대 1회.",
      parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "작업을 마치고 사용자에게 결과와 핵심 판단(왜 이 도구를 썼고 무엇을 결정했는지)을 한국어 2~4문장으로 설명한다. 반드시 마지막에 호출.",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    },
  },
];

type Args = Record<string, unknown>;

export async function executeTool(name: string, args: Args, ctx: ToolContext): Promise<string> {
  const { state, trace, emitState } = ctx;
  switch (name) {
    case "parse_request": {
      const text = String(args.text ?? state.keyword);
      const parsed = await parseRequest(text, trace);
      state.parsed = parsed;
      emitState({ parsed });
      return JSON.stringify(parsed);
    }
    case "get_weather": {
      const parsed: ParsedRequest = state.parsed ?? (await parseRequest(state.keyword, trace));
      const target = { ...parsed, place: String(args.place ?? parsed.place), date: String(args.date ?? parsed.date) };
      const weather = await fetchWeather(target, trace);
      state.weather = weather;
      emitState({ weather });
      return weather ? JSON.stringify(weather) : "날씨 조회 실패 — 계절감으로 판단할 것";
    }
    case "catalog_summary": {
      const s = describeCatalog(trace);
      state.catalog = s ? { total: s.total, byCategory: s.byCategory } : null;
      emitState({ catalog: state.catalog });
      return s ? JSON.stringify(state.catalog) : "카탈로그 인덱스 없음";
    }
    case "search_catalog": {
      agentLog("catalog", `카탈로그 검색: "${args.query}"${args.category ? ` (${args.category})` : ""}`, "tool:retrieve_products", trace);
      const hits = await retrieveProducts(String(args.query), { topK: 5, category: args.category ? String(args.category) : undefined, gender: state.parsed?.gender });
      agentLog("catalog", `${hits.length}개 검색됨${hits[0] ? `: ${hits[0].name} 외` : ""}`, undefined, trace);
      return JSON.stringify(hits.map((h) => ({ id: h.id, name: h.name, sub: h.subCategory, color: h.color, score: Number(h.score.toFixed(2)) })));
    }
    case "analyze_style": {
      const parsed = state.parsed ?? (await parseRequest(state.keyword, trace));
      state.parsed = parsed;
      const catalog = state.catalog ? { total: state.catalog.total, byCategory: state.catalog.byCategory, embedModel: "" } : null;
      const trend = await synthesizeTrend(state.keyword, parsed, state.weather, catalog, trace, args.extra_context ? `에이전트 추가 판단: ${args.extra_context}` : "");
      state.trend = trend;
      emitState({ trend });
      return trend.slice(0, 1200);
    }
    case "run_styling_loop": {
      if (!state.trend) return "오류: analyze_style 을 먼저 호출해 분석문을 만들어야 한다.";
      const plan = await runStylingLoop(state.keyword, state.trend, state.parsed, trace);
      state.plan = plan;
      state.finalIds = plan.finalConcepts.map((c) => c.id);
      state.looks = {};
      for (const c of plan.repairedCandidates) {
        const ev = plan.round2.find((e) => e.id === c.id);
        state.looks[c.id] = { concept: c, lastScore: ev?.totalScore };
      }
      emitState({ plan, finalIds: state.finalIds, looks: state.looks });
      return JSON.stringify({
        iterations: plan.iterations,
        passScore: plan.passScore,
        rounds: plan.rounds.map((r) => ({ round: r.round, minScore: r.minScore, passed: r.passed })),
        finals: plan.finalConcepts.map((c) => ({ id: c.id, name: c.name, outfitItems: c.outfitItems })),
      });
    }
    case "render_lookbook": {
      const look = state.looks[String(args.concept_id)];
      if (!look) return `오류: 알 수 없는 concept_id ${args.concept_id}. 가능한 id: ${Object.keys(state.looks).join(", ")}`;
      const lookbook = await renderLookbook(look.concept as unknown as Record<string, unknown>, trace);
      look.lookbook = lookbook;
      emitState({ looks: { [look.concept.id]: look } });
      return JSON.stringify({ id: look.concept.id, generated: Boolean(lookbook.imageUrl), verified: lookbook.verified, mismatches: lookbook.mismatches, error: lookbook.error });
    }
    case "match_products": {
      const look = state.looks[String(args.concept_id)];
      if (!look) return `오류: 알 수 없는 concept_id ${args.concept_id}`;
      const links = await matchProducts(state.keyword, look.concept as unknown as Record<string, unknown>, trace);
      look.links = links;
      emitState({ looks: { [look.concept.id]: look } });
      return JSON.stringify({ id: look.concept.id, matched: links.length, items: links.map((l) => `${l.item} → ${l.title}`) });
    }
    case "revise_look": {
      const look = state.looks[String(args.concept_id)];
      if (!look) return `오류: 알 수 없는 concept_id ${args.concept_id}`;
      agentLog("concept", `룩 수정: ${look.concept.name} — ${args.instruction}`, `chat.completions · ${PLANNER_MODEL}`, trace);
      const out = await chatJson<Record<string, unknown>>(PLANNER_MODEL, [
        { role: "system", content: "너는 퍼스널 스타일리스트다. 지시대로 룩을 수정하되 무드의 일관성은 유지한다. 한국어(일본어·한자 금지), JSON 만 출력." },
        {
          role: "user",
          content: `현재 룩:
${JSON.stringify(look.concept)}

수정 지시: ${args.instruction}
분석 맥락: ${state.trend?.slice(0, 600) ?? ""}

바뀐 필드만 담은 평평한 JSON 을 출력해 (아래 키만 사용, 바뀌지 않은 키는 생략):
{"name": string, "description": string, "mood": string, "colorPalette": string[], "materials": string[], "outfitItems": string[] (전체 목록을 다시 적되 "카테고리: 아이템" 형식, 바꾼 아이템 반영), "fitStrategy": string, "stylingReason": string}`,
        },
      ], { temperature: 0.4, maxTokens: 2500, label: "룩 수정", onFallback: fallbackLogger("concept", trace) });
      const patchSource = (out.concept && typeof out.concept === "object" ? (out.concept as Record<string, unknown>) : out);
      const merged = { ...look.concept, ...patchSource, id: look.concept.id };
      const [revised] = normalizeConcepts([merged], state.parsed?.gender ?? "남성");
      if (!revised || revised.outfitItems.length < 2) return "오류: 수정 결과가 불완전해 원래 룩을 유지했다. 지시를 더 구체적으로 바꿔 다시 시도하라.";
      revised.id = look.concept.id;
      const [ev] = rankEvaluations(await judgeCandidates([revised], state.keyword, state.trend ?? "", state.parsed, 1, trace));
      look.concept = revised;
      look.lastScore = ev?.totalScore;
      look.lookbook = undefined;
      look.links = undefined;
      emitState({ looks: { [revised.id]: look } });
      return JSON.stringify({ id: revised.id, outfitItems: revised.outfitItems, score: ev?.totalScore, failureReasons: ev?.failureReasons?.slice(0, 2) });
    }
    default:
      return `오류: 알 수 없는 도구 ${name}`;
  }
}
