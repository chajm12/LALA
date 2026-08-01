import { NextResponse } from "next/server";
import { openai, parseJsonContent, TEXT_MODEL } from "@/lib/openai";
import { agentLog } from "@/lib/log";

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

function toNumber(value: unknown, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function toStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function normalizeEvaluations(raw: unknown, candidates: Concept[]): Evaluation[] {
  if (!Array.isArray(raw)) return [];
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const candidatesByName = new Map(candidates.map((candidate) => [candidate.name, candidate]));

  return raw.map((value, index) => {
    const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const matchedConcept =
      candidatesById.get(String(item.id ?? "")) ??
      candidatesByName.get(String(item.name ?? "")) ??
      candidates[index];

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
    };
  });
}

async function evaluateRound(keyword: string, trend: string, candidates: Concept[], round: 1 | 2) {
  const completion = await openai.chat.completions.create({
    model: TEXT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 퍼스널 스타일링 QA 평가자야. 모든 출력은 반드시 한국어로 작성해. 후보 착장을 날씨/계절, 장소/상황 무드, 성별·키·몸무게 기반 체형 적합 핏, 트렌드 적합성, 실용성 기준으로 평가해. 모든 후보에 대해 id는 입력 후보의 id를 그대로 쓰고, name은 입력 후보의 name을 그대로 써. 점수 필드명은 반드시 weatherScore, placeScore, bodyFitScore, trendScore, practicalityScore, totalScore로 써. 각 점수는 0~100 정수이며 0을 기본값으로 쓰지 마. totalScore는 다섯 점수의 평균에 가깝게 계산해. failureReasons에는 '무엇이 왜 문제인지'를 후보별로 2~3개 이상 구체적으로 써. 예: '비 예보가 있는데 스웨이드 신발이라 젖음/오염 위험이 큼', '결혼식 하객룩인데 후드가 포함되어 포멀리티가 낮음'. revisionPlan에는 바꿔야 할 아이템/소재/색/기장/핏을 명확히 써. 2라운드에서는 수정 후에도 남은 약점과 강점을 비교해서 totalScore를 매겨. JSON 스키마: { evaluations: [{ id, name, weatherScore, placeScore, bodyFitScore, trendScore, practicalityScore, totalScore, failureReasons, revisionPlan }] }.",
      },
      {
        role: "user",
        content: `평가 라운드: ${round}\n사용자 요청: ${keyword}\n트렌드/날씨/장소 분석:\n${trend}\n\n후보:\n${JSON.stringify(candidates, null, 2)}`,
      },
    ],
  });
  const parsed = parseJsonContent(completion.choices[0].message.content);
  return normalizeEvaluations(parsed.evaluations, candidates);
}

async function repairCandidates(
  keyword: string,
  trend: string,
  candidates: Concept[],
  evaluations: Evaluation[],
) {
  const completion = await openai.chat.completions.create({
    model: TEXT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 퍼스널 스타일링 수정 에이전트야. 모든 출력은 반드시 한국어로 작성해. 후보 개수와 id는 유지하되, 평가 실패 원인과 수정 계획을 반영해 각 후보의 아이템, 소재, 색감, 기장, 핏을 보정해. 최종 룩북 이미지는 상위 2개만 생성되지만, 여기서는 모든 후보를 수정한다. 트렌드 감도는 유지하되 날씨/장소/상황/체형과 충돌하면 조정한다. repairSummary에는 후보별로 어떤 실패 원인을 어떻게 고쳤는지 구체적으로 써. JSON 스키마: { repairSummary: string[], concepts: Concept[] }.",
      },
      {
        role: "user",
        content: `사용자 요청: ${keyword}\n트렌드/날씨/장소 분석:\n${trend}\n\n원 후보:\n${JSON.stringify(candidates, null, 2)}\n\n1차 평가:\n${JSON.stringify(evaluations, null, 2)}`,
      },
    ],
  });
  const parsed = parseJsonContent(completion.choices[0].message.content);
  return {
    repairSummary: Array.isArray(parsed.repairSummary) ? (parsed.repairSummary as string[]) : [],
    concepts: Array.isArray(parsed.concepts) ? (parsed.concepts as Concept[]) : candidates,
  };
}

