import { NextResponse } from "next/server";
import {
  OPENAI_SERVICE_TIER,
  PLAN_MODEL,
  openai,
  parseJsonObjectFromText,
} from "@/lib/openai";
import { agentLog } from "@/lib/log";
import { conceptSimilarity, describeSimilarity } from "@/lib/similarity";

type Concept = {
  id: string;
  name: string;
  description: string;
  mood: string;
  colorPalette: string[];
  targetCustomer: string;
  materials: string[];
  outfitItems: string[];
  bodyProfile: string;
  fitStrategy: string;
  stylingReason: string;
};

type Evaluation = {
  id: string;
  name: string;
  weatherScore: number;
  placeScore: number;
  bodyFitScore: number;
  trendScore: number;
  practicalityScore: number;
  totalScore: number;
  failureReasons: string[];
  revisionPlan: string[];
  rank?: number;
  decisionStatus?: "선택" | "탈락";
  decisionReason?: string;
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toNumber(value: unknown, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function toStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function normalizeConcepts(value: unknown, fallbackConcepts: Concept[] = []) {
  return asArray<Record<string, unknown>>(value)
    .slice(0, 5)
    .map((item, index): Concept => ({
      id: fallbackConcepts[index]?.id ?? String(item.id ?? `look_${String(index + 1).padStart(2, "0")}`),
      name: String(item.name ?? `후보 ${index + 1}`),
      description: String(item.description ?? ""),
      mood: String(item.mood ?? ""),
      colorPalette: toStringArray(item.colorPalette),
      targetCustomer: String(item.targetCustomer ?? "남성"),
      materials: toStringArray(item.materials),
      outfitItems: toStringArray(item.outfitItems),
      bodyProfile: String(item.bodyProfile ?? ""),
      fitStrategy: String(item.fitStrategy ?? ""),
      stylingReason: String(item.stylingReason ?? ""),
    }));
}

function normalizeEvaluations(value: unknown, concepts: Concept[]) {
  const conceptsById = new Map(concepts.map((concept) => [concept.id, concept]));
  const conceptsByName = new Map(concepts.map((concept) => [concept.name, concept]));

  return asArray<Record<string, unknown>>(value).map((item, index): Evaluation => {
    const matchedConcept =
      conceptsById.get(String(item.id ?? "")) ??
      conceptsByName.get(String(item.name ?? "")) ??
      concepts[index];
    const criteria = item.criteria && typeof item.criteria === "object"
      ? (item.criteria as Record<string, unknown>)
      : {};
    const weatherScore = toNumber(item.weatherScore ?? criteria.weatherScore ?? criteria.weather);
    const placeScore = toNumber(item.placeScore ?? criteria.placeScore ?? criteria.place);
    const bodyFitScore = toNumber(item.bodyFitScore ?? criteria.bodyFitScore ?? criteria.bodyFit);
    const trendScore = toNumber(item.trendScore ?? criteria.trendScore ?? criteria.trend);
    const practicalityScore = toNumber(
      item.practicalityScore ?? criteria.practicalityScore ?? criteria.practicality,
    );
    const computedTotal = Math.round(
      (weatherScore + placeScore + bodyFitScore + trendScore + practicalityScore) / 5,
    );

    return {
      id: matchedConcept?.id ?? String(item.id ?? `look_${String(index + 1).padStart(2, "0")}`),
      name: matchedConcept?.name ?? String(item.name ?? `후보 ${index + 1}`),
      weatherScore,
      placeScore,
      bodyFitScore,
      trendScore,
      practicalityScore,
      totalScore: toNumber(item.totalScore, computedTotal),
      failureReasons: toStringArray(item.failureReasons),
      revisionPlan: toStringArray(item.revisionPlan),
      rank: item.rank === undefined ? undefined : toNumber(item.rank),
      decisionStatus: item.decisionStatus === "선택" ? "선택" : item.decisionStatus === "탈락" ? "탈락" : undefined,
      decisionReason: typeof item.decisionReason === "string" ? item.decisionReason : undefined,
    };
  });
}

const SIMILARITY_LIMIT = 0.45;   // 이 이상이면 '같은 룩'으로 간주해 배제
const DIVERSITY_LAMBDA = 60;     // 임계 통과 후보가 없을 때 점수에서 깎는 계수

/**
 * 1안은 최고점, 2안은 '1안과 충분히 다른 것 중 최고점'을 고른다.
 * 총점만으로 자르면 평가 기준이 같은 정답을 향하므로 두 안이 닮는다.
 */
function selectFallbackFinal(concepts: Concept[], evaluations: Evaluation[]) {
  const scoreById = new Map(evaluations.map((item) => [item.id, item.totalScore]));
  const ranked = [...concepts].sort(
    (a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0),
  );
  if (ranked.length < 2) return ranked.slice(0, 2);

  const first = ranked[0];
  const rest = ranked.slice(1).map((c) => ({
    concept: c,
    score: scoreById.get(c.id) ?? 0,
    sim: conceptSimilarity(first, c),
  }));

  const distinct = rest.filter((r) => r.sim <= SIMILARITY_LIMIT);
  const pool = distinct.length ? distinct : rest;
  const second = [...pool].sort(
    (a, b) => b.score - DIVERSITY_LAMBDA * b.sim - (a.score - DIVERSITY_LAMBDA * a.sim),
  )[0];

  agentLog(
    "evaluate",
    distinct.length
      ? `2안 다양성 확보: "${second.concept.name}" (1안과 유사도 ${second.sim} · ${describeSimilarity(second.sim)})`
      : `⚠ 모든 후보가 1안과 유사(최소 ${Math.min(...rest.map((r) => r.sim))}). ` +
        `유사도 페널티를 적용해 "${second.concept.name}" 선택`,
  );

  return [first, second.concept];
}

function rankEvaluations(evaluations: Evaluation[]) {
  return [...evaluations]
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (b.trendScore !== a.trendScore) return b.trendScore - a.trendScore;
      if (b.bodyFitScore !== a.bodyFitScore) return b.bodyFitScore - a.bodyFitScore;
      if (b.weatherScore !== a.weatherScore) return b.weatherScore - a.weatherScore;
      return a.name.localeCompare(b.name, "ko");
    })
    .map((item, index) => ({
      ...item,
      rank: index + 1,
    }));
}

