"use client";

import { useEffect, useRef, useState } from "react";
import { buildDirectConsultationReply } from "@/lib/consultation-replies";
import LoadingScreen, { type LoadingPhase } from "@/components/LoadingScreen";
import { AGENTKIT_TOOLS, AGENTKIT_TRACE_STEPS } from "@/lib/agentkit";
import { conceptFingerprint, createShoppingRequestRegistry, mergeShoppingProducts, patchMatchingVariant, restoredShoppingState, withShoppingDeadline } from "@/lib/shopping-client";
import { isSpecificProductUrl } from "@/lib/shopping-products";
import { sanitizeCoreConcept, coreGarmentCategory } from "@/lib/garments";
import { normalizeGarmentSpecs, type GarmentSpec } from "@/lib/garment-specs";

type Concept = {
  name: string;
  description: string;
  mood: string;
  colorPalette: string[];
  targetCustomer: string;
  materials: string[];
  id?: string;
  outfitItems?: string[];
  garmentSpecs?: GarmentSpec[];
  bodyProfile?: string;
  fitStrategy?: string;
  stylingReason?: string;
};

type Evaluation = {
  id: string;
  name: string;
  requestScore: number;
  weatherScore: number;
  placeScore: number;
  bodyFitScore: number;
  trendScore: number;
  practicalityScore: number;
  colorScore: number;
  diversityScore: number;
  totalScore: number;
  failureReasons: string[];
  revisionPlan: string[];
  verifierIssues: string[];
  rank?: number;
  decisionStatus?: "선택" | "탈락";
  decisionReason?: string;
};

type EvaluationProcess = {
  planStatus?: "complete" | "partial";
  evaluationStage?: "initial" | "repaired" | "fallback";
  candidateSource?: "model" | "local_fallback";
  warnings?: string[];
  originalCandidates: Concept[];
  round1: Evaluation[];
  repairSummary: string[];
  repairedCandidates: Concept[];
  round2: Evaluation[];
  finalConcepts: Concept[];
};

type ShoppingLink = {
  kind?: "product" | "search";
  category?: string;
  item: string;
  title: string;
  url: string;
  source: string;
  reason: string;
  imageUrl?: string;
  price?: string;
  visualStatus?: "verified" | "unverified";
  visualDifferences?: string[];
  verificationNotice?: string;
};

type Variant = {
  concept: Concept;
  contradictionIssue: string | null;
  imageUrl: string | null;
  lookbookVerified: boolean;
  imageGarmentSpecs: GarmentSpec[];
  lookbookMismatches: string[];
  lookbookRetried: boolean;
  lookbookError: string | null;
  finalMaterials: string[] | null;
  shoppingLinks: ShoppingLink[];
  shoppingError: string | null;
  shoppingMissingItems: string[];
  shoppingLoading: boolean;
};

type Step = "idle" | "trend" | "concept" | "variants" | "done";

type Screen = "search" | "chat" | "candidates" | "final";

type ConversationStage = "place" | "fit" | "material" | "ready";

/** 상담 선택지: 짧은 제목 + 그 선택이 코디에 어떤 의미인지 한 줄 */
type ChatOption = { label: string; detail: string; primary?: boolean };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  stage?: "weather" | "place" | "fit" | "material" | "ready";
  options?: ChatOption[];
  allowQuickApply?: boolean;
};

function toChatOptions(value: unknown): ChatOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): ChatOption | null => {
      if (typeof item === "string" && item.trim()) return { label: item.trim(), detail: "" };
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const label = typeof record.label === "string" ? record.label.trim() : "";
        if (!label) return null;
        return { label, detail: typeof record.detail === "string" ? record.detail.trim() : "", primary: record.primary === true };
      }
      return null;
    })
    .filter((item): item is ChatOption => item !== null)
    .slice(0, 4);
}

/** 에이전트가 추천만 하고 질문이 없을 때: '그대로 진행' + 단계별 대안 2개를 성의 있게 제시 */
function quickApplyOptions(stage: ChatMessage["stage"], keyword: string): ChatOption[] {
  const formal = /결혼|장례|회의|면접|오피스|비즈니스|하객/.test(keyword);
  const accept: ChatOption = { label: "이대로 진행", detail: "방금 추천한 방향을 그대로 후보 5개에 반영해요.", primary: true };
  if (stage === "place") {
    return [accept,
      formal
        ? { label: "조금 더 편안하게", detail: "격식은 지키되 재킷·구두 대신 니트·로퍼처럼 힘을 뺀 조합으로요." }
        : { label: "조금 더 차분하게", detail: "톤을 낮추고 아이템 수를 줄여 정돈된 인상으로 맞춰요." },
      formal
        ? { label: "격식을 확실히", detail: "테일러드 아우터와 구두로 드레스코드를 분명하게 잡아요." }
        : { label: "조금 더 개성 있게", detail: "패턴이나 포인트 컬러를 하나 넣어 눈에 띄는 요소를 만들어요." },
    ];
  }
  if (stage === "fit") {
    return [accept,
      { label: "상체를 더 여유 있게", detail: "아우터·상의는 세미오버로, 하의는 곧게 떨어지는 핏으로 비율을 잡아요." },
      { label: "전체를 더 정돈되게", detail: "레귤러~슬림 핏으로 실루엣을 깔끔하게 정리해요." },
    ];
  }
  if (stage === "material") {
    return [accept,
      { label: "질감·패턴 더하기", detail: "니트 조직감이나 체크·스트라이프 한 가지로 밋밋함을 덜어요." },
      { label: "더 담백하게", detail: "무지·단색 위주로 소재 대비만 살려 미니멀하게 가요." },
    ];
  }
  return [accept];
}

type PlanningLog = {
  id: string;
  label: string;
  userLabel: "사용자 입력" | "사용자 답변" | "수정 요청";
  userText: string;
  agentText: string;
};

type UserIntent = {
  occasion: string;
  location: string;
  venue: string;
  date: string;
  gender: string;
  heightCm: number | null;
  weightKg: number | null;
  mustHave: string[];
  avoid: string[];
  styleDirection: string[];
  fitDirection: string[];
  materialDirection: string[];
  unknowns: string[];
  summary: string;
  confidence: string;
};

type AgentTraceEvent = {
  type: "tool_call" | "tool_result";
  tool: string;
  message: string;
};

type SearchHistoryItem = {
  id: string;
  keyword: string;
  createdAt: string;
  trend: string | null;
  variants: Variant[];
  evaluationProcess: EvaluationProcess | null;
  trace?: AgentTraceEvent[];
  placeContext?: string | null;
  feedback?: string[];
};

function getTimestamp() {
  return Date.now();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value];
  }
  return [];
}

function asTraceEvents(value: unknown): AgentTraceEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const event = item as Record<string, unknown>;
      if (event.type !== "tool_call" && event.type !== "tool_result") return null;
      return {
        type: event.type,
        tool: String(event.tool ?? "agent"),
        message: String(event.message ?? ""),
      } as AgentTraceEvent;
    })
    .filter((item): item is AgentTraceEvent => item !== null);
}

function normalizeUserIntent(value: unknown): UserIntent | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const numberOrNull = (entry: unknown) => {
    const number = Number(entry);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  return {
    occasion: String(item.occasion ?? ""),
    location: String(item.location ?? ""),
    venue: String(item.venue ?? ""),
    date: String(item.date ?? ""),
    gender: String(item.gender ?? "남성"),
    heightCm: numberOrNull(item.heightCm),
    weightKg: numberOrNull(item.weightKg),
    mustHave: asStringArray(item.mustHave),
    avoid: asStringArray(item.avoid),
    styleDirection: asStringArray(item.styleDirection),
    fitDirection: asStringArray(item.fitDirection),
    materialDirection: asStringArray(item.materialDirection),
    unknowns: asStringArray(item.unknowns),
    summary: String(item.summary ?? ""),
    confidence: String(item.confidence ?? "중간"),
  };
}

function normalizeConcept(value: unknown, index = 0): Concept | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const rawDescription = String(item.description ?? "");
  const description = rawDescription
    .replace(/\s*로\s+(?:남성|여성)\s*\d+안(?:을|를)?\s*제안해요\.?/g, "룩을 제안해요.")
    .replace(/\s+(?:남성|여성)\s*\d+안(?:을|를)?\s*제안해요\.?/g, " 룩을 제안해요.")
    .trim();
  return sanitizeCoreConcept({
    id: typeof item.id === "string" ? item.id : `look_${String(index + 1).padStart(2, "0")}`,
    name: String(item.name ?? `후보 ${index + 1}`),
    description,
    mood: String(item.mood ?? ""),
    colorPalette: asStringArray(item.colorPalette),
    targetCustomer: String(item.targetCustomer ?? "남성"),
    materials: asStringArray(item.materials),
    outfitItems: asStringArray(item.outfitItems),
    garmentSpecs: normalizeGarmentSpecs(item.garmentSpecs),
    bodyProfile: typeof item.bodyProfile === "string" ? item.bodyProfile : undefined,
    fitStrategy: typeof item.fitStrategy === "string" ? item.fitStrategy : undefined,
    stylingReason: typeof item.stylingReason === "string" ? item.stylingReason : undefined,
  });
}

function asConceptArray(value: unknown): Concept[] {
  return Array.isArray(value)
    ? value.map((item, index) => normalizeConcept(item, index)).filter((item): item is Concept => item !== null)
    : [];
}

function asScore(value: unknown): number {
  const score = typeof value === "number" ? value : Number(value);
  return Number.isFinite(score) ? score : 0;
}

function normalizeEvaluation(value: unknown): Evaluation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  return {
    id: String(item.id ?? item.name ?? crypto.randomUUID()),
    name: String(item.name ?? item.id ?? "이름 없는 후보"),
    requestScore: asScore(item.requestScore),
    weatherScore: asScore(item.weatherScore),
    placeScore: asScore(item.placeScore),
    bodyFitScore: asScore(item.bodyFitScore),
    trendScore: asScore(item.trendScore),
    practicalityScore: asScore(item.practicalityScore),
    colorScore: asScore(item.colorScore),
    diversityScore: asScore(item.diversityScore),
    totalScore: asScore(item.totalScore),
    failureReasons: asStringArray(item.failureReasons),
    revisionPlan: asStringArray(item.revisionPlan),
    verifierIssues: asStringArray(item.verifierIssues),
    rank: item.rank === undefined ? undefined : asScore(item.rank),
    decisionStatus: item.decisionStatus === "선택" ? "선택" : item.decisionStatus === "탈락" ? "탈락" : undefined,
    decisionReason: typeof item.decisionReason === "string" ? item.decisionReason : undefined,
  };
}