function selectFinal(repaired: Concept[], evaluations: Evaluation[]) {
  const byId = new Map(evaluations.map((item) => [item.id, item]));
  return [...repaired]
    .sort((a, b) => (byId.get(b.id)?.totalScore ?? 0) - (byId.get(a.id)?.totalScore ?? 0))
    .slice(0, 2);
}

async function explainFinalSelection(
  keyword: string,
  trend: string,
  concepts: Concept[],
  evaluations: Evaluation[],
) {
  const finalIds = new Set(selectFinal(concepts, evaluations).map((item) => item.id));
  const ranked = [...evaluations].sort((a, b) => b.totalScore - a.totalScore);
  const completion = await openai.chat.completions.create({
    model: TEXT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 퍼스널 스타일링 심사위원이야. 모든 출력은 반드시 한국어로 작성해. 재평가 점수를 바탕으로 각 후보가 최종 2안에 선택 또는 탈락한 이유를 사용자가 납득할 수 있게 설명해. 선택된 후보는 왜 상위 2개인지, 탈락 후보는 어떤 기준에서 밀렸는지 점수와 핵심 이유를 포함해. JSON 스키마: { decisions: [{ id, rank, decisionStatus('선택'|'탈락'), decisionReason }] }.",
      },
      {
        role: "user",
        content: `사용자 요청: ${keyword}\n트렌드/날씨/장소 분석:\n${trend}\n최종 선택 id: ${JSON.stringify([...finalIds])}\n재평가 순위:\n${JSON.stringify(ranked, null, 2)}\n수정 후보:\n${JSON.stringify(concepts, null, 2)}`,
      },
    ],
  });
  const parsed = parseJsonContent(completion.choices[0].message.content);
  return Array.isArray(parsed.decisions) ? (parsed.decisions as Evaluation[]) : [];
}

export async function POST(req: Request) {
  try {
    const { keyword, trend, candidates } = await req.json();
    const concepts: Concept[] = Array.isArray(candidates) ? candidates : [];
    if (concepts.length < 2) {
      throw new Error("평가할 후보가 부족합니다.");
    }

    agentLog("evaluate", `후보 ${concepts.length}개 1차 평가 시작`, `chat.completions · ${TEXT_MODEL}`);
    const round1 = await evaluateRound(keyword, trend, concepts, 1);

    agentLog("evaluate", `실패 원인 기반 후보 수정 시작`, `chat.completions · ${TEXT_MODEL}`);
    const repaired = await repairCandidates(keyword, trend, concepts, round1);

    agentLog("evaluate", `수정 후보 ${repaired.concepts.length}개 재평가 시작`, `chat.completions · ${TEXT_MODEL}`);
    const round2 = await evaluateRound(keyword, trend, repaired.concepts, 2);

    const finalConcepts = selectFinal(repaired.concepts, round2);
    const decisions = await explainFinalSelection(keyword, trend, repaired.concepts, round2);
    const decisionById = new Map(decisions.map((item) => [item.id, item]));
    const rankedRound2 = [...round2]
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((item, index) => {
        const decision = decisionById.get(item.id);
        const isSelected = finalConcepts.some((concept) => concept.id === item.id);
        return {
          ...item,
          rank: decision?.rank ?? index + 1,
          decisionStatus: decision?.decisionStatus ?? (isSelected ? "선택" : "탈락"),
          decisionReason:
            decision?.decisionReason ??
            (isSelected
              ? `재평가 총점 ${item.totalScore}점으로 상위 2개 안에 들어 최종 룩북 후보로 선택됐어요.`
              : `재평가 총점 ${item.totalScore}점으로 상위 2개보다 낮아 최종 룩북에서는 제외됐어요.`),
        };
      });
    agentLog(
      "evaluate",
      `최종 룩북 2안 선택: ${finalConcepts.map((item) => item.name).join(" / ")}`,
    );

    return NextResponse.json({
      originalCandidates: concepts,
      round1,
      repairSummary: repaired.repairSummary,
      repairedCandidates: repaired.concepts,
      round2: rankedRound2,
      finalConcepts,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "후보 평가 중 알 수 없는 오류";
    agentLog("evaluate", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