function rankRound1Evaluations(evaluations: Evaluation[]) {
  return rankEvaluations(evaluations).map((item) => ({
    ...item,
    decisionStatus: undefined,
    decisionReason: undefined,
  }));
}

function applyFinalDecisions(evaluations: Evaluation[], finalConcepts: Concept[]) {
  const finalIds = new Set(finalConcepts.map((concept) => concept.id));
  return rankEvaluations(evaluations).map((item) => {
    const selected = finalIds.has(item.id);
    const fallbackDecision = selected
      ? `${item.rank}위, 재평가 총점 ${item.totalScore}점으로 상위 2개 안에 들어 최종 룩북 후보로 선택됐어요.`
      : `${item.rank}위, 재평가 총점 ${item.totalScore}점으로 상위 2개보다 낮아 최종 룩북에서는 제외됐어요.`;
    return {
      ...item,
      decisionStatus: selected ? "선택" : "탈락",
      decisionReason: item.decisionReason?.trim()
        ? `${item.rank}위 · ${item.decisionReason}`
        : fallbackDecision,
    } satisfies Evaluation;
  });
}

export async function POST(req: Request) {
  try {
    const { keyword, trend } = await req.json();

    agentLog(
      "concept",
      `"${keyword}" 통합 후보 생성·평가·수정·재평가 시작`,
      `responses.create · ${PLAN_MODEL} · ${OPENAI_SERVICE_TIER}`,
    );

    const response = await openai.responses.create({
      model: PLAN_MODEL,
      service_tier: OPENAI_SERVICE_TIER,
      input: `너는 소비자 개인화 퍼스널 스타일링 에이전트이자 QA 평가자야.
사용자 요청과 트렌드/날씨/장소 분석을 바탕으로 아래 전체 과정을 한 번에 수행해.

과정:
1. 서로 다른 무드/핏/아이템 조합의 착장 후보를 정확히 5개 생성한다.
2. 5개 후보를 1차 평가한다.
3. 실패 원인을 바탕으로 후보 5개를 모두 수정한다.
4. 수정 후보를 재평가한다.
5. 재평가 총점 기준 최종 룩북 2안을 선택한다.

생성 규칙:
- 모든 출력 텍스트는 반드시 한국어.
- 사용자가 성별을 말하지 않았다면 남성 코디가 기본값.
- 날짜와 장소의 날씨/계절감, 장소 무드, 상황의 포멀리티를 반영.
- 키와 몸무게가 있으면 bodyProfile에 원 숫자(예: 175cm, 70kg)를 그대로 포함하고 현실적인 체형 인상을 적는다.
- 핏은 체형 + 무드 + 트렌드 적합성을 함께 고려한다.
- 원단(materials)은 원가 계산용이 아니라 옷 추천과 이미지 질감 표현용이다.
- outfitItems에는 실제 착용한 모든 제품을 카테고리와 함께 최대한 구체적으로 넣는다.
- 예: "모자: 블랙 볼캡", "상의(이너): 화이트 코튼 티셔츠", "상의(아우터): 네이비 세미오버 블레이저", "상의(레이어드): 라이트그레이 니트 베스트", "하의: 차콜 와이드 슬랙스", "신발: 블랙 레더 로퍼", "악세사리: 실버 체인 목걸이".
- 없는 카테고리는 억지로 만들지 말되, 룩북 이미지에 착용될 아이템은 빠짐없이 포함한다.
- 후보들은 색상만 다른 수준이 아니라 무드/아이템/핏/소재가 명확히 달라야 한다.
- 5개 후보는 아래 아키타입을 하나씩 맡는다. 중복 금지.
  look_01 미니멀/클린   look_02 아메카지·워크웨어   look_03 스포티·애슬레저
  look_04 클래식·세미포멀   look_05 스트릿·캐주얼
- 상황·날씨에 부적합한 아키타입이라면 억지로 맞추지 말고, 그 아키타입 안에서 상황에 맞는 변형을 찾아라.
- 5개 후보는 서로의 유사도를 의도적으로 낮춘다. 아래 축 중 최소 4개 이상이 후보마다 달라야 한다: 대표 무드, 주 아이템, 실루엣/핏, 색상 팔레트, 소재/질감, 신발 유형, 레이어링 방식, 포멀리티.
- 5개 후보의 '상의(아우터)' 카테고리는 서로 달라야 한다. 없는 후보가 있어도 되지만 같은 아이템이 2개 이상 겹치면 안 된다.
- 5개 후보의 '하의' 실루엣도 서로 달라야 한다. 예: 와이드, 스트레이트, 테이퍼드, 반바지 등.
- 동일한 주 아이템 조합을 반복하지 마. 예를 들어 5개 후보가 모두 "블레이저+슬랙스+로퍼"이거나 모두 "셔츠+데님+스니커즈"이면 실패다.
- 색상만 바꾼 후보, 같은 아우터만 바꾼 후보, 같은 하의/신발을 반복하는 후보는 만들지 마.
- 각 후보의 stylingReason에는 "다른 후보와 차별화되는 핵심 포인트"를 한 문장 포함한다.
- 수정 후보(repairedCandidates)는 원 후보와 같은 순서, 같은 id를 반드시 유지한다.

수정 규칙:
- 각 후보의 아키타입과 핵심 실루엣은 유지한다. 실패 원인만 고친다.
- 후보를 수정할 때도 다양성을 좁히지 마. 실패 원인을 고치더라도 5개 후보가 서로 다른 무드/실루엣/아이템 구성을 유지해야 한다.
- 수정 결과가 다른 후보와 비슷해지면 안 된다. 다양성이 우선이다.

평가 규칙:
- 점수 필드명은 weatherScore, placeScore, bodyFitScore, trendScore, practicalityScore, totalScore.
- 각 점수는 0~100 정수이며 0을 기본값으로 쓰지 않는다.
- totalScore는 다섯 점수 평균에 가깝게 계산한다.
- failureReasons에는 무엇이 왜 문제인지 후보별 2~3개 이상 구체적으로 쓴다.
- revisionPlan에는 바꿔야 할 아이템/소재/색/기장/핏을 명확히 쓴다.
- 재평가에는 rank, decisionStatus("선택"|"탈락"), decisionReason을 포함한다.
- 선택된 2개는 왜 상위 2개인지, 탈락 후보는 어떤 기준에서 밀렸는지 점수와 이유를 포함한다.

사용자 요청:
${keyword}

트렌드/날씨/장소 분석:
${trend}

반드시 JSON만 반환해. 마크다운 금지.
JSON 스키마:
{
  "originalCandidates": Concept[],
  "round1": Evaluation[],
  "repairSummary": string[],
  "repairedCandidates": Concept[],
  "round2": Evaluation[],
  "finalConcepts": Concept[]
}

Concept 필드:
id("look_01" 형식), name, description, mood, colorPalette(string[]), targetCustomer, materials(string[]), outfitItems(string[]), bodyProfile, fitStrategy, stylingReason

Evaluation 필드:
id, name, weatherScore, placeScore, bodyFitScore, trendScore, practicalityScore, totalScore, failureReasons(string[]), revisionPlan(string[]), rank, decisionStatus, decisionReason`,
    });

    const parsed = parseJsonObjectFromText(response.output_text) as Record<string, unknown>;
    const originalCandidates = normalizeConcepts(parsed.originalCandidates);
    const repairedCandidates = normalizeConcepts(parsed.repairedCandidates, originalCandidates);
    const candidateBase = repairedCandidates.length ? repairedCandidates : originalCandidates;
    const round1 = rankRound1Evaluations(normalizeEvaluations(parsed.round1, originalCandidates));
    const normalizedRound2 = normalizeEvaluations(parsed.round2, candidateBase);
    const finalConcepts = selectFallbackFinal(candidateBase, normalizedRound2);
    const round2 = applyFinalDecisions(normalizedRound2, finalConcepts);

    if (originalCandidates.length < 5 || candidateBase.length < 5 || finalConcepts.length < 2) {
      throw new Error("통합 스타일링 계획 생성에 실패했어요.");
    }

    agentLog(
      "evaluate",
      `통합 계획 완료: 최종 ${finalConcepts.map((item) => item.name).join(" / ")}`,
    );

    const finalSimilarity =
      finalConcepts.length === 2 ? conceptSimilarity(finalConcepts[0], finalConcepts[1]) : 0;

    return NextResponse.json({
      originalCandidates,
      round1,
      repairSummary: toStringArray(parsed.repairSummary),
      repairedCandidates: candidateBase,
      round2,
      finalConcepts,
      finalSimilarity,
      finalSimilarityLabel: describeSimilarity(finalSimilarity),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "통합 스타일링 계획 중 알 수 없는 오류";
    agentLog("evaluate", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
