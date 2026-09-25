import type { ParsedRequest, Concept } from "@/lib/styling";
import type { WeatherReport } from "@/lib/tools/weather";
import type { StylingLoopResult } from "@/lib/pipeline/loop";
import type { LookbookResult } from "@/lib/pipeline/lookbook";
import type { ShoppingLink } from "@/lib/pipeline/shopping";

/** 에이전트가 대화 전체에 걸쳐 유지하는 작업 상태. 클라이언트가 그대로 돌려보내 후속 요청에 이어 쓴다. */
export type Look = {
  concept: Concept;
  lookbook?: LookbookResult;
  links?: ShoppingLink[];
  lastScore?: number;
};

export type AgentState = {
  keyword: string;
  parsed: ParsedRequest | null;
  weather: WeatherReport | null;
  catalog: { total: number; byCategory: Record<string, number> } | null;
  trend: string | null;
  plan: StylingLoopResult | null;
  looks: Record<string, Look>;
  finalIds: string[];
};

export function emptyState(keyword: string): AgentState {
  return { keyword, parsed: null, weather: null, catalog: null, trend: null, plan: null, looks: {}, finalIds: [] };
}

/** 클라이언트로 보낼 때 이미지(data URL)는 빼서 페이로드를 줄인다. 이미지는 클라이언트가 이미 받아 갖고 있다. */
export function serializeState(state: AgentState): AgentState {
  const looks: Record<string, Look> = {};
  for (const [id, look] of Object.entries(state.looks)) {
    looks[id] = look.lookbook ? { ...look, lookbook: { ...look.lookbook, imageUrl: look.lookbook.imageUrl ? "(client)" : null } } : look;
  }
  return { ...state, looks };
}

/** LLM 에게 보여줄 압축 요약 (토큰 절약) */
export function summarizeState(state: AgentState) {
  const looks = Object.values(state.looks).map((l) => ({
    id: l.concept.id,
    name: l.concept.name,
    final: state.finalIds.includes(l.concept.id),
    outfitItems: l.concept.outfitItems,
    lookbook: l.lookbook ? (l.lookbook.imageUrl ? (l.lookbook.verified ? "생성·검증됨" : "생성됨(미검증)") : "실패") : "없음",
    products: l.links ? `${l.links.length}개 매칭` : "없음",
    lastScore: l.lastScore,
  }));
  return {
    keyword: state.keyword,
    parsed: state.parsed,
    weather: state.weather ? state.weather.summary : null,
    catalog: state.catalog,
    trend: state.trend ? `${state.trend.slice(0, 300)}…` : null,
    plan: state.plan ? { iterations: state.plan.iterations, passScore: state.plan.passScore, finalIds: state.finalIds } : null,
    looks,
  };
}
