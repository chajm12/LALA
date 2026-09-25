import { chatJson, JUDGE_MODEL, PLANNER_MODEL } from "@/lib/nim";
import { agentLog, fallbackLogger, type TraceEvent } from "@/lib/log";
import {
  applyFinalDecisions,
  normalizeConcepts,
  normalizeEvaluations,
  rankEvaluations,
  type Concept,
  type Evaluation,
  type ParsedRequest,
} from "@/lib/styling";

/**
 * 생성(PLANNER) → 평가(JUDGE, 별도 모델) → 수정(PLANNER) → 재평가 … 를 실제로 반복하는 루프.
 *
 * - 한 프롬프트에 "평가한 척" 하지 않는다. 생성자와 평가자는 다른 모델·다른 호출이다.
 * - 종료 조건: 모든 후보 총점 ≥ PASS_SCORE 이거나 MAX_ROUNDS 도달.
 * - 프론트 계약(originalCandidates/round1/repairSummary/repairedCandidates/round2/finalConcepts)은 유지하고
 *   rounds(전체 이력)·iterations·trace 를 추가로 돌려준다.
 */
const MAX_ROUNDS = Number(process.env.PLAN_MAX_ROUNDS ?? 2);
const PASS_SCORE = Number(process.env.PLAN_PASS_SCORE ?? 80);

const CONCEPT_SCHEMA = `Concept 필드:
id("look_01" 형식, 수정 시에도 id 유지), name, description, mood, colorPalette(string[]), targetCustomer, materials(string[]),
outfitItems(string[] — "카테고리: 아이템" 형식, 예: "상의(이너): 화이트 코튼 티셔츠", "상의(아우터): 네이비 블레이저", "하의: 차콜 와이드 슬랙스", "신발: 블랙 레더 로퍼"),
bodyProfile(키·몸무게 원 숫자 포함), fitStrategy, stylingReason`;

async function generateCandidates(keyword: string, trend: string, parsed: ParsedRequest | null, trace: TraceEvent[]) {
  agentLog("concept", "무드/핏/소재가 서로 다른 착장 후보 5개 생성", `chat.completions · ${PLANNER_MODEL}`, trace);
  const out = await chatJson<{ candidates: unknown }>(PLANNER_MODEL, [
    { role: "system", content: "너는 퍼스널 스타일리스트다. 모든 텍스트는 한국어(필요 시 영문 브랜드/소재명만 허용, 일본어·한자 금지). JSON 만 출력." },
    {
      role: "user",
      content: `사용자 요청: ${keyword}
구조화 해석: ${JSON.stringify(parsed)}
분석 결과:
${trend}

규칙:
- 서로 다른 무드/핏/아이템 조합의 착장 후보를 정확히 5개 생성 (색만 다른 수준 금지).
- 성별 기본값 남성. 날씨 수치·장소 무드·상황 포멀리티를 반드시 반영.
- 키/몸무게가 있으면 bodyProfile 에 원 숫자를 그대로 쓰고 현실적인 체형 인상을 적는다.
- outfitItems 에는 룩북에 착용될 모든 아이템을 카테고리와 함께 빠짐없이.
- 사용자 제약(${parsed?.constraints.join(", ") || "없음"})을 위반하지 않는다.

${CONCEPT_SCHEMA}

출력: {"candidates": Concept[]}`,
    },
  ], { temperature: 0.8, maxTokens: 4500, label: "후보 생성", onFallback: fallbackLogger("concept", trace) });
  return normalizeConcepts(out.candidates, parsed?.gender);
}

export async function judgeCandidates(candidates: Concept[], keyword: string, trend: string, parsed: ParsedRequest | null, round: number, trace: TraceEvent[]) {
  agentLog("evaluate", `${round}차 평가: 날씨·장소·체형/핏·트렌드·실용성 5개 축 채점`, `chat.completions · ${JUDGE_MODEL}`, trace);
  const out = await chatJson<{ evaluations: unknown }>(JUDGE_MODEL, [
    {
      role: "system",
      content: "너는 까다로운 QA 평가자다. 생성자와 다른 모델이며 후보를 옹호하지 않는다. 문제가 없어 보여도 개선점을 찾는다. 한국어(일본어·한자 금지), JSON 만 출력.",
    },
    {
      role: "user",
      content: `사용자 요청: ${keyword}
구조화 해석: ${JSON.stringify(parsed)}
분석 결과(날씨 수치 포함):
${trend}

평가할 후보:
${JSON.stringify(candidates)}

채점 규칙:
- weatherScore, placeScore, bodyFitScore, trendScore, practicalityScore 각 0~100 정수. 0 을 기본값으로 쓰지 않는다.
- 날씨 수치와 명백히 충돌(비 오는데 스웨이드, 30도인데 울 코트)하면 weatherScore 60 이하.
- 상황 포멀리티 불일치(결혼식에 반바지)면 placeScore 50 이하.
- 사용자 제약 위반이면 practicalityScore 50 이하.
- failureReasons: 후보별 2~3개, "무엇이 왜 문제"인지 구체적으로.
- revisionPlan: 바꿔야 할 아이템/소재/색/기장/핏을 명령형으로.
- decisionReason: 한 줄 총평.

출력: {"evaluations": [{id, name, weatherScore, placeScore, bodyFitScore, trendScore, practicalityScore, failureReasons[], revisionPlan[], decisionReason}]}`,
    },
  ], { temperature: 0.2, maxTokens: 4000, label: `${round}차 평가`, primaryTimeoutMs: 30_000, onFallback: fallbackLogger("evaluate", trace) });
  return normalizeEvaluations(out.evaluations, candidates);
}