function asEvaluationArray(value: unknown): Evaluation[] {
  return Array.isArray(value)
    ? value.map(normalizeEvaluation).filter((item): item is Evaluation => item !== null)
    : [];
}

function asShoppingLinks(value: unknown): ShoppingLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const link = item as Record<string, unknown>;
      const url = typeof link.url === "string" ? link.url : "";
      if (link.kind === "search" || !isSpecificProductUrl(url)) return null;
      if (!coreGarmentCategory(`${String(link.category ?? "")}: ${String(link.item ?? "")}`)) return null;
      const normalizedLink: ShoppingLink = {
        kind: link.kind === "search" ? "search" : "product",
        category: typeof link.category === "string" ? link.category : undefined,
        item: String(link.item ?? "추천 아이템"),
        title: String(link.title ?? "비슷한 상품"),
        url,
        source: String(link.source ?? "쇼핑몰"),
        reason: String(link.reason ?? "최종 착장과 유사한 아이템이에요."),
        imageUrl: typeof link.imageUrl === "string" && /^https:\/\//.test(link.imageUrl) ? link.imageUrl : undefined,
        price: typeof link.price === "string" ? link.price : undefined,
        visualStatus: link.visualStatus === "verified" ? "verified" : "unverified",
        visualDifferences: asStringArray(link.visualDifferences),
        verificationNotice: typeof link.verificationNotice === "string" ? link.verificationNotice : undefined,
      };
      return normalizedLink;
    })
    .filter((item): item is ShoppingLink => item !== null);
}

function normalizeVariant(value: unknown, index: number): Variant | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const concept = normalizeConcept(item.concept ?? item, index);
  if (!concept) return null;
  return {
    concept,
    contradictionIssue: typeof item.contradictionIssue === "string" ? item.contradictionIssue : null,
    imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : null,
    imageGarmentSpecs: typeof item.imageUrl === "string" ? normalizeGarmentSpecs(item.imageGarmentSpecs) : [],
    lookbookVerified: typeof item.lookbookVerified === "boolean"
      ? item.lookbookVerified
      : item.verified === true,
    lookbookMismatches: asStringArray(item.lookbookMismatches ?? item.mismatches),
    lookbookRetried: typeof item.lookbookRetried === "boolean"
      ? item.lookbookRetried
      : Boolean(item.retried),
    lookbookError: typeof item.lookbookError === "string"
      ? item.lookbookError
      : typeof item.error === "string"
        ? item.error
        : null,
    finalMaterials: Array.isArray(item.finalMaterials)
      ? asStringArray(item.finalMaterials)
      : null,
    shoppingLinks: asShoppingLinks(item.shoppingLinks),
    shoppingError: typeof item.shoppingError === "string" ? item.shoppingError : null,
    shoppingMissingItems: asStringArray(item.shoppingMissingItems),
    shoppingLoading: false,
  };
}

function normalizeEvaluationProcess(value: Record<string, unknown>): EvaluationProcess {
  return {
    planStatus: value.planStatus === "partial" ? "partial" : "complete",
    evaluationStage: value.evaluationStage === "initial" || value.evaluationStage === "fallback" ? value.evaluationStage : "repaired",
    candidateSource: value.candidateSource === "local_fallback" ? "local_fallback" : "model",
    warnings: asStringArray(value.warnings),
    originalCandidates: asConceptArray(value.originalCandidates),
    round1: asEvaluationArray(value.round1),
    repairSummary: Array.isArray(value.repairSummary) ? (value.repairSummary as string[]) : [],
    repairedCandidates: asConceptArray(value.repairedCandidates),
    round2: asEvaluationArray(value.round2),
    finalConcepts: asConceptArray(value.finalConcepts),
  };
}

function weatherRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function formatDateLabel(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "입력한 날짜";
  const [, month, day] = value.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

function weatherCodeLabel(value: unknown) {
  if (value === null || value === undefined) return "날씨 정보 미확인";
  const code = Number(value);
  if (!Number.isFinite(code)) return "날씨 정보";
  if (code === 0) return "맑음";
  if (code <= 3) return "구름 많음";
  if (code <= 48) return "안개";
  if (code <= 67) return "비";
  if (code <= 86) return "눈";
  return "소나기·뇌우";
}

function buildWeatherMessage(weather: unknown) {
  const snapshot = weatherRecord(weather);
  const forecast = weatherRecord(snapshot?.forecast);
  const season = typeof snapshot?.season === "string" ? snapshot.season : "계절 미상";
  const forecastAvailable = snapshot?.forecastAvailable === true;
  const precipitation = typeof forecast?.precipitationMm === "number" ? forecast.precipitationMm : null;
  const max = typeof forecast?.temperatureMax === "number" ? forecast.temperatureMax : null;
  const min = typeof forecast?.temperatureMin === "number" ? forecast.temperatureMin : null;
  const location = weatherRecord(snapshot?.location);
  const requestedLocation = String(location?.query ?? location?.name ?? "입력 지역");
  const locationName = location?.resolution === "parent_region" ? `${requestedLocation} (${location.name} 기준 예보)` : requestedLocation;
  const dateLabel = formatDateLabel(snapshot?.date);
  const weatherLabel = weatherCodeLabel(forecast?.weatherCode);

  if (forecastAvailable && precipitation !== null && precipitation >= 2) {
    return `${dateLabel} ${locationName}은 ${weatherLabel}, 최고 ${max ?? "미상"}°C·최저 ${min ?? "미상"}°C, 강수량 ${precipitation}mm 기준으로 볼게요. 비에 대응하는 가벼운 레이어를 우선하되 원하는 분위기는 다음 단계에서 조정할 수 있어요.`;
  }
  if (forecastAvailable && max !== null && min !== null) {
    return `${dateLabel} ${locationName}은 ${weatherLabel}, 최고 ${max}°C·최저 ${min}°C, 강수량 ${precipitation ?? "미상"}mm·최대풍속 ${forecast?.windSpeedMax ?? "미상"}m/s 기준입니다. 일교차에 맞춘 조절 가능한 레이어를 우선할게요.`;
  }
  return `${dateLabel} ${locationName}의 단기 예보 수치는 아직 확정할 수 없어 ${season} 계절감을 중심으로 볼게요. 날씨가 확정되지 않은 부분은 과한 기능성보다 조절 가능한 레이어링으로 제안하겠습니다.`;
}

function buildInitialPlaceQuestion(keyword: string, intent?: UserIntent | null) {
  const hasOccasion = Boolean(intent?.occasion) || /결혼|장례|회의|면접|데이트|여행|카페|공연|식당|바|출근|약속|친구|방탈출|음악|가족|부모님|생일/.test(keyword);
  const hasMovement = /실내|실외|이동|걷|차|대중교통/.test(keyword);
  const hasFitDirection = Boolean(intent?.fitDirection.length) || /오버|여유|편안|슬림|단정|정돈|깔끔|와이드|스트레이트|테이퍼드|크롭|롱기장|짧은|긴/.test(keyword);
  const hasMaterialDirection = Boolean(intent?.materialDirection.length) || /데님|면|코튼|리넨|린넨|울|니트|가죽|레더|나일론|메시|메쉬|새틴|벨벳|체크|스트라이프|패턴|광택|질감/.test(keyword);
  if (!hasOccasion) {
    return {
      text: "장소는 파악했어요. 이번 일정은 어떤 약속인가요? 약속의 성격에 따라 격식과 무드를 먼저 맞출게요.",
      options: [
        { label: "데이트·친구 약속", detail: "편안하지만 신경 쓴 느낌. 캐주얼과 세미캐주얼 사이에서 잡아요." },
        { label: "업무·회의", detail: "격식이 우선. 재킷·셔츠 기반의 정돈된 조합으로 맞춰요." },
        { label: "여행·활동", detail: "이동과 활동성이 우선. 가벼운 레이어와 편한 신발 위주로요." },
      ],
      stage: "place" as const,
      allowQuickApply: false,
    };
  }
  if (!hasMovement) {
    return {
      text: "실내외 이동 여부가 아직 정해지지 않았어요. 장소와 약속에 맞춰 제가 추천하거나, 직접 방향을 정해주시면 그 조건을 우선 반영할게요.",
      options: [
        { label: "추천해줘", detail: "장소와 약속 성격을 보고 제가 가장 자연스러운 방향을 먼저 제안할게요.", primary: true },
        { label: "실내 중심", detail: "앉아 있는 시간이 길어요. 얇은 레이어와 앉았을 때 편한 핏을 우선해요." },
        { label: "이동이 많아요", detail: "걷거나 대중교통을 타요. 편한 신발과 벗어 들기 쉬운 겉옷을 우선해요." },
      ],
      stage: "place" as const,
      allowQuickApply: false,
    };
  }
  if (!hasFitDirection) {
    return {
      text: "핏은 아직 정해지지 않았어요. 체형과 장소 분위기를 보고 제가 추천하거나, 원하는 실루엣을 직접 알려주시면 그 방향을 우선 반영할게요.",
      options: [
        { label: "추천해줘", detail: "체형과 장소 분위기에 맞는 핏을 제가 먼저 제안할게요.", primary: true },
        { label: "정돈된 핏", detail: "레귤러~슬림으로 실루엣을 깔끔하게. 단정한 인상을 원할 때." },
        { label: "여유 있는 핏", detail: "상의는 세미오버, 하의는 곧게. 편안하면서 요즘 비율로 잡아요." },
      ],
      stage: "fit" as const,
      allowQuickApply: false,
    };
  }
  if (!hasMaterialDirection) {
    return {
      text: "소재와 레이어링은 아직 정해지지 않았어요. 날씨와 장소 무드에 맞는 조합을 제가 추천하거나, 원하는 소재·패턴을 직접 알려주시면 그 조건을 우선 반영할게요.",
      options: [
        { label: "추천해줘", detail: "날씨와 장소 무드에 맞는 소재·레이어링을 제가 먼저 제안할게요.", primary: true },
        { label: "패턴·질감 더하기", detail: "니트 조직감이나 체크·스트라이프 한 가지로 포인트를 줘요." },
        { label: "더 담백하게", detail: "무지·단색 위주로 소재 대비만 살려 미니멀하게 가요." },
      ],
      stage: "material" as const,
      allowQuickApply: false,
    };
  }
  return {
    text: "입력하신 장소·약속·핏·소재 방향을 기준으로 바로 후보를 만들 수 있어요. 더 바꾸고 싶은 점이 있으면 말씀해주세요.",
    options: [],
    stage: "ready" as const,
    allowQuickApply: false,
  };
}

function buildReadyMessage(keyword: string, feedback: string[], trend: string) {
  return buildDirectConsultationReply({ keyword, feedback, trend, stage: "material" });
}

function friendlyPlanningError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  if (/outfitItems|concepts|candidates|필수 스타일 정보|Request was aborted|후보 생성|수정 후보|재평가/.test(message)) {
    return "말씀해주신 조건을 후보 구성에 다시 맞추지 못했어요. 조건은 유지한 채 잠시 후 다시 시도해주세요.";
  }
  return message || "후보를 준비하지 못했어요.";
}

