/** 후보/평가 공용 타입 및 정규화 — /api/plan 과 프론트가 같은 계약을 쓴다. */
export type Concept = {
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

export type Evaluation = {
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

export type ParsedRequest = {
  date: string;          // ISO yyyy-mm-dd
  dateInferred: boolean;
  place: string;
  occasion: string;
  gender: "남성" | "여성";
  heightCm: number | null;
  weightKg: number | null;
  constraints: string[];
  focusCategories: string[];
};

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function toNumber(value: unknown, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

export function toStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

export function normalizeConcepts(value: unknown, fallbackGender = "남성") {
  return asArray<Record<string, unknown>>(value)
    .slice(0, 5)
    .map((item, index): Concept => ({
      id: String(item.id ?? `look_${String(index + 1).padStart(2, "0")}`),
      name: String(item.name ?? `후보 ${index + 1}`),
      description: String(item.description ?? ""),
      mood: String(item.mood ?? ""),
      colorPalette: toStringArray(item.colorPalette),
      targetCustomer: String(item.targetCustomer ?? fallbackGender),
      materials: toStringArray(item.materials),
      outfitItems: toStringArray(item.outfitItems),
      bodyProfile: String(item.bodyProfile ?? ""),
      fitStrategy: String(item.fitStrategy ?? ""),
      stylingReason: String(item.stylingReason ?? ""),
    }));
}

export function normalizeEvaluations(value: unknown, concepts: Concept[]) {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const byName = new Map(concepts.map((c) => [c.name, c]));
  return asArray<Record<string, unknown>>(value).map((item, index): Evaluation => {
    const matched = byId.get(String(item.id ?? "")) ?? byName.get(String(item.name ?? "")) ?? concepts[index];
    const weatherScore = toNumber(item.weatherScore);
    const placeScore = toNumber(item.placeScore);
    const bodyFitScore = toNumber(item.bodyFitScore);
    const trendScore = toNumber(item.trendScore);
    const practicalityScore = toNumber(item.practicalityScore);
    const computedTotal = Math.round((weatherScore + placeScore + bodyFitScore + trendScore + practicalityScore) / 5);
    return {
      id: matched?.id ?? String(item.id ?? `look_${String(index + 1).padStart(2, "0")}`),
      name: matched?.name ?? String(item.name ?? `후보 ${index + 1}`),
      weatherScore, placeScore, bodyFitScore, trendScore, practicalityScore,
      totalScore: computedTotal,
      failureReasons: toStringArray(item.failureReasons),
      revisionPlan: toStringArray(item.revisionPlan),
      decisionReason: typeof item.decisionReason === "string" ? item.decisionReason : undefined,
    };
  });
}

export function rankEvaluations(evaluations: Evaluation[]) {
  return [...evaluations]
    .sort((a, b) =>
      b.totalScore - a.totalScore ||
      b.trendScore - a.trendScore ||
      b.bodyFitScore - a.bodyFitScore ||
      b.weatherScore - a.weatherScore ||
      a.name.localeCompare(b.name, "ko"))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export function applyFinalDecisions(evaluations: Evaluation[], finalIds: Set<string>) {
  return rankEvaluations(evaluations).map((item) => {
    const selected = finalIds.has(item.id);
    const fallback = selected
      ? `${item.rank}위, 최종 평가 총점 ${item.totalScore}점으로 상위 2개 안에 들어 룩북 후보로 선택됐어요.`
      : `${item.rank}위, 최종 평가 총점 ${item.totalScore}점으로 상위 2개보다 낮아 룩북에서는 제외됐어요.`;
    return {
      ...item,
      decisionStatus: selected ? "선택" : "탈락",
      decisionReason: item.decisionReason?.trim() ? `${item.rank}위 · ${item.decisionReason}` : fallback,
    } satisfies Evaluation;
  });
}