async function repairCandidates(candidates: Concept[], evaluations: Evaluation[], parsed: ParsedRequest | null, round: number, trace: TraceEvent[]) {
  const failing = evaluations.filter((e) => e.totalScore < PASS_SCORE).map((e) => `${e.id} ${e.name}`);
  agentLog("concept", `${round}차 수정: 기준 미달 ${failing.length}개 (${failing.join(", ")}) 평가 피드백 반영`, `chat.completions · ${PLANNER_MODEL}`, trace);
  const out = await chatJson<{ repairedCandidates: unknown; repairSummary: unknown }>(PLANNER_MODEL, [
    { role: "system", content: "너는 퍼스널 스타일리스트다. 평가자의 피드백을 반영해 후보를 실제로 바꾼다. \"원안 유지\"는 통과 후보에만 허용된다. 한국어(일본어·한자 금지), JSON 만 출력." },
    {
      role: "user",
      content: `후보:
${JSON.stringify(candidates)}

평가자 피드백 (failureReasons / revisionPlan 을 반드시 반영):
${JSON.stringify(evaluations.map(({ id, name, totalScore, failureReasons, revisionPlan }) => ({ id, name, totalScore, failureReasons, revisionPlan })))}

규칙:
- 5개 모두 돌려주되 id 는 유지.
- 총점 ${PASS_SCORE} 미만 후보(${failing.join(", ") || "없음"})는 failureReasons 각각에 대응하는 아이템/소재/색/기장 교체를 outfitItems 와 materials 에 실제로 반영해야 한다. "유지", "사용자 판단에 맡김", "허용 범위로 판단" 같은 회피 표현 금지.
- 총점 ${PASS_SCORE} 이상 후보는 failureReasons 중 가장 심각한 1개만 고치고 나머지는 유지해도 된다.
- 후보 간 다양성(무드/핏/소재 차이)은 유지.
- 사용자 제약(${parsed?.constraints.join(", ") || "없음"}) 준수.

${CONCEPT_SCHEMA}

출력: {"repairedCandidates": Concept[], "repairSummary": ["후보명: 무엇을 왜 바꿨는지 한 줄" ...]}`,
    },
  ], { temperature: 0.6, maxTokens: 4500, label: `${round}차 수정`, onFallback: fallbackLogger("concept", trace) });
  const repaired = normalizeConcepts(out.repairedCandidates, parsed?.gender);
  const summary = Array.isArray(out.repairSummary) ? out.repairSummary.map(String) : [];
  return { repaired: repaired.length === candidates.length ? repaired : candidates, summary };
}

export type StylingLoopResult = {
  originalCandidates: Concept[];
  round1: Evaluation[];
  repairSummary: string[];
  repairedCandidates: Concept[];
  round2: Evaluation[];
  finalConcepts: Concept[];
  rounds: { round: number; evaluations: Evaluation[]; repairSummary: string[]; minScore: number; passed: boolean }[];
  iterations: number;
  passScore: number;
};

/** 생성 → 평가 → 수정 반복 루프. 라우트와 에이전트가 공유. */
export async function runStylingLoop(keyword: string, trend: string, parsed: ParsedRequest | null, trace: TraceEvent[]): Promise<StylingLoopResult> {
    agentLog("agent", `계획 루프 시작 (통과 기준 ${PASS_SCORE}점, 최대 ${MAX_ROUNDS}라운드)`, undefined, trace);

    const originalCandidates = await generateCandidates(keyword, trend, parsed, trace);
    if (originalCandidates.length < 5) throw new Error("후보 생성에 실패했어요 (5개 미만).");

    let candidates = originalCandidates;
    const rounds: { round: number; evaluations: Evaluation[]; repairSummary: string[]; minScore: number; passed: boolean }[] = [];
    const repairSummaryAll: string[] = [];
    let round1: Evaluation[] = [];
    let lastEval: Evaluation[] = [];

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const evaluations = rankEvaluations(await judgeCandidates(candidates, keyword, trend, parsed, round, trace));
      if (round === 1) round1 = evaluations.map((e) => ({ ...e, decisionStatus: undefined, decisionReason: undefined }));
      lastEval = evaluations;

      const minScore = Math.min(...evaluations.map((e) => e.totalScore));
      const passed = evaluations.every((e) => e.totalScore >= PASS_SCORE);
      agentLog("evaluate", `${round}차 결과: 최저 ${minScore}점 / 최고 ${Math.max(...evaluations.map((e) => e.totalScore))}점 → ${passed ? "기준 통과" : "기준 미달"}`, undefined, trace);

      if (passed || round === MAX_ROUNDS) {
        rounds.push({ round, evaluations, repairSummary: [], minScore, passed });
        if (!passed) agentLog("agent", `최대 라운드 도달, 현재 최고 후보로 진행`, undefined, trace);
        break;
      }

      const { repaired, summary } = await repairCandidates(candidates, evaluations, parsed, round, trace);
      rounds.push({ round, evaluations, repairSummary: summary, minScore, passed });
      repairSummaryAll.push(...summary.map((s) => `[${round}차] ${s}`));
      candidates = repaired;
    }

    const finalIds = new Set(rankEvaluations(lastEval).slice(0, 2).map((e) => e.id));
    const finalConcepts = candidates.filter((c) => finalIds.has(c.id));
    const round2 = applyFinalDecisions(lastEval, finalIds);
    if (finalConcepts.length < 2) throw new Error("최종 후보 선정에 실패했어요.");

    agentLog("agent", `루프 종료: ${rounds.length}회 평가, 최종 ${finalConcepts.map((c) => c.name).join(" / ")}`, undefined, trace);

    return {
      originalCandidates,
      round1,
      repairSummary: repairSummaryAll,
      repairedCandidates: candidates,
      round2,
      finalConcepts,
      rounds,
      iterations: rounds.length,
      passScore: PASS_SCORE,
    };
}