async function postJson(url: string, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  // A route can fail before it ever writes a JSON body (uncaught throw,
  // network drop) - guard the parse so that shows up as a clear message
  // instead of "Unexpected end of JSON input".
  let data: Record<string, unknown> | null = null;
  try {
    data = await res.json();
  } catch {
    // leave data as null; res.ok check below produces the real error message
  }

  if (!res.ok) {
    const message = (data?.error as string | undefined) ?? `${url} 요청 실패 (HTTP ${res.status})`;
    throw new Error(message);
  }
  if (!data) {
    throw new Error(`${url} 응답을 읽을 수 없어요 (빈 응답)`);
  }
  return data;
}

function AgentTracePanel({
  step,
  evaluationProcess,
  trace,
}: {
  step: Step;
  evaluationProcess: EvaluationProcess | null;
  trace: AgentTraceEvent[];
}) {
  const activeIndex =
    step === "idle" ? -1 : step === "done" ? AGENTKIT_TRACE_STEPS.length : AGENTKIT_TRACE_STEPS.findIndex((item) => item.key === step);

  return (
    <aside className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
        AgentKit Trace
      </p>
      <div className="mt-4 flex flex-col gap-3">
        {AGENTKIT_TRACE_STEPS.map((item, index) => {
          const incomplete = (item.key === "evaluate" || item.key === "concept") && evaluationProcess?.planStatus === "partial";
          const isDone = activeIndex > index && !incomplete;
          const isActive = activeIndex === index;
          return (
            <div
              key={item.key}
              className={
                isActive
                  ? "rounded-md border border-violet-200 bg-violet-50 p-3 dark:border-violet-900 dark:bg-violet-950/50"
                  : "rounded-md bg-zinc-50 p-3 dark:bg-zinc-900"
              }
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    isDone
                      ? "flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] text-white"
                      : isActive
                      ? "h-5 w-5 animate-pulse rounded-full border-2 border-violet-500"
                      : "h-5 w-5 rounded-full border border-zinc-300 dark:border-zinc-700"
                  }
                >
                  {incomplete ? "!" : isDone ? "✓" : ""}
                </span>
                <p className="text-sm font-medium text-black dark:text-zinc-50">{item.title}</p>
              </div>
              <p className="mt-1 pl-7 text-xs leading-relaxed text-zinc-500 break-keep">
                {incomplete ? "확보한 후보로 진행했습니다. 보완 미완료 항목은 아래 기록에서 확인할 수 있어요." : item.detail}
                {item.tool && (
                  <span className="mt-1 block font-mono text-[10px] uppercase tracking-wide text-zinc-400">
                    {AGENTKIT_TOOLS[item.tool].label}
                  </span>
                )}
              </p>
            </div>
          );
        })}
      </div>
      {evaluationProcess?.round2.length ? (
        <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
            현재 후보의 규칙 기반 평가
          </p>
          <div className="mt-3 grid gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            {[
              ["weather_fit", "날씨", evaluationProcess.round2.map((item) => item.weatherScore)],
              ["color_harmony", "색 조화", evaluationProcess.round2.map((item) => item.colorScore)],
              ["diversity", "후보 다양성", evaluationProcess.round2.map((item) => item.diversityScore)],
              ["occasion_fit", "장소·상황", evaluationProcess.round2.map((item) => item.placeScore)],
            ].map(([tool, label, scores]) => {
              const values = scores as number[];
              const average = values.length
                ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
                : 0;
              return (
                <div key={tool as string} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-zinc-400">{tool as string}</span>
                  <span>{label as string} 평균 {average}점</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {trace.length ? (
        <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
            실제 Agent Tool Call
          </p>
          <div className="mt-3 max-h-64 space-y-2 overflow-y-auto text-xs">
            {trace.map((event, index) => (
              <div key={`${event.tool}-${event.type}-${index}`} className="border-l-2 border-violet-200 pl-2 dark:border-violet-800">
                <p className="font-mono text-[10px] text-zinc-400">
                  {event.type === "tool_call" ? "tool_call" : "tool_result"} · {event.tool}
                </p>
                <p className="mt-0.5 leading-relaxed text-zinc-600 dark:text-zinc-300">{event.message}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

export default function Home() {
  const [keyword, setKeyword] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [screen, setScreen] = useState<Screen>("search");
  const [conversationStage, setConversationStage] = useState<ConversationStage>("place");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [feedback, setFeedback] = useState<string[]>([]);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<string | null>(null);
  const [weather, setWeather] = useState<Record<string, unknown> | null>(null);
  const [placeContext, setPlaceContext] = useState<string | null>(null);
  const [userIntent, setUserIntent] = useState<UserIntent | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [evaluationProcess, setEvaluationProcess] = useState<EvaluationProcess | null>(null);
  const [agentTrace, setAgentTrace] = useState<AgentTraceEvent[]>([]);
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>("hidden");
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isTraceOpen, setIsTraceOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [selectedRefineIndex, setSelectedRefineIndex] = useState(0);
  const [refineInput, setRefineInput] = useState("");
  const [refinementMessages, setRefinementMessages] = useState<ChatMessage[]>([]);
  const [variantHistory, setVariantHistory] = useState<Record<string, Variant[]>>({});
  const [planningLog, setPlanningLog] = useState<PlanningLog[]>([]);
  const [isCandidatePlanOpen, setIsCandidatePlanOpen] = useState(false);
  const [isFinalPlanOpen, setIsFinalPlanOpen] = useState(false);
  const [openScoreIndex, setOpenScoreIndex] = useState<number | null>(null);
  const [refiningIndex, setRefiningIndex] = useState<number | null>(null);
  const [lookbookStartedAt, setLookbookStartedAt] = useState<number | null>(null);
  const [lookbookElapsedMs, setLookbookElapsedMs] = useState(0);
  const resultsRef = useRef<HTMLElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const [shoppingRequests] = useState(createShoppingRequestRegistry);

  useEffect(() => () => shoppingRequests.cancelAll(), [shoppingRequests]);

  // 룩북 생성 중 경과 시간 (플레이스홀더에 표시)
  useEffect(() => {
    if (lookbookStartedAt === null) return;
    const timer = window.setInterval(() => setLookbookElapsedMs(Date.now() - lookbookStartedAt), 500);
    return () => window.clearInterval(timer);
  }, [lookbookStartedAt]);

  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [chatMessages, isBusy]);

  function appendTrace(event: AgentTraceEvent) {
    setAgentTrace((previous) => [...previous, event]);
  }

  function appendAgentTrace(value: unknown) {
    const events = asTraceEvents(value);
    if (events.length) setAgentTrace((previous) => [...previous, ...events]);
    return events;
  }

  function appendAssistant(
    text: string,
    stage?: ChatMessage["stage"],
    options?: ChatOption[],
    allowQuickApply = false,
  ) {
    const visibleText = text.trim();
    if (!visibleText) return;
    setChatMessages((previous) => [
      ...previous,
      { id: `${Date.now()}-${previous.length}`, role: "assistant", text: visibleText, stage, options, allowQuickApply },
    ]);
  }

  function appendUser(text: string) {
    setChatMessages((previous) => [
      ...previous,
      { id: `${Date.now()}-${previous.length}`, role: "user", text },
    ]);
  }

  function appendPlanningLog(
    label: string,
    userText: string,
    agentText: string,
    userLabel: PlanningLog["userLabel"] = "사용자 답변",
  ) {
    setPlanningLog((previous) => [
      ...previous,
      { id: `${Date.now()}-${previous.length}`, label, userLabel, userText, agentText },
    ].slice(-12));
  }

  async function requestConsultation(
    stage: "place" | "fit" | "material",
    nextFeedback: string[],
  ): Promise<{ message: string; options: ChatOption[]; allowQuickApply: boolean } | null> {
    try {
      const data = await postJson(AGENTKIT_TOOLS.agent.endpoint, {
        action: "consult",
        stage,
        keyword,
        trend,
        weather,
        placeContext,
        userIntent,
        feedback: nextFeedback,
      });
      const message = typeof data.message === "string" ? data.message.trim() : "";
      if (!message) throw new Error("빈 상담 응답");
      appendAgentTrace(data.trace);
      return {
        message,
        options: toChatOptions(data.options),
        allowQuickApply: data.allowQuickApply === true,
      };
    } catch (error) {
      appendTrace({
        type: "tool_result",
        tool: "consult",
        message: `상담 응답을 확인하지 못했습니다. 후보 생성 전 저장된 요청으로 기본 조합을 제안합니다. ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
      });
      return null;
    }
  }

  function patchCurrentVariant(runId: string | null, fingerprint: string, patch: Partial<Variant> | ((variant: Variant) => Partial<Variant>)) {
    if (activeRunIdRef.current !== runId) return;
    setVariants((current) => activeRunIdRef.current === runId ? patchMatchingVariant(current, fingerprint, patch) : current);
    if (runId) setHistory((current) => current.map((item) => item.id === runId
      ? { ...item, variants: patchMatchingVariant(item.variants, fingerprint, patch) } : item));
  }

  function shoppingKey(runId: string | null, concept: Concept) {
    return `${runId ?? "unsaved"}:${concept.id ?? concept.name}`;
  }

  function cancelVariantShopping(variant: Variant) {
    const runId = activeRunIdRef.current;
    shoppingRequests.cancel(shoppingKey(runId, variant.concept));
    patchCurrentVariant(runId, conceptFingerprint(variant.concept), { shoppingLoading: false });
  }

  function saveHistory(item: SearchHistoryItem) {
    setHistory((prev) => [item, ...prev.filter((historyItem) => historyItem.id !== item.id)].slice(0, 5));
  }

  function updateHistoryVariants(id: string, nextVariants: Variant[]) {
    setHistory((prev) => prev.map((item) => (item.id === id ? { ...item, variants: nextVariants } : item)));
  }

  function resetForNewSearch() {
    shoppingRequests.cancelAll();
    setKeyword("");
    setChatInput("");
    setScreen("search");
    setConversationStage("place");
    setChatMessages([]);
    setFeedback([]);
    setError(null);
    setTrend(null);
    setWeather(null);
    setPlaceContext(null);
    setUserIntent(null);
    setVariants([]);
    setEvaluationProcess(null);
    setAgentTrace([]);
    setSelectedCandidateIds([]);
    setSelectedRefineIndex(0);
    setRefineInput("");
    setRefinementMessages([]);
    setVariantHistory({});
    setPlanningLog([]);
    setIsCandidatePlanOpen(false);
    setIsFinalPlanOpen(false);
    setOpenScoreIndex(null);
    setRefiningIndex(null);
    setStep("idle");
    setLoadingPhase("hidden");
    setIsHistoryOpen(false);
    setIsTraceOpen(false);
    setIsBusy(false);
    activeRunIdRef.current = null;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function restoreHistory(item: SearchHistoryItem) {
    shoppingRequests.cancelAll();
    activeRunIdRef.current = item.id;
    setKeyword(item.keyword);
    setTrend(item.trend);
    setPlaceContext(item.placeContext ?? null);
    setUserIntent(null);
    setFeedback(item.feedback ?? []);
    const restoredVariants = item.variants.map(normalizeVariant).filter((item): item is Variant => item !== null);
    setVariants(restoredShoppingState(restoredVariants));
    updateHistoryVariants(item.id, restoredShoppingState(restoredVariants));
    setSelectedRefineIndex(0);
    setRefineInput("");
    setRefinementMessages([]);
    setVariantHistory({});
    setPlanningLog([]);
    setIsCandidatePlanOpen(false);
    setIsFinalPlanOpen(false);
    setOpenScoreIndex(null);
    setRefiningIndex(null);
    setEvaluationProcess(item.evaluationProcess);
    setAgentTrace(item.trace ?? []);
    setError(null);
    setStep("done");
    setScreen("final");
    setLoadingPhase("hidden");
    setIsHistoryOpen(false);
    setIsTraceOpen(false);
  }

  async function findShoppingLinks(index: number) {
    const variant = variants[index];
    if (!variant || variant.shoppingLoading || isBusy) return;
    const runId = activeRunIdRef.current;
    const fingerprint = conceptFingerprint(variant.concept);
    // This guard is synchronous, so a second click before React renders cannot
    // create another request for the same card.
    const request = shoppingRequests.begin(shoppingKey(runId, variant.concept), fingerprint);
    if (!request) return;
    patchCurrentVariant(runId, fingerprint, { shoppingLoading: true, shoppingError: null });
    try {
      const data = await withShoppingDeadline(
        (signal) => postJson(AGENTKIT_TOOLS.agent.endpoint, {
          action: "shopping", keyword: keyword.trim(), concept: variant.concept,
          imageUrl: variant.imageUrl, imageGarmentSpecs: variant.imageGarmentSpecs,
        }, signal),
        request.controller,
      );
      if (!shoppingRequests.isCurrent(request) || activeRunIdRef.current !== runId) return;
      appendAgentTrace(data.trace);
      const links = asShoppingLinks(data.links);
      patchCurrentVariant(runId, fingerprint, (current) => {
        const merged = mergeShoppingProducts(current.shoppingLinks, links, asStringArray(data.missingItems), asStringArray(data.searchedCategories), asStringArray(data.rejectedProductUrls));
        return {
          ...merged,
          shoppingError: merged.shoppingMissingItems.length || !merged.shoppingLinks.length
            ? typeof data.warning === "string" ? data.warning : "일부 품목의 개별 상품을 아직 찾지 못했어요. 다시 찾기를 눌러 재시도할 수 있어요."
            : null,
        };
      });
    } catch (error) {
      if (shoppingRequests.isCurrent(request)) {
        patchCurrentVariant(runId, fingerprint, {
          shoppingError: error instanceof Error ? error.message : "상품 검색을 완료하지 못했어요. 다시 시도해 주세요.",
        });
      }
    } finally {
      if (shoppingRequests.isCurrent(request)) {
        patchCurrentVariant(runId, fingerprint, { shoppingLoading: false });
        shoppingRequests.finish(request);
      }
    }
  }

  async function startConversation() {
    if (!keyword.trim() || isBusy) return;
    shoppingRequests.cancelAll();
    const runKeyword = keyword.trim();
    const runStartedAt = getTimestamp();
    activeRunIdRef.current = `${runStartedAt}`;
    setError(null);
    setTrend(null);
    setWeather(null);
    setPlaceContext(null);
    setUserIntent(null);
    setVariants([]);
    setEvaluationProcess(null);
    setSelectedCandidateIds([]);
    setSelectedRefineIndex(0);
    setRefineInput("");
    setRefinementMessages([]);
    setVariantHistory({});
    setPlanningLog([]);
    setIsCandidatePlanOpen(false);
    setIsFinalPlanOpen(false);
    setOpenScoreIndex(null);
    setRefiningIndex(null);
    setFeedback([]);
    setChatInput("");
    setChatMessages([{ id: `${runStartedAt}-user`, role: "user", text: runKeyword }]);
    setAgentTrace([
      {
        type: "tool_call",
        tool: "agent",
        message: "Agent Orchestrator가 대화형 스타일링 세션을 시작합니다.",
      },
    ]);
    setScreen("chat");
    setStep("trend");
    setIsHistoryOpen(false);
    setIsBusy(true);

    try {
      const data = await postJson(AGENTKIT_TOOLS.agent.endpoint, { action: "prepare", keyword: runKeyword });
      appendAgentTrace(data.trace);
      const nextIntent = normalizeUserIntent(data.intent);
      setUserIntent(nextIntent);
      const nextTrend = typeof data.trend === "string" ? data.trend : "";
      const nextWeather = weatherRecord(data.weather);
      setTrend(nextTrend);
      setWeather(nextWeather);
      setPlaceContext(typeof data.placeContext === "string" ? data.placeContext : null);
      appendTrace({
        type: "tool_result",
        tool: "weather",
        message: "날씨 전략을 대화 첫 단계로 전달합니다.",
      });
      const weatherMessage = buildWeatherMessage(nextWeather);
      appendAssistant(weatherMessage, "weather");
      setPlanningLog([{
        id: `${runStartedAt}-weather`,
        label: "날씨·계절",
        userLabel: "사용자 입력",
        userText: runKeyword,
        agentText: weatherMessage,
      }]);
      const initialQuestion = buildInitialPlaceQuestion(runKeyword, nextIntent);
      appendAssistant(
        initialQuestion.text,
        initialQuestion.stage,
        initialQuestion.options,
        initialQuestion.allowQuickApply,
      );
      setConversationStage(initialQuestion.stage);
      setStep("concept");
      setIsBusy(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : "날씨·장소 분석에 실패했어요.";
      setError(message);
      appendAssistant(`컨텍스트 분석을 완료하지 못했어요. ${message} 사용자 입력과 날씨·장소를 정확히 반영해야 후보를 만들 수 있으니 잠시 후 다시 검색해주세요.`, "weather");
      setIsBusy(false);
      setStep("trend");
    }
  }

  async function submitConversationFeedback(value = chatInput) {
    const text = value.trim();
    if (!text || isBusy || screen !== "chat") return;
    setChatInput("");
    setError(null);
    appendUser(text);
    const nextFeedback = [...feedback, text];
    setFeedback(nextFeedback);
    setIsBusy(true);

    const currentStage = conversationStage;
    const allFeedback = `${keyword} ${nextFeedback.join(" ")}`;
    const isAffirmative = /^(좋아|좋아요|괜찮아|괜찮아요|그대로|그 방향|이대로 진행|이 방향으로 진행|이 핏으로 진행|응|네|그래|진행해|반영해|그렇게 해줘)[!.。！\s]*$/i.test(text);
    const isRecommendationRequest = /추천해줘|추천해 주세요|추천해줘요|알아서 해줘|맡길게|맡겨줘|네가 골라|에이전트 추천/i.test(text);
    const previousAssistant = [...chatMessages]
      .reverse()
      .find((message) => message.role === "assistant" && message.stage !== "weather");
    const hasFitDirection = Boolean(userIntent?.fitDirection.length) || /오버|여유|편안|슬림|단정|정돈|깔끔|와이드|스트레이트|테이퍼드|크롭|롱기장|짧은|긴/.test(allFeedback);
    const hasMaterialDirection = Boolean(userIntent?.materialDirection.length) || /데님|면|코튼|리넨|린넨|울|니트|가죽|레더|나일론|메시|메쉬|새틴|벨벳|체크|스트라이프|패턴|광택|질감/.test(allFeedback);
    const nextStage: ConversationStage = currentStage === "place"
      ? hasFitDirection ? (hasMaterialDirection ? "ready" : "material") : "fit"
      : currentStage === "fit"
        ? hasMaterialDirection ? "ready" : "material"
        : isAffirmative || hasMaterialDirection ? "ready" : "material";
    // Each reply should move the conversation forward. Re-consulting the
    // current stage after "좋아" caused the same fit explanation to repeat.
    const consultationStage = isRecommendationRequest && currentStage !== "ready"
      ? currentStage
      : currentStage === "place"
        ? nextStage === "fit" ? "fit" : "material"
        : "material";
    const shouldConsult = isRecommendationRequest || currentStage === "ready" || nextStage !== "ready" || (currentStage === "material" && !isAffirmative);
    const response = shouldConsult
      ? await requestConsultation(consultationStage, nextFeedback) ?? {
          message: buildDirectConsultationReply({ keyword, feedback: nextFeedback, trend: trend ?? "", stage: consultationStage }),
          options: [],
          allowQuickApply: true,
        }
      : null;
    const acceptedRecommendation = isAffirmative && previousAssistant?.allowQuickApply && previousAssistant.text
      ? `에이전트 추천 반영: ${previousAssistant.text}`
      : null;
    const planningFeedback = acceptedRecommendation ? [...nextFeedback, acceptedRecommendation] : nextFeedback;
    if (acceptedRecommendation) setFeedback(planningFeedback);
    const effectiveStage = isRecommendationRequest && currentStage !== "ready"
      ? currentStage
      : response && !response.allowQuickApply ? currentStage : nextStage;
    let assistantText = "";
    let assistantStage: ChatMessage["stage"] = "ready";
    let options: ChatOption[] | undefined;
    let logLabel = "스타일 방향";
    if (currentStage === "place") {
      assistantText = response?.message || buildReadyMessage(keyword, planningFeedback, trend ?? "");
      assistantStage = isRecommendationRequest ? consultationStage : nextStage === "ready" ? "ready" : consultationStage;
      options = nextStage === "ready" ? [] : response?.options ?? [];
      logLabel = consultationStage === "fit" ? "핏·실루엣" : "소재·레이어링";
      setConversationStage(effectiveStage);
    } else if (currentStage === "fit") {
      assistantText = response?.message || buildReadyMessage(keyword, planningFeedback, trend ?? "");
      assistantStage = isRecommendationRequest ? consultationStage : nextStage === "ready" ? "ready" : consultationStage;
      options = nextStage === "ready" ? [] : response?.options ?? [];
      logLabel = "소재·레이어링";
      setConversationStage(effectiveStage);
    } else if (currentStage === "material") {
      assistantText = response?.message || buildReadyMessage(keyword, planningFeedback, trend ?? "");
      assistantStage = response ? "material" : "ready";
      options = response?.options ?? [];
      logLabel = "소재·레이어링";
      setConversationStage(effectiveStage);
    } else {
      assistantText = response?.message || buildReadyMessage(keyword, planningFeedback, trend ?? "");
      logLabel = "최종 스타일 방향";
    }
    appendAssistant(assistantText, assistantStage, options, response?.allowQuickApply ?? false);
    appendPlanningLog(logLabel, text, assistantText);
    setIsBusy(false);
  }

  function appendRefinementMessage(role: ChatMessage["role"], text: string) {
    setRefinementMessages((previous) => [
      ...previous,
      { id: `${Date.now()}-${previous.length}`, role, text },
    ]);
  }

  async function refineSelectedLook(value = refineInput) {
    const text = value.trim();
    const current = variants[selectedRefineIndex];
    if (!text || !current || isBusy) return;
    const conceptId = current.concept.id ?? current.concept.name;
    cancelVariantShopping(current);
    const runId = activeRunIdRef.current;
    const fingerprint = conceptFingerprint(current.concept);
    const previous = { ...current, shoppingLoading: false };
    setRefineInput("");
    appendRefinementMessage("user", text);
    setIsBusy(true);
    setRefiningIndex(selectedRefineIndex);
    try {
      const data = await postJson(AGENTKIT_TOOLS.agent.endpoint, {
        action: "refine",
        concept: current.concept,
        imageUrl: current.imageUrl, imageGarmentSpecs: current.imageGarmentSpecs,
        feedback: text,
        trend,
        weather,
        evaluation: evaluationProcess?.round2.find((item) => item.id === conceptId),
      });
      if (data.unchanged === true) {
        appendAgentTrace(data.trace);
        appendRefinementMessage("assistant", typeof data.refinementReply === "string" ? data.refinementReply : "현재 룩을 그대로 유지했어요.");
        return;
      }
      const nextVariant = normalizeVariant(
        {
          ...current,
          ...data,
          concept: data.concept ?? current.concept,
          imageGarmentSpecs: data.imageGarmentSpecs ?? [],
          lookbookVerified: data.verified === true,
          lookbookMismatches: data.mismatches ?? [],
          lookbookError: data.error ?? null,
          lookbookRetried: data.retried === true,
          shoppingLinks: [],
          shoppingError: null,
          shoppingMissingItems: [],
          shoppingLoading: false,
        },
        selectedRefineIndex,
      );
      if (!nextVariant) throw new Error("수정된 룩을 읽을 수 없어요.");
      setVariantHistory((previousHistory) => ({
        ...previousHistory,
        [conceptId]: [...(previousHistory[conceptId] ?? []), previous].slice(-8),
      }));
      patchCurrentVariant(runId, fingerprint, nextVariant);
      appendAgentTrace(data.trace);
      appendRefinementMessage(
        "assistant",
        typeof data.refinementReply === "string"
          ? data.refinementReply
          : "요청한 부분을 반영해 기존 코디의 균형은 유지했어요.",
      );
      appendPlanningLog(
        "룩 수정",
        text,
        typeof data.refinementReply === "string" ? data.refinementReply : "요청한 부분을 반영했어요.",
        "수정 요청",
      );
    } catch (error) {
      appendRefinementMessage(
        "assistant",
        `수정 중 문제가 생겼어요. ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
      );
    } finally {
      setRefiningIndex(null);
      setIsBusy(false);
    }
  }

  function undoSelectedLook() {
    const current = variants[selectedRefineIndex];
    if (!current || isBusy) return;
    const conceptId = current.concept.id ?? current.concept.name;
    const stack = variantHistory[conceptId] ?? [];
    const previous = stack.at(-1);
    if (!previous) return;
    cancelVariantShopping(current);
    const nextStack = stack.slice(0, -1);
    setVariantHistory((historyState) => ({ ...historyState, [conceptId]: nextStack }));
    patchCurrentVariant(activeRunIdRef.current, conceptFingerprint(current.concept), { ...previous, shoppingLoading: false });
    appendRefinementMessage("assistant", "방금 수정한 내용을 되돌리고 이전 룩을 복원했어요.");
  }

  function candidateList() {
    if (!evaluationProcess) return [];
    const rankById = new Map(evaluationProcess.round2.map((item, index) => [item.id, item.rank ?? index + 1]));
    const scoreById = new Map(evaluationProcess.round2.map((item) => [item.id, item.totalScore]));
    return [...evaluationProcess.repairedCandidates].sort((a, b) => {
      const rankA = rankById.get(a.id ?? a.name) ?? 999;
      const rankB = rankById.get(b.id ?? b.name) ?? 999;
      return rankA - rankB || (scoreById.get(b.id ?? b.name) ?? 0) - (scoreById.get(a.id ?? a.name) ?? 0);
    });
  }

  async function generateCandidates() {
    if (!keyword.trim() || isBusy) return;
    if (!trend) {
      setError("날씨·장소 분석이 아직 끝나지 않았어요. 잠시 후 다시 시도해주세요.");
      return;
    }
    const feedbackText = feedback.length ? `\n\n대화 중 사용자 피드백:\n${feedback.map((item) => `- ${item}`).join("\n")}` : "";
    setError(null);
    setIsBusy(true);
    setStep("concept");
    appendAssistant("상의·하의·신발 조합을 비교하고 있어요. 보완 작업이 지연되면 먼저 만든 후보를 보여드릴게요.", "ready");
    try {
      const consultationProposal = [...chatMessages].reverse().find((message) => message.role === "assistant" && message.stage !== "weather")?.text ?? "";
      const data = await postJson(AGENTKIT_TOOLS.agent.endpoint, {
        action: "plan",
        consultationProposal,
        keyword: `${keyword.trim()}${feedbackText}`,
        trend,
        weather,
        intent: userIntent,
      });
      appendAgentTrace(data.trace);
      const process = normalizeEvaluationProcess(data);
      setEvaluationProcess(process);
      // 기본 선택 없음: 사용자가 직접 고른 후보만 룩북으로 만든다 (에이전트 추천 2안은 순위·배지로만 표시)
      setSelectedCandidateIds([]);
      setScreen("candidates");
      setIsBusy(false);
    } catch (e) {
      const message = friendlyPlanningError(e);
      setError(message);
      appendAssistant(`후보를 만드는 중 문제가 생겼어요. ${message}`, "ready");
      setIsBusy(false);
    }
  }

  function toggleCandidate(id: string) {
    if (isBusy) return;
    setSelectedCandidateIds((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : previous.length < 5
          ? [...previous, id]
          : previous,
    );
  }

  function emptyVariant(concept: Concept): Variant {
    return {
      concept,
      contradictionIssue: null,
      imageUrl: null,
      lookbookVerified: false,
      imageGarmentSpecs: [],
      lookbookMismatches: [],
      lookbookRetried: false,
      lookbookError: null,
      finalMaterials: null,
      shoppingLinks: [],
      shoppingError: null,
      shoppingMissingItems: [],
      shoppingLoading: false,
    };
  }

  async function generateSelectedLooks() {
    if (!evaluationProcess || !selectedCandidateIds.length || isBusy) return;
    const selected = candidateList().filter((concept) => selectedCandidateIds.includes(concept.id ?? concept.name));
    if (!selected.length) return;
    shoppingRequests.cancelAll();
    const runId = activeRunIdRef.current;
    setIsBusy(true);
    setStep("variants");
    setVariants(selected.map(emptyVariant));
    setLookbookElapsedMs(0);
    setLookbookStartedAt(getTimestamp());
    setScreen("final");
    const lookbookCall: AgentTraceEvent = {
      type: "tool_call",
      tool: "build_lookbook",
      message: `선택한 ${selected.length}개 룩의 이미지를 병렬 생성하고 Vision으로 확인합니다.`,
    };
    appendTrace(lookbookCall);
    const routeTrace: AgentTraceEvent[] = [];

    const evaluations = evaluationProcess.round2;
    const results = await Promise.all(
      selected.map(async (concept) => {
        const evaluation = evaluations.find((item) => item.id === concept.id || item.name === concept.name);
        try {
          const data = await postJson(AGENTKIT_TOOLS.agent.endpoint, {
            action: "lookbook",
            concept,
            evaluation,
            trend,
            weather,
          });
          routeTrace.push(...asTraceEvents(data.trace));
          appendAgentTrace(data.trace);
          return normalizeVariant({ ...concept, ...data, concept: data.concept ?? concept }, 0) ?? emptyVariant(concept);
        } catch (e) {
          return {
            ...emptyVariant(concept),
            lookbookError: e instanceof Error ? e.message : "이미지 생성 실패",
          };
        }
      }),
    );
    setVariants(results);
    setLookbookStartedAt(null);
    const verifiedCount = results.filter((item) => item.lookbookVerified).length;
    const lookbookResult: AgentTraceEvent = {
      type: "tool_result",
      tool: "build_lookbook",
      message: `${results.length}개 중 ${results.filter((item) => item.imageUrl).length}개 룩북을 생성했습니다. ${verifiedCount}개는 이미지 비교를 통과했고, 나머지는 확인 상태를 카드에 표시합니다.`,
    };
    appendTrace(lookbookResult);
    const finalTrace = [...agentTrace, lookbookCall, ...routeTrace, lookbookResult];
    setStep("done");
    setIsBusy(false);
    if (runId) {
      saveHistory({
        id: runId,
        keyword: keyword.trim(),
        createdAt: new Date(Number(runId)).toLocaleString("ko-KR", { hour12: false }),
        trend,
        variants: results,
        evaluationProcess,
        trace: finalTrace,
        placeContext,
        feedback,
      });
    }
  }

  function goBackToCandidates() {
    if (isBusy) return;
    setScreen("candidates");
    setStep("concept");
  }

  function renderHistory() {
    return (
      <div className="relative mt-2 flex justify-start">
        <button
          type="button"
          onClick={() => setIsHistoryOpen((prev) => !prev)}
          disabled={history.length === 0}
          className="rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-zinc-900 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          이전 기록 {history.length > 0 ? history.length : ""}
        </button>
        {isHistoryOpen && (
          <div className="absolute left-0 top-10 z-20 w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-white p-2 text-left shadow-2xl">
            {history.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => restoreHistory(item)}
                className="block w-full rounded-xl px-3 py-2 text-left transition hover:bg-zinc-50"
              >
                <span className="block truncate text-sm font-medium text-zinc-950">{item.keyword}</span>
                <span className="mt-0.5 block text-xs text-zinc-500">{item.createdAt}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderLookbookPlaceholder(name: string) {
    const seconds = Math.floor(lookbookElapsedMs / 1000);
    // 한 번의 호출 안에서 이미지 생성 → 명세 비교가 이어지므로, 경과 시간으로 현재 단계를 안내 (예상)
    const phase = seconds < 25 ? 0 : 1;
    const phases = ["룩북 이미지 생성", "이미지와 착장 명세 비교"];
    return (
      <div className="lookbook-placeholder mt-2" role="status" aria-live="polite">
        <div className="lookbook-shimmer" />
        <div className="lookbook-placeholder-body">
          <span className="h-9 w-9 animate-spin rounded-full border-[3px] border-zinc-300 border-t-black" />
          <p className="mt-4 text-sm font-semibold text-black">{name} 룩북을 만들고 있어요</p>
          <p className="mt-1 text-xs text-zinc-500">보통 20~60초 걸려요 · {seconds}초 경과</p>
          <ol className="mt-4 flex items-center gap-2 text-[11px]">
            {phases.map((label, index) => (
              <li key={label} className={index === phase ? "lookbook-phase lookbook-phase-active" : index < phase ? "lookbook-phase lookbook-phase-done" : "lookbook-phase"}>
                <span className="lookbook-phase-dot" />
                {label}
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }

  function renderLookbookCard(v: Variant, variantIndex: number) {
    const isRefining = refiningIndex === variantIndex;
    const evaluation = evaluationById.get(v.concept.id ?? v.concept.name);
    const isScoreOpen = openScoreIndex === variantIndex;
    return (
      <article key={`${v.concept.id ?? v.concept.name}-${variantIndex}`} className="min-w-0 rounded-lg border border-zinc-200 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="break-keep text-lg font-semibold text-black dark:text-zinc-50">{v.concept.name}</h3>
          {evaluation && (
            <button
              type="button"
              onClick={() => setOpenScoreIndex(isScoreOpen ? null : variantIndex)}
              aria-expanded={isScoreOpen}
              className="shrink-0 border border-zinc-300 bg-white px-2 py-1 text-xs font-semibold text-zinc-700 transition hover:border-zinc-900 hover:text-black"
            >
              {evaluation.totalScore}점
            </button>
          )}
        </div>
        {evaluation && isScoreOpen && (
          <div className="mt-3 border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
              <span>사용자 요구 · {evaluation.requestScore}점</span>
              <span>날씨 · {evaluation.weatherScore}점</span>
              <span>장소·상황 · {evaluation.placeScore}점</span>
              <span>체형·핏 · {evaluation.bodyFitScore}점</span>
              <span>트렌드·소재 · {evaluation.trendScore}점</span>
              <span>색 조화 · {evaluation.colorScore}점</span>
              <span>실용성 · {evaluation.practicalityScore}점</span>
            </div>
          </div>
        )}
        {v.imageUrl ? (
          <div className="relative mt-2 overflow-hidden bg-zinc-50">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={v.imageUrl} alt={`${v.concept.name} 룩북`} className={`w-full transition-opacity ${isRefining ? "opacity-40" : "opacity-100"}`} />
            {isRefining && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/70 text-center">
                <span className="h-7 w-7 animate-spin rounded-full border-2 border-zinc-300 border-t-black" />
                <p className="mt-3 text-sm font-semibold text-black">수정 중이에요</p>
                <p className="mt-1 px-4 text-xs text-zinc-500">요청한 부분을 반영해 룩북을 다시 만들고 있어요.</p>
              </div>
            )}
          </div>
        ) : v.lookbookError ? (
          <p className="mt-2 bg-red-50 p-3 text-sm text-red-700">✗ 이미지 생성 실패: {v.lookbookError}</p>
        ) : (
          renderLookbookPlaceholder(v.concept.name)
        )}

        {v.imageUrl && (
          <div className="mt-2 border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-600">
            <p className="font-medium text-zinc-900">{v.lookbookVerified ? "이미지와 착장 명세 비교 완료" : v.lookbookMismatches.length ? "스타일 시안 · 일부 항목 확인 필요" : "스타일 시안 · 이미지 비교 미완료"}</p>
            {v.lookbookMismatches.length > 0 && <p className="mt-1">{v.lookbookMismatches.join(" / ")}</p>}
          </div>
        )}
        <div className="mt-4 border-t border-zinc-200 pt-3">
          <p className="text-sm font-medium text-black dark:text-zinc-50">{v.concept.description}</p>
          <div className="mt-3 grid gap-1 text-xs text-zinc-500">
            <p className="break-words">무드: {v.concept.mood}</p>
            <p className="break-words">색감: {v.concept.colorPalette.join(", ")}</p>
            <p className="break-words">핏: {v.concept.fitStrategy || "상황 무드에 맞춘 현실적인 핏"}</p>
            <p className="break-words">아이템: {(v.concept.outfitItems ?? []).join(", ")}</p>
            <p className="break-words">원단/질감: {(v.finalMaterials ?? v.concept.materials).join(", ")}</p>
          </div>
        </div>

        <div className="mt-4 border-t border-zinc-200 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-violet-600">비슷한 옷 구매 링크</p>
            <button
              type="button"
              onClick={() => findShoppingLinks(variantIndex)}
              disabled={v.shoppingLoading || isBusy}
              className="rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {v.shoppingLoading ? "검색 중..." : v.shoppingLinks.length ? "다시 찾기" : "비슷한 상품 찾기"}
            </button>
          </div>
          {v.shoppingLoading && <div className="mt-2 flex items-center justify-between gap-3 text-xs text-zinc-600">
            <p role="status">이 룩의 상품 상세페이지를 확인하고 있어요.</p>
            <button type="button" onClick={() => cancelVariantShopping(v)} className="shrink-0 underline">검색 취소</button>
          </div>}
          {v.shoppingMissingItems.length > 0 && !v.shoppingLoading && <p className="mt-2 text-xs text-zinc-600">아직 찾지 못한 품목: {v.shoppingMissingItems.join(", ")}</p>}
          {v.shoppingLinks.length > 0 ? (
            <div className="mt-2 flex flex-col gap-2">
              {v.shoppingError && <p role="status" className="text-xs leading-relaxed text-zinc-600">{v.shoppingError}</p>}
              {v.shoppingLinks.map((link, linkIndex) => (
                <a key={`${link.url}-${linkIndex}`} href={link.url} target="_blank" rel="noreferrer" className="min-w-0 overflow-hidden rounded-md bg-zinc-50 p-3 text-sm transition hover:bg-zinc-100">
                  {link.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={link.imageUrl} alt={link.title} loading="lazy" referrerPolicy="no-referrer" className="mb-2 h-28 w-24 border border-zinc-200 bg-white object-contain" />
                  )}
                  <span className="block break-words text-xs font-semibold text-violet-600">{[link.category, link.item, link.source].filter(Boolean).join(" · ")}</span>
                  <span className="mt-1 block break-words font-medium leading-snug text-black">상품 후보 · {link.title}</span>
                  {link.price && <span className="mt-1 block text-xs text-zinc-700">{link.price}</span>}
                  <span className="mt-1 block text-xs font-medium text-zinc-700">{link.visualStatus === "verified" ? "룩북·상품 사진의 주요 특징 비교 완료" : "상품 후보 · 사진 비교 미완료"}</span>
                  <span className="mt-1 block break-keep text-xs leading-relaxed text-zinc-500">{link.verificationNotice || link.reason}</span>
                  {!!link.visualDifferences?.length && <span className="mt-1 block text-xs text-amber-800">{link.visualDifferences.join(" / ")}</span>}
                </a>
              ))}
            </div>
          ) : v.shoppingError ? (
            <p role="status" className="mt-2 bg-zinc-50 p-3 text-sm text-zinc-700">{v.shoppingError}</p>
          ) : v.imageUrl ? (
            <p className="mt-2 text-sm text-zinc-500">버튼을 누르면 이 룩의 착용 아이템과 비슷한 상품을 찾아요.</p>
          ) : null}
        </div>
      </article>
    );
  }

  const candidates = candidateList();
  const evaluationById = new Map((evaluationProcess?.round2 ?? []).map((item) => [item.id, item]));
  const isSearchScreen = screen === "search";
  const isFixedWorkspace = screen === "chat" || screen === "candidates";
  const latestAssistantId = [...chatMessages].reverse().find((message) => message.role === "assistant")?.id;

  return (
    <div className={`retro-page font-sans ${isFixedWorkspace ? "h-[100dvh] overflow-hidden" : "min-h-screen"}`}>
      {loadingPhase !== "hidden" && <LoadingScreen phase={loadingPhase} currentStep={step} />}

      {screen === "search" && <section className="retro-hero relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden px-5 py-8">
        <header className="style-header w-full max-w-6xl">
          <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-400">AI Fashion Planning Agent</div>
          <h1 className="retro-title">DDP PARK SAJANG</h1>
          <nav className="style-nav" aria-label="서비스 메뉴">
            <span>WEATHER</span><span>CONCEPT</span><span>LOOKBOOK</span><span>SHOPPING</span>
          </nav>
        </header>

        {isSearchScreen ? (
          <div className="relative mt-12 w-full max-w-3xl">
            <form className="style-search flex gap-2" onSubmit={(event) => { event.preventDefault(); void startConversation(); }}>
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="예: 날짜·장소·약속·원하는 분위기를 자유롭게 입력"
                className="flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-950 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none"
                disabled={isBusy}
                autoFocus
              />
              <button type="submit" disabled={isBusy || !keyword.trim()} className="flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-zinc-950 px-5 py-3 font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40">
                {isBusy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
                {isBusy ? "분석 중" : "생성"}
              </button>
            </form>
            {renderHistory()}
            <p className="mt-5 text-center text-xs text-zinc-500">입력 후 엔터를 누르면 에이전트와 단계별로 상의할 수 있어요.</p>
          </div>
        ) : (
          <div className="mt-6 w-full max-w-5xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 text-xs text-zinc-500"><span className="font-semibold text-zinc-900">현재 요청</span> · <span className="break-keep">{keyword}</span></div>
              <button type="button" onClick={resetForNewSearch} className="rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-zinc-900">새 검색</button>
            </div>
          </div>
        )}
        {error && <p className="relative mt-4 max-w-2xl px-6 text-center text-red-600">{error}</p>}
      </section>}

      {!isSearchScreen && (
        <main ref={resultsRef} className={`mx-auto flex w-full flex-col gap-4 ${screen === "chat" ? "h-[100dvh] max-w-6xl overflow-hidden px-4 py-4" : screen === "candidates" ? "h-[100dvh] max-w-7xl overflow-hidden px-6 py-4" : "min-h-screen max-w-7xl gap-6 px-6 py-10"}`}>
          {screen === "chat" ? (
            <div className="flex shrink-0 items-center justify-between gap-3 px-1 text-xs text-zinc-500">
              <span className="truncate"><span className="font-semibold text-zinc-900">DDP PARK SAJANG</span> · 현재 스타일 상담</span>
              <button type="button" onClick={resetForNewSearch} className="shrink-0 rounded-xl bg-black px-3 py-2 text-xs font-medium text-white transition hover:bg-zinc-800">재검색</button>
            </div>
          ) : null}

          {screen === "chat" && (
            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <section className="flex min-h-0 flex-col rounded-lg border border-zinc-200 bg-white p-4">
              <div className="border-b border-zinc-200 pb-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">STYLE CONSULTATION</p>
                    <h2 className="mt-2 text-xl font-semibold text-black">이번 룩의 방향을 같이 정해볼게요</h2>
                  </div>
                  <span className="hidden border border-zinc-200 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-zinc-400 sm:inline">LIVE</span>
                </div>
                <p className="mt-1 text-sm text-zinc-500">필요한 조건만 짧게 정하고, 준비되면 바로 후보를 볼 수 있어요.</p>
              </div>
              <div ref={chatScrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain py-6 pr-2">
                {chatMessages.map((message) => {
                  const showOptions = message.role === "assistant"
                    && message.id === latestAssistantId
                    && Boolean(message.options?.length)
                    && !isBusy;
                  const showApplyButton = message.role === "assistant"
                    && message.id === latestAssistantId
                    && message.stage !== "ready"
                    && conversationStage !== "ready"
                    && message.allowQuickApply === true
                    && !isBusy;
                  return (
                    <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={message.role === "user" ? "max-w-[85%] rounded-2xl rounded-br-md bg-black px-4 py-3 text-sm leading-relaxed text-white" : "max-w-[85%] rounded-2xl rounded-bl-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm leading-relaxed text-zinc-700"}>
                        {message.role === "assistant" && <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400">DDP PARK SAJANG · {message.stage === "weather" ? "WEATHER" : message.stage === "place" ? "CONCEPT" : message.stage === "fit" ? "FIT" : message.stage === "material" ? "MATERIAL" : "PLAN"}</p>}
                        <p className="whitespace-pre-wrap break-keep">{message.text}</p>
                        {(showOptions || showApplyButton) && (() => {
                          const cards = showOptions && message.options?.length
                            ? message.options
                            : quickApplyOptions(message.stage, keyword);
                          return (
                            <div className="mt-3 grid gap-2 sm:grid-cols-3">
                              {cards.map((option) => (
                                <button
                                  key={option.label}
                                  type="button"
                                  onClick={() => void submitConversationFeedback(option.label)}
                                  className={
                                    option.primary
                                      ? "consult-option consult-option-primary"
                                      : "consult-option"
                                  }
                                >
                                  <span className="block text-sm font-semibold">{option.label}</span>
                                  {option.detail && <span className="mt-1 block text-xs leading-relaxed opacity-80 break-keep">{option.detail}</span>}
                                </button>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
                {isBusy && <p className="flex items-center gap-2 text-sm text-zinc-400"><span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700" />에이전트가 컨텍스트를 정리하고 있어요...</p>}
              </div>
              <form className="style-search flex gap-2" onSubmit={(event) => { event.preventDefault(); void submitConversationFeedback(); }}>
                <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder={isBusy ? "분석 중..." : "원하는 소재, 색감, 핏이나 수정 의견을 말해주세요"} className="flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-950 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none" disabled={isBusy} />
                <button type="submit" disabled={isBusy || !chatInput.trim()} className="rounded-xl bg-black px-4 py-3 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-40">보내기</button>
                {conversationStage !== "ready" && (
                  <button type="button" onClick={() => void submitConversationFeedback("추천해줘")} disabled={isBusy} className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-medium text-zinc-700 transition hover:border-zinc-900 hover:text-black disabled:opacity-40">추천해줘</button>
                )}
              </form>
              {trend && !isBusy && (
                <button type="button" onClick={() => void generateCandidates()} className="mt-3 w-full rounded-xl bg-black px-4 py-3 text-sm font-medium text-white transition hover:bg-zinc-800">{conversationStage === "ready" ? "5개 후보 생성하기" : "이 조건으로 5개 후보 보기"}</button>
              )}
            </section>
            <aside className="flex min-h-0 max-h-64 flex-col border border-zinc-200 bg-white p-4 lg:max-h-none">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">STYLE MEMORY</p>
              <h2 className="mt-2 text-base font-semibold text-black">확정된 방향</h2>
              <p className="mt-1 break-keep text-xs leading-relaxed text-zinc-500">대화에서 정해진 요구와 코디 반영 내용을 기록합니다.</p>
              <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto border-t border-zinc-200 pt-4 pr-1">
                {planningLog.length ? planningLog.map((item) => (
                  <article key={item.id} className="border-l-2 border-zinc-300 pl-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400">{item.label}</p>
                    <p className="mt-1 break-keep text-xs leading-relaxed text-zinc-700"><span className="font-semibold text-black">{item.userLabel}</span> · {item.userText}</p>
                    <p className="mt-1 break-keep text-xs leading-relaxed text-zinc-500"><span className="font-semibold text-zinc-700">추천 방향</span> · {item.agentText}</p>
                  </article>
                )) : <p className="text-xs text-zinc-400">대화가 진행되면 확정된 스타일 방향이 쌓입니다.</p>}
              </div>
            </aside>
            </div>
          )}

          {screen === "candidates" && evaluationProcess && (
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white p-4">
              <div className="mb-4 flex shrink-0 justify-end gap-2">
                <button type="button" onClick={resetForNewSearch} className="rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-zinc-900">재검색</button>
              </div>
              <div className="shrink-0 border-b border-zinc-200 pb-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">CANDIDATE RANKING</p>
                <h2 className="mt-2 text-xl font-semibold text-black">{candidates.length}개 후보에서 룩북으로 볼 안을 골라주세요</h2>
                <p className="mt-1 text-sm text-zinc-500">{evaluationProcess.evaluationStage === "repaired" ? "보완 후 평가" : "현재 확보한 후보의 평가"} 순서입니다. 선택한 {selectedCandidateIds.length}개를 이미지로 생성합니다.</p>
              </div>
              <div className="mt-5 max-w-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm leading-relaxed text-zinc-700">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400">DDP PARK SAJANG · PLAN</p>
                {evaluationProcess.planStatus === "partial" ? "보완을 마치지 못한 항목이 있어 먼저 확보한 대안을 보여드려요. 원하는 후보를 선택하면 바로 룩북을 만들 수 있어요." : "아이템 조합과 요청 반영 정도를 비교했어요. 원하는 후보를 선택하면 룩북을 만들 수 있어요."}
                {(evaluationProcess.warnings ?? []).map((warning, index) => <p role="status" key={index} className="mt-2 text-xs">{warning}</p>)}
              </div>
              <div className="mt-4 shrink-0 border border-zinc-200 bg-white">
                <button
                  type="button"
                  onClick={() => setIsCandidatePlanOpen((open) => !open)}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm font-medium text-zinc-800 transition hover:bg-zinc-50"
                  aria-expanded={isCandidatePlanOpen}
                >
                  <span>이번 후보에 반영한 방향</span>
                  <span className="text-xs text-zinc-500">{isCandidatePlanOpen ? "접기" : "열어보기"}</span>
                </button>
                {isCandidatePlanOpen && (
                  <div className="max-h-48 overflow-y-auto border-t border-zinc-200 bg-zinc-50 px-4 py-3">
                    {planningLog.length ? (
                      <div className="space-y-3">
                        {planningLog.map((item) => (
                          <article key={`candidate-${item.id}`} className="border-l-2 border-zinc-300 pl-3">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400">{item.label}</p>
                          <p className="mt-1 break-keep text-xs leading-relaxed text-zinc-600"><span className="font-semibold text-zinc-900">{item.userLabel}</span> · {item.userText}</p>
                            <p className="mt-1 break-keep text-xs leading-relaxed text-zinc-500"><span className="font-semibold text-zinc-700">추천 방향</span> · {item.agentText}</p>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-zinc-500">대화에서 확정된 방향이 없습니다. 기본 전략으로 후보를 구성했어요.</p>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2">
                <div className="grid gap-3 md:grid-cols-2">
                {candidates.map((candidate) => {
                  const id = candidate.id ?? candidate.name;
                  const evaluation = evaluationById.get(id);
                  const selected = selectedCandidateIds.includes(id);
                  return (
                    <button key={id} type="button" onClick={() => toggleCandidate(id)} aria-pressed={selected} className={selected ? "candidate-card candidate-card-selected text-left p-4" : "candidate-card text-left p-4"}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <span className="candidate-check" aria-hidden="true">
                            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M4 10.5l4 4 8-9" />
                            </svg>
                          </span>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-400">{evaluation?.rank ?? "-"}위{evaluationProcess.finalConcepts.some((item) => (item.id ?? item.name) === id) ? " · 에이전트 추천" : ""}</p>
                            <h3 className="mt-1 break-keep text-base font-semibold text-black">{candidate.name}</h3>
                          </div>
                        </div>
                        <span className="shrink-0 bg-black px-2 py-1 text-xs font-semibold text-white">{evaluation?.totalScore ?? 0}점</span>
                      </div>
                      <p className="mt-2 break-keep text-sm leading-relaxed text-zinc-600">{candidate.description}</p>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
                        <span className="border border-zinc-200 px-2 py-1">무드 · {candidate.mood}</span>
                        <span className="border border-zinc-200 px-2 py-1">핏 · {candidate.fitStrategy || "상황 무드 기반 핏"}</span>
                      </div>
                      <p className="mt-3 break-keep text-xs text-zinc-500">핵심 아이템 · {(candidate.outfitItems ?? []).join(", ")}</p>
                      <p className="mt-2 break-keep text-xs text-zinc-600">{evaluation?.decisionReason}</p>
                      {evaluationProcess.planStatus === "partial" && Boolean(evaluation?.failureReasons.length) && <p className="mt-2 break-keep text-xs text-zinc-500">보완할 점 · {evaluation?.failureReasons.slice(0, 2).join(" / ")}</p>}
                      <p className="mt-3 text-xs font-medium text-zinc-700">{selected ? "룩북 생성 대상으로 선택됨" : "눌러서 룩북 대상에 포함"}</p>
                    </button>
                  );
                })}
                </div>
              </div>
              <div className="mt-5 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-4">
                <p className="text-sm text-zinc-500">{evaluationProcess.planStatus === "partial" ? "점수는 확보한 명세의 비교값입니다. 완료하지 못한 검증은 통과로 처리하지 않았어요." : "평가와 보완 과정을 실행 기록에서 확인할 수 있어요."}</p>
                <button type="button" onClick={() => void generateSelectedLooks()} disabled={isBusy || selectedCandidateIds.length === 0} className="rounded-xl bg-black px-4 py-3 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-40">선택한 {selectedCandidateIds.length}개 룩북 보기</button>
              </div>
            </section>
          )}

          {screen === "final" && (
            <section className="grid gap-5 lg:h-[calc(100dvh-7rem)] lg:min-h-[620px] lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="flex justify-end gap-2 lg:col-span-2">
                <button type="button" onClick={goBackToCandidates} className="rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-zinc-900">후보 다시 고르기</button>
                <button type="button" onClick={resetForNewSearch} className="rounded-xl bg-black px-3 py-2 text-xs font-medium text-white transition hover:bg-zinc-800">재검색</button>
              </div>
              <div className="min-h-0 overflow-y-auto pr-2">
                {evaluationProcess?.planStatus === "partial" && <p role="status" className="mb-3 border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">대안 후보로 만든 룩북이에요. {(evaluationProcess.warnings ?? []).join(" ")}</p>}
                <div className="grid min-w-0 gap-5 md:grid-cols-2">{variants.map(renderLookbookCard)}</div>
              </div>
              <aside className="min-h-0 min-w-0 overflow-y-auto border border-zinc-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">LOOK REFINEMENT</p>
                <h2 className="mt-2 text-base font-semibold text-black">선택한 룩을 대화로 다듬어보세요</h2>
                <p className="mt-1 break-keep text-xs leading-relaxed text-zinc-500">레이어링, 소재, 색감, 핏처럼 바꾸고 싶은 부분을 자유롭게 말하면 해당 룩만 수정합니다.</p>

                <div className="mt-4 border border-zinc-200 bg-white">
                  <button
                    type="button"
                    onClick={() => setIsFinalPlanOpen((open) => !open)}
                    className="flex w-full items-center justify-between gap-4 px-3 py-3 text-left text-xs font-medium text-zinc-800 transition hover:bg-zinc-50"
                    aria-expanded={isFinalPlanOpen}
                  >
                    <span>사용자 요구와 코디 반영 내용</span>
                    <span className="text-zinc-500">{isFinalPlanOpen ? "접기" : "열어보기"}</span>
                  </button>
                  {isFinalPlanOpen && (
                    <div className="max-h-48 overflow-y-auto border-t border-zinc-200 bg-zinc-50 p-3">
                      {planningLog.length ? (
                        <div className="space-y-3">
                          {planningLog.map((item) => (
                            <article key={`final-${item.id}`} className="border-l-2 border-zinc-300 pl-3">
                              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400">{item.label}</p>
                              <p className="mt-1 break-keep text-xs leading-relaxed text-zinc-600"><span className="font-semibold text-zinc-900">{item.userLabel}</span> · {item.userText}</p>
                              <p className="mt-1 break-keep text-xs leading-relaxed text-zinc-500"><span className="font-semibold text-zinc-700">추천 방향</span> · {item.agentText}</p>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-zinc-500">기록된 추가 요구가 없습니다. 기본 전략으로 구성했어요.</p>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-4 grid gap-2">
                  {variants.map((variant, index) => (
                    <button
                      key={`${variant.concept.id ?? variant.concept.name}-refine`}
                      type="button"
                      onClick={() => setSelectedRefineIndex(index)}
                      className={selectedRefineIndex === index ? "border border-black bg-black px-3 py-2 text-left text-xs text-white" : "border border-zinc-200 bg-white px-3 py-2 text-left text-xs text-zinc-700 transition hover:border-zinc-900"}
                    >
                      {variant.concept.name}
                    </button>
                  ))}
                </div>

                <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4">
                  {refinementMessages.length ? refinementMessages.map((message) => (
                    <div key={message.id} className={message.role === "user" ? "ml-5 bg-black px-3 py-2 text-xs leading-relaxed text-white" : "mr-5 border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-700"}>
                      <p className="whitespace-pre-wrap break-keep">{message.text}</p>
                    </div>
                  )) : (
                    <p className="border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">바꾸고 싶은 부분을 말해주세요. 상의·하의·신발 교체나 레이어링도 대화로 조정할 수 있어요.</p>
                  )}
                </div>

                <form className="mt-4" onSubmit={(event) => { event.preventDefault(); void refineSelectedLook(); }}>
                  <textarea
                    value={refineInput}
                    onChange={(event) => setRefineInput(event.target.value)}
                    placeholder="예: 아우터를 더 짧고 가벼운 재킷으로 바꿔줘"
                    className="min-h-24 w-full resize-y border border-zinc-200 bg-white px-3 py-3 text-xs leading-relaxed text-zinc-950 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none"
                    disabled={isBusy}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="submit" disabled={isBusy || !refineInput.trim()} className="flex-1 bg-black px-3 py-2 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:opacity-40">수정 반영</button>
                    <button type="button" onClick={undoSelectedLook} disabled={isBusy || !(variantHistory[variants[selectedRefineIndex]?.concept.id ?? variants[selectedRefineIndex]?.concept.name] ?? []).length} className="border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-600 transition hover:border-zinc-900 disabled:cursor-not-allowed disabled:opacity-40">↶ 되돌리기</button>
                  </div>
                </form>
              </aside>
            </section>
          )}
        </main>
      )}

      <button type="button" onClick={() => setIsTraceOpen(true)} className="fixed bottom-24 right-5 z-30 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-zinc-700 shadow-lg transition hover:border-zinc-900" aria-expanded={isTraceOpen}>Agent Trace</button>
      {isTraceOpen && (
        <div className="fixed inset-0 z-40 bg-black/10" onClick={() => setIsTraceOpen(false)}>
          <aside className="absolute inset-y-4 right-4 flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden border border-zinc-300 bg-[#f7f6f3] shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
              <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">AGENT TRACE</p><p className="mt-1 text-sm text-zinc-700">심사용 Tool 호출·검증 진행</p></div>
              <button type="button" onClick={() => setIsTraceOpen(false)} className="rounded-xl bg-black px-3 py-2 text-xs font-medium text-white">닫기</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3"><AgentTracePanel step={step} evaluationProcess={evaluationProcess} trace={agentTrace} /></div>
          </aside>
        </div>
      )}
    </div>
  );
}
