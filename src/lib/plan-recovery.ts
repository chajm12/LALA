import { sanitizeCoreConcept } from "./garments";

export type PlanningStage = "initial" | "repaired" | "fallback";
export type CandidateSource = "model" | "local_fallback";

/** Commit a stage only after it is usable. Failed repair must not erase an earlier batch. */
export async function recoverPlanning<C, E>(steps: {
  generate: () => Promise<C[]>;
  fallback: () => C[];
  validate: (candidates: C[]) => void;
  evaluate: (candidates: C[], round: 1 | 2) => E[];
  repair: (candidates: C[], evaluations: E[], diversity: boolean) => Promise<C[]>;
  needsDiversity: (candidates: C[]) => boolean;
  onFailure?: (stage: "generate" | "repair" | "diversity", error: unknown) => void;
}) {
  const warnings: string[] = [];
  let candidateSource: CandidateSource = "model";
  let evaluationStage: PlanningStage = "initial";
  let originalCandidates: C[];
  try {
    originalCandidates = await steps.generate();
    steps.validate(originalCandidates);
  } catch (error) {
    steps.onFailure?.("generate", error);
    originalCandidates = steps.fallback();
    steps.validate(originalCandidates);
    candidateSource = "local_fallback";
    evaluationStage = "fallback";
    warnings.push("AI 후보 생성을 완료하지 못해 요청 조건에 맞춘 기본 조합을 준비했어요. 실제 상품 확인 전 스타일 제안입니다.");
  }
  const round1 = steps.evaluate(originalCandidates, 1);
  let candidates = originalCandidates;
  let evaluations = round1;
  if (candidateSource === "model") {
    try {
      const repaired = await steps.repair(candidates, evaluations, false);
      steps.validate(repaired);
      const rescored = steps.evaluate(repaired, 2);
      candidates = repaired;
      evaluations = rescored;
      evaluationStage = "repaired";
    } catch (error) {
      steps.onFailure?.("repair", error);
      warnings.push("후보 보완을 완료하지 못해 1차 후보와 평가로 추천을 이어가요. 확인이 필요한 부분은 각 후보에 표시했어요.");
    }
    if (evaluationStage === "repaired" && steps.needsDiversity(candidates)) {
      try {
        const distinct = await steps.repair(candidates, evaluations, true);
        steps.validate(distinct);
        const rescored = steps.evaluate(distinct, 2);
        candidates = distinct;
        evaluations = rescored;
      } catch (error) {
        steps.onFailure?.("diversity", error);
        warnings.push("후보 간 차이를 더 넓히는 보완은 완료하지 못했어요. 준비된 후보 중 다른 조합을 우선 골랐어요.");
      }
    }
  }
  if (steps.needsDiversity(candidates)) {
    warnings.push("일부 후보의 구성이 비슷해요. 색상·실루엣 차이를 비교해 골라주세요.");
  }
  return { originalCandidates, round1, candidates, evaluations, candidateSource, evaluationStage, warnings };
}

const COLORS: Array<{ name: string; aliases: string[] }> = [
  { name: "블랙", aliases: ["블랙", "검정색", "검정", "검은색", "검은", "black"] },
  { name: "화이트", aliases: ["화이트", "흰색", "흰", "white"] },
  { name: "네이비", aliases: ["네이비", "남색", "navy"] },
  { name: "베이지", aliases: ["베이지", "beige"] },
  { name: "그레이", aliases: ["그레이", "회색", "gray", "grey"] },
  { name: "브라운", aliases: ["브라운", "갈색", "brown"] },
  { name: "카키", aliases: ["카키", "올리브", "khaki"] },
];
const BRANDS: Array<{ name: string; aliases: string[] }> = [
  { name: "뉴발란스", aliases: ["뉴발란스", "new balance"] },
  { name: "컨버스", aliases: ["컨버스", "converse"] },
  { name: "나이키", aliases: ["나이키", "nike"] },
  { name: "아디다스", aliases: ["아디다스", "adidas"] },
  { name: "반스", aliases: ["반스", "vans"] },
  { name: "아식스", aliases: ["아식스", "asics"] },
];
const EXCLUDED_ITEMS = [
  ["데님", "청바지"], ["슬랙스"], ["스커트", "치마"], ["니트"],
  ["티셔츠", "반팔"], ["셔츠"], ["후드", "후디"], ["스니커즈", "운동화"],
  ["로퍼"], ["부츠"], ["아우터", "겉옷", "재킷", "자켓"],
  ["가방", "백팩", "크로스백"], ["모자", "볼캡"], ["액세서리", "악세사리"],
  ["가죽", "레더"], ["울", "모직"],
];

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scoped to the same short phrase, so '검정 제외, 흰색은 좋아' does not exclude white. */
export function excludesTerm(request: string, aliases: string[]) {
  return aliases.some((term) => new RegExp(
    `${escapePattern(term)}(?:색|계열)?(?:은|는|을|를|이|가|도)?\\s*(?:[^,.!?\\n]{0,8}?)?(?:싫|제외|금지|말고|빼|피해|피하|없이|안\\s*입|안\\s*신|원하지|좋아하지)`,
    "i",
  ).test(request));
}

export function requestedShoeBrands(request: string) {
  return BRANDS.filter((brand) => brand.aliases.some((alias) => request.toLowerCase().includes(alias))
    && !excludesTerm(request, brand.aliases)).map((brand) => brand.name);
}

export function explicitConstraintIssues(request: string, items: string[], checkShoeBrands = true) {
  const text = items.join(" ");
  const issues = [...COLORS.map((color) => color.aliases), ...EXCLUDED_ITEMS, ...BRANDS.map((brand) => brand.aliases)]
    .filter((aliases) => excludesTerm(request, aliases))
    .filter((aliases) => aliases.some((term) => text.toLowerCase().includes(term)))
    .map((aliases) => `제외 요청한 ${aliases[0]} 포함`);
  const brands = requestedShoeBrands(request);
  const shoes = items.filter((item) => /^신발\s*:/.test(item)).join(" ");
  if (checkShoeBrands && brands.length && !brands.some((brand) => shoes.includes(brand))) {
    issues.push(`요청한 신발 브랜드 ${brands.join(" 또는 ")} 미반영`);
  }
  return issues;
}

export type BackupConcept = {
  id: string; name: string; description: string; mood: string; colorPalette: string[];
  targetCustomer: string; materials: string[]; outfitItems: string[]; bodyProfile: string;
  fitStrategy: string; stylingReason: string;
};

/** Style specifications only: no invented product models, stock, prices, or body measurements. */
export function createBackupCandidates(request: string, weather: {
  forecastAvailable?: boolean;
  forecast?: { temperatureMin?: number | null; temperatureMax?: number | null };
} | null): BackupConcept[] {
  const colors = COLORS.filter((color) => !excludesTerm(request, color.aliases)).map((color) => color.name);
  if (!colors.length) throw new Error("제외한 색상을 피할 수 있는 기본 조합이 없어요. 사용할 색상 한 가지를 알려주세요.");
  const brands = requestedShoeBrands(request);
  const choose = (values: string[], index: number) => {
    const allowed = values.filter((value) => explicitConstraintIssues(request, [value], false).length === 0);
    if (!allowed.length) throw new Error("요청한 제외 조건을 지킬 수 있는 기본 조합이 없어요. 남길 의류 종류를 알려주세요.");
    return allowed[index % allowed.length];
  };
  const tops = ["레귤러 티셔츠", "옥스포드 셔츠", "여유 있는 니트", "스웨트셔츠", "스트라이프 티셔츠"];
  const bottoms = /스커트|치마/.test(request) && !excludesTerm(request, ["스커트", "치마"])
    ? ["A라인 스커트", "일자 스커트", "미디 스커트"]
    : ["스트레이트 데님 팬츠", "와이드 코튼 팬츠", "테이퍼드 슬랙스", "카고 팬츠", "일자 코튼 팬츠"];
  const minimum = weather?.forecastAvailable ? weather.forecast?.temperatureMin : null;
  const maximum = weather?.forecastAvailable ? weather.forecast?.temperatureMax : null;
  const layerUseful = typeof minimum === "number" && (minimum < 16 || (typeof maximum === "number" && maximum - minimum >= 9));
  const outerAllowed = !excludesTerm(request, ["아우터", "겉옷", "재킷", "자켓"]);
  const formal = /결혼|면접|회의|장례|포멀/.test(request) && !/캐주얼/.test(request);
  return Array.from({ length: 5 }, (_, index) => {
    const palette = [colors[index % colors.length], colors[(index + 2) % colors.length]];
    const top = choose(formal ? ["옥스포드 셔츠", "여유 있는 니트"] : tops, index);
    const bottom = choose(formal ? ["일자 슬랙스", "테이퍼드 슬랙스", "와이드 코튼 팬츠"] : bottoms, index);
    const shoe = brands.length ? `${brands[index % brands.length]} 스니커즈` : choose(formal ? ["로퍼", "미니멀 스니커즈"] : ["스니커즈", "러닝화", "로퍼"], index);
    const outfitItems = [`상의: ${palette[0]} ${top}`, `하의: ${palette[1]} ${bottom}`, `신발: ${palette[1]} ${shoe}`];
    if (outerAllowed && ((layerUseful && index % 2 === 0) || /아우터|겉옷|재킷|자켓/.test(request))) {
      outfitItems.push(`아우터: ${palette[1]} ${choose(["가벼운 재킷", "가디건", "얇은 오버셔츠"], index)}`);
    }
    const issues = explicitConstraintIssues(request, outfitItems);
    if (issues.length) throw new Error(`기본 조합에 요청과 충돌하는 항목이 있어요: ${issues.join(", ")}`);
    return {
      id: `look_${String(index + 1).padStart(2, "0")}`,
      name: `${["데일리", "릴랙스드", "단정한", "활동적인", "가벼운"][index]} 기본 조합`,
      description: "요청을 참고한 기본 스타일 제안", mood: formal ? "단정한 세미포멀" : "편안한 캐주얼",
      colorPalette: palette, targetCustomer: /여성|여자/.test(request) ? "여성" : /남성|남자/.test(request) ? "남성" : "성별 미지정",
      materials: ["상품별 소재 확인 필요"], outfitItems,
      bodyProfile: "입력한 신체 정보 참고, 실제 핏 미확인",
      fitStrategy: "상의와 하의에 여유를 둔 실루엣, 실측 확인 필요",
      stylingReason: `${top}와 ${bottom}에 ${shoe}를 맞췄어요.${outfitItems.length > 3 ? " 쌀쌀할 때 입고 낮에 벗을 겉옷을 더했어요." : ""} 실제 제품과 소재는 상품 검색에서 확인해요.`,
    };
  }).map(sanitizeCoreConcept);
}
