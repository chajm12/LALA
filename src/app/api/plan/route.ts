import { NextResponse } from "next/server";
import { ensureGarmentSpecs, garmentSpecText, type GarmentSpec } from "@/lib/garment-specs";
import { CORE_GARMENT_POLICY, coreGarmentCategory, normalizeCoreOutfitItems, sanitizeCoreConcept, sanitizeCoreText } from "@/lib/garments";
import { parseJsonObjectFromText } from "@/lib/openai";
import { getNvidiaClient, NVIDIA_PLAN_MODEL } from "@/lib/nvidia";
import { agentLog } from "@/lib/log";
import { conceptSimilarity, describeSimilarity } from "@/lib/similarity";
import { runObjectiveVerifiers, type WeatherSnapshot } from "@/lib/verifiers";
import { recoverPlanning, createBackupCandidates, explicitConstraintIssues, requestedShoeBrands, excludesTerm } from "@/lib/plan-recovery";

type Concept = {
  id: string;
  name: string;
  description: string;
  mood: string;
  colorPalette: string[];
  targetCustomer: string;
  materials: string[];
  outfitItems: string[];
  garmentSpecs?: GarmentSpec[];
  bodyProfile: string;
  fitStrategy: string;
  stylingReason: string;
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

type SubjectiveEvaluation = Pick<
  Evaluation,
  "id" | "name" | "placeScore" | "bodyFitScore" | "trendScore" | "practicalityScore" | "failureReasons" | "revisionPlan"
>;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toNumber(value: unknown, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function scoreOrFallback(value: unknown, fallback = 70) {
  const score = toNumber(value, fallback);
  return score > 0 ? Math.max(0, Math.min(100, score)) : fallback;
}

function toStringArray(value: unknown, splitString = false) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return splitString
      ? value.split(/[,\n·|/]+/).map((item) => item.trim()).filter(Boolean)
      : [value.trim()];
  }
  return [];
}


function normalizeOutfitItems(item: Record<string, unknown>, index: number) {
  const raw = normalizeCoreOutfitItems(
    item.outfitItems ?? item.outfit ?? item.keyItems ?? item.lookItems ?? item.items,
  );
  const fallbackSets = [
    ["상의: 브러시드 코튼 셔츠", "하의: 세미와이드 팬츠", "신발: 미니멀 러닝화"],
    ["상의: 메리노 니트", "하의: 스트레이트 팬츠", "신발: 스웨이드 스니커즈"],
    ["상의: 옥스포드 셔츠", "하의: 테이퍼드 팬츠", "신발: 클래식 로퍼"],
    ["상의: 컴팩트 스웨트셔츠", "하의: 릴랙스드 팬츠", "신발: 레트로 스니커즈"],
    ["상의: 가벼운 폴로 니트", "하의: 와이드 팬츠", "신발: 가죽 스니커즈"],
  ];
  // Missing categories are completed independently; an outerwear item never counts as an inner top.
  const defaults = fallbackSets[index % fallbackSets.length];
  return normalizeCoreOutfitItems([...raw, ...defaults]);
}

function cleanConceptDescription(value: unknown) {
  return String(value ?? "")
    .replace(/\s*로\s+(?:남성|여성)\s*\d+안(?:을|를)?\s*제안해요\.?/g, "룩을 제안해요.")
    .replace(/\s+(?:남성|여성)\s*\d+안(?:을|를)?\s*제안해요\.?/g, " 룩을 제안해요.")
    .trim();
}

function normalizeConcepts(value: unknown, referenceConcepts: Concept[] = []) {
  return asArray<Record<string, unknown>>(value)
    .map((item, index): Concept => ({
      // Candidate identity is controlled by the planner, not by an LLM that
      // may copy the schema example and repeat the same id five times.
      id: referenceConcepts[index]?.id ?? `look_${String(index + 1).padStart(2, "0")}`,
      name: String(item.name ?? `후보 ${index + 1}`),
      description: cleanConceptDescription(item.description),
      mood: String(item.mood ?? ""),
      colorPalette: toStringArray(item.colorPalette),
      targetCustomer: String(item.targetCustomer ?? "남성"),
      materials: toStringArray(item.materials),
      outfitItems: normalizeOutfitItems(item, index),
      bodyProfile: String(item.bodyProfile ?? ""),
      fitStrategy: String(item.fitStrategy ?? ""),
      stylingReason: String(item.stylingReason ?? ""),
    })).map(sanitizeCoreConcept);
}

function extractConceptList(value: Record<string, unknown>) {
  if (Array.isArray(value.concepts)) return value.concepts;
  // Nemotron sometimes chooses the semantically equivalent `candidates` key
  // even when the prompt asks for `concepts`.
  if (Array.isArray(value.candidates)) return value.candidates;
  return [];
}

const SIMILARITY_LIMIT = 0.45;
const DIVERSITY_LAMBDA = 60;

function candidateSimilaritySummary(concepts: Concept[]) {
  const pairs: string[] = [];
  let maximum = 0;
  for (let i = 0; i < concepts.length; i += 1) {
    for (let j = i + 1; j < concepts.length; j += 1) {
      const similarity = conceptSimilarity(concepts[i], concepts[j]);
      maximum = Math.max(maximum, similarity);
      if (similarity >= SIMILARITY_LIMIT) {
        pairs.push(`${concepts[i].name} ↔ ${concepts[j].name}: ${similarity} (${describeSimilarity(similarity)})`);
      }
    }
  }
  return { maximum, pairs: pairs.length ? pairs : ["후보 간 유사도가 기준 이하입니다."] };
}

function directUserRequestText(keyword: string) {
  return keyword
    .split(/\r?\n/)
    .filter((line) => !/^\s*-?\s*에이전트 추천 반영\s*:/i.test(line))
    .join("\n")
    .trim();
}

const COLOR_ALIASES: Record<string, string[]> = {
  올리브: ["올리브", "그린", "포레스트", "딥 그린"],
  그린: ["그린", "올리브", "포레스트", "딥 그린"],
  차콜: ["차콜", "차콜 그레이"],
  그레이: ["그레이", "회색", "차콜", "멜란지"],
  크림: ["크림", "아이보리", "오프화이트"],
  아이보리: ["아이보리", "크림", "오프화이트"],
  핑크: ["핑크", "로즈", "베이비 핑크"],
  블루: ["블루", "파란", "페이디드 블루", "딥 블루"],
};

function avoidedColorTerms(keyword: string) {
  return Object.keys(COLOR_ALIASES).filter((term) => termRejected(keyword, term));
}

function replaceAvoidedColors(value: string, avoided: string[], replacement: string) {
  return avoided.reduce(
    (result, term) => COLOR_ALIASES[term].reduce((text, alias) => text.replaceAll(alias, replacement), result),
    value,
  );
}

function scoreUserRequestFit(keyword: string, concept: Concept) {
  const requestText = sanitizeCoreText(directUserRequestText(keyword));
  const conceptText = `${concept.name} ${concept.description} ${concept.mood} ${concept.colorPalette.join(" ")} ${concept.fitStrategy} ${concept.materials.join(" ")} ${concept.outfitItems.join(" ")}`;
  const requestedTerms = [
    "데님", "청바지", "슬랙스", "체크", "스트라이프", "가죽", "레더", "니트", "후드", "셔츠", "티셔츠",
    "스니커즈", "로퍼", "블라우스", "맨투맨", "오버핏", "세미오버", "슬림", "와이드", "테이퍼드", "캐주얼", "포멀", "스트릿", "시티보이",
    "블랙", "화이트", "흰색", "베이지", "네이비", "브라운", "그린", "올리브", "차콜", "그레이", "크림", "아이보리", "핑크", "블루", "버건디",
  ];
  const activeTerms = requestedTerms.filter((term) => requestText.includes(term) && !termRejected(requestText, term));
  const avoidedTerms = requestedTerms.filter((term) => termRejected(requestText, term));
  const aliases: Record<string, string[]> = {
    흰색: ["흰색", "화이트", "오프화이트", "아이보리"],
    화이트: ["흰색", "화이트", "오프화이트", "아이보리"],
    스니커즈: ["스니커즈", "러너", "운동화"],
    티셔츠: ["티셔츠", "그래픽 티", "반팔"],
    셔츠: ["셔츠", "오버셔츠", "셔츠 재킷"],
    데님: ["데님", "청바지", "인디고"],
    청바지: ["데님", "청바지", "인디고"],
    가죽: ["가죽", "레더", "그레인 레더"],
    레더: ["가죽", "레더", "그레인 레더"],
    나일론: ["나일론", "폴리에스터", "패커블"],
    블랙: ["블랙", "흑", "차콜", "잉크"],
    베이지: ["베이지", "샌드", "토프", "크림"],
    네이비: ["네이비", "잉크", "딥 블루"],
    브라운: ["브라운", "토프", "카멜"],
    ...COLOR_ALIASES,
    버건디: ["버건디", "와인", "딥 레드"],
    체크: ["체크", "타탄", "깅엄", "윈도페인"],
    스트라이프: ["스트라이프", "줄무늬"],
    후드: ["후드", "후드티", "후디"],
    맨투맨: ["맨투맨", "스웨트셔츠", "스웻셔츠"],
    로퍼: ["로퍼", "드라이빙 슈즈"],
    오버핏: ["오버핏", "오버사이즈", "루즈핏", "여유"],
    세미오버: ["세미오버", "세미 오버", "적당한 여유"],
    슬림: ["슬림", "슬림핏", "정돈된"],
    와이드: ["와이드", "와이드핏", "넓은"],
    테이퍼드: ["테이퍼드", "밑단이 좁아지는"],
    캐주얼: ["캐주얼", "캐주얼룩", "데일리", "스마트 캐주얼", "릴랙스", "편안", "스니커즈", "니트", "데님", "후드", "티셔츠"],
    포멀: ["포멀", "격식", "테일러드", "수트", "블레이저"],
    스트릿: ["스트릿", "스트리트", "그래픽", "스니커즈", "카고", "유틸리티", "워싱", "캡", "트랙", "나일론", "후드", "데님"],
    시티보이: ["시티보이", "도시적", "오버셔츠", "옥스포드"],
  };
  const matches = (term: string) => (aliases[term] ?? [term]).some((alias) => conceptText.includes(alias));
  const bottom = extractBottomConstraint(keyword);
  const alternativeBottomTerms = bottom?.mode === "alternatives" ? new Set(bottom.options) : new Set<string>();
  const constraints = [...new Set(activeTerms)]
    .filter((term) => !alternativeBottomTerms.has(term))
    .map((term) => ({ term, matched: matches(term) }));
  if (bottom?.mode === "alternatives") {
    constraints.push({
      term: "하의 대안",
      matched: bottom.options.some((option) => matches(option)),
    });
  }
  const avoidChecks = [...new Set(avoidedTerms)].map((term) => ({ term, matched: matches(term) }));
  if (!constraints.length && !avoidChecks.length) return 100;
  const total = constraints.length + avoidChecks.length;
  const satisfied = constraints.filter((item) => item.matched).length + avoidChecks.filter((item) => !item.matched).length;
  return Math.max(25, Math.min(100, Math.round((satisfied / total) * 100)));
}

function missingUserRequestTerms(keyword: string, concept: Concept) {
  const conceptText = `${concept.mood} ${concept.fitStrategy} ${concept.materials.join(" ")} ${concept.outfitItems.join(" ")}`;
  const aliases: Record<string, string[]> = {
    캐주얼: ["캐주얼", "캐주얼룩", "데일리", "스마트 캐주얼", "릴랙스", "편안", "스니커즈", "니트", "데님", "후드", "티셔츠"],
    스트릿: ["스트릿", "스트리트", "그래픽", "스니커즈", "카고", "유틸리티", "워싱", "캡", "트랙", "나일론", "후드", "데님"],
  };
  return Object.entries(aliases)
    .filter(([term]) => keyword.includes(term) && !termRejected(keyword, term))
    .filter(([, terms]) => !terms.some((term) => conceptText.includes(term)))
    .map(([term]) => term);
}

function assertCandidateSet(
  candidates: Concept[],
  keyword: string,
  stage: string,
) {
  if (candidates.length !== 5) {
    throw new Error(`${stage}에서 후보 ${candidates.length}개만 수신해 5개를 완성하지 못했습니다.`);
  }

  const incomplete = candidates.map((concept) => {
    const missing = [
      !concept.id ? "id" : "",
      !concept.name.trim() ? "name" : "",
      !concept.description.trim() ? "description" : "",
      !concept.mood.trim() ? "mood" : "",
      !concept.colorPalette.length ? "colorPalette" : "",
      !concept.materials.length ? "materials" : "",
      ["상의", "하의", "신발"].some((category) => !concept.outfitItems.some((item) => coreGarmentCategory(item) === category)) ? "outfitItems" : "",
      !concept.bodyProfile.trim() ? "bodyProfile" : "",
      !concept.fitStrategy.trim() ? "fitStrategy" : "",
      !concept.stylingReason.trim() ? "stylingReason" : "",
    ].filter(Boolean);
    return missing.length ? `${concept.name || concept.id || "이름 없음"}: ${missing.join(", ")}` : "";
  }).filter(Boolean);
  if (incomplete.length) {
    throw new Error(`${stage} 결과에 필수 스타일 정보가 빠져 있습니다 (${incomplete.join(" / ")}).`);
  }

  const duplicateNames = new Set<string>();
  const names = candidates.map((concept) => concept.name.trim());
  names.forEach((name) => {
    if (names.filter((candidate) => candidate === name).length > 1) duplicateNames.add(name);
  });
  if (duplicateNames.size) {
    throw new Error(`${stage} 결과에 중복된 룩 이름이 있습니다.`);
  }
  if (new Set(candidates.map((concept) => concept.id)).size !== candidates.length) {
    throw new Error(`${stage} 결과에 중복된 후보 식별자가 있습니다.`);
  }

  // Missing style preferences lower the score; they must not discard every result.
  // Explicit exclusions and requested shoe brands remain hard constraints.
  const conflicts = candidates.flatMap((concept) =>
    explicitConstraintIssues(keyword, concept.outfitItems).map((issue) => `${concept.name}: ${issue}`),
  );
  if (conflicts.length) throw new Error(`${stage} 요청 충돌: ${conflicts.join(" / ")}`);
}

type BottomConstraint = {
  options: string[];
  mode: "all" | "alternatives";
};

function termRejected(text: string, term: string) {
  const normalizedText = text.replace(/\s+/g, "");
  const normalizedTerm = term.replace(/\s+/g, "");
  const termIndex = normalizedText.indexOf(normalizedTerm);
  if (termIndex < 0) return false;
  const negativeMarkers = ["보다", "보단", "말고", "대신", "싫", "안좋", "좋아하지", "빼", "피하", "제외", "원하지"];
  return negativeMarkers.some((marker) => {
    const markerIndex = normalizedText.indexOf(marker);
    return markerIndex >= 0 && Math.abs(markerIndex - termIndex) <= 14;
  });
}

function extractBottomConstraint(keyword: string): BottomConstraint | null {
  const denim = /데님|청바지/.test(keyword) && !termRejected(keyword, "데님") && !termRejected(keyword, "청바지");
  const slacks = /슬랙스|슬랙/.test(keyword) && !termRejected(keyword, "슬랙스");
  const options = [denim ? "데님" : null, slacks ? "슬랙스" : null].filter((item): item is string => Boolean(item));
  if (!options.length || !/(하의|팬츠|바지|데님|청바지|슬랙스|슬랙)/.test(keyword)) return null;
  const alternatives = options.length > 1 && (
    keyword.includes("둘 다")
    || keyword.includes("둘다")
    || keyword.includes("모두")
    || keyword.includes("각각")
    || keyword.includes("각 코디")
    || keyword.includes("두 가지")
    || /데님과.*슬랙스|슬랙스와.*데님/i.test(keyword)
  );
  return { options, mode: alternatives ? "alternatives" : "all" };
}

function applyUserConstraints(candidates: Concept[], keyword: string) {
  // Keep inferred intent out of hard-constraint enforcement. It can guide the
  // model, but it must not make a candidate fail when the user never asked for
  // that specific item or style word.
  const requestText = sanitizeCoreText(directUserRequestText(keyword));
  const bottom = extractBottomConstraint(requestText);
  const avoidedColors = avoidedColorTerms(requestText);
  const whiteShoeRequested = !excludesTerm(requestText, ["화이트", "흰색"]) && /(?:신발|스니커즈|운동화|슈즈)[^\n,.]{0,24}(?:흰색|화이트|오프화이트)|(?:흰색|화이트|오프화이트)[^\n,.]{0,24}(?:신발|스니커즈|운동화|슈즈)/.test(requestText);
  const requestedTop = ["티셔츠", "반팔", "후드티", "후디", "맨투맨", "셔츠", "블라우스"].some((term) => requestText.includes(term) && !excludesTerm(requestText, [term]));
  const topLabel = /후드티|후디/.test(requestText) && !excludesTerm(requestText, ["후드티", "후디"])
    ? "후드티"
    : /맨투맨/.test(requestText) && !excludesTerm(requestText, ["맨투맨"])
      ? "맨투맨"
      : /티셔츠|반팔/.test(requestText) && !excludesTerm(requestText, ["티셔츠", "반팔"])
        ? "티셔츠"
        : /블라우스/.test(requestText) && !excludesTerm(requestText, ["블라우스"])
          ? "블라우스"
          : "셔츠";
  const shoeBrands = requestedShoeBrands(requestText);
  const streetRequested = /스트릿|스트리트/.test(requestText)
    && !termRejected(requestText, "스트릿")
    && !termRejected(requestText, "스트리트");
  if (!bottom && !whiteShoeRequested && !requestedTop && !streetRequested && !avoidedColors.length && !shoeBrands.length) return candidates.map(ensureGarmentSpecs);
  return candidates.map((concept, index) => {
    const replacementColors = ["차콜", "브라운", "네이비", "크림", "버건디"]
      .filter((color) => !avoidedColors.includes(color));
    const replacementColor = replacementColors[index % Math.max(1, replacementColors.length)] ?? "네이비";
    const option = bottom?.mode === "alternatives"
      ? bottom.options[index < Math.ceil(candidates.length / bottom.options.length) ? 0 : 1] ?? bottom.options[index % bottom.options.length]
      : bottom?.options[0];
    const bottomItem = option === "데님"
      ? `하의: ${["워시드 인디고", "페이디드 블랙", "딥 인디고", "그레이 워시드", "오프화이트 워시드"][index % 5]} 데님 ${index % 2 ? "와이드" : "스트레이트"} 팬츠`
      : option === "슬랙스"
        ? `하의: ${["차콜", "블랙", "그레이", "브라운", "딥 네이비"][index % 5]} ${index % 2 ? "와이드" : "스트레이트"} 슬랙스`
        : "";
    const outfitItems = concept.outfitItems
      .filter((item) => !bottom || coreGarmentCategory(item) !== "하의")
      .map((item) => replaceAvoidedColors(item, avoidedColors, replacementColor));
    if (requestedTop) {
      const topIndex = outfitItems.findIndex((item) => coreGarmentCategory(item) === "상의");
      const topItem = `상의: ${["오프화이트", "멜란지 그레이", "딥 네이비", "페이디드 블루", "버터 옐로"][index % 5]} ${topLabel}`;
      if (topIndex >= 0) outfitItems[topIndex] = topItem;
      else outfitItems.unshift(topItem);
    }
    if (whiteShoeRequested) {
      const shoeIndex = outfitItems.findIndex((item) => /신발|슈즈|스니커즈|운동화|로퍼|부츠/.test(item));
      const shoeItem = `신발: ${["화이트", "오프화이트", "아이보리", "화이트·그레이", "크림"][index % 5]} 스니커즈`;
      if (shoeIndex >= 0) outfitItems[shoeIndex] = shoeItem;
      else outfitItems.push(shoeItem);
    }
    if (shoeBrands.length) {
      const shoeIndex = outfitItems.findIndex((item) => /^신발\s*:/.test(item));
      const current = shoeIndex >= 0 ? outfitItems[shoeIndex] : "";
      if (!shoeBrands.some((brand) => current.includes(brand))) {
        const shoeItem = `신발: ${whiteShoeRequested ? "화이트 " : ""}${shoeBrands[index % shoeBrands.length]} 스니커즈`;
        if (shoeIndex >= 0) outfitItems[shoeIndex] = shoeItem;
        else outfitItems.push(shoeItem);
      }
    }
    if (streetRequested) {
      const conceptText = `${concept.mood} ${concept.fitStrategy} ${concept.materials.join(" ")} ${outfitItems.join(" ")}`;
      const streetSignals = /스트릿|스트리트|그래픽|스니커즈|카고|유틸리티|워싱|캡|트랙|나일론|후드|데님/.test(conceptText);
      if (!streetSignals) {
        outfitItems.push(`스타일 포인트: ${["레트로 스니커즈", "카고 팬츠", "그래픽 티셔츠", "나일론 바람막이", "워시드 데님 팬츠"][index % 5]}`);
      }
    }
    if (bottomItem) outfitItems.push(bottomItem);
    return {
      ...concept,
      name: replaceAvoidedColors(concept.name, avoidedColors, replacementColor),
      description: replaceAvoidedColors(concept.description, avoidedColors, replacementColor),
      mood: replaceAvoidedColors(concept.mood, avoidedColors, replacementColor),
      colorPalette: concept.colorPalette.map((color) => replaceAvoidedColors(color, avoidedColors, replacementColor)),
      outfitItems: [...new Set(outfitItems)],
      materials: [...new Set([
        ...concept.materials.map((material) => replaceAvoidedColors(material, avoidedColors, replacementColor)),
        option === "데님" ? "데님" : option === "슬랙스" ? "드라이 울 혼방" : "",
      ].filter(Boolean))],
      stylingReason: bottom
        ? `사용자 요청에 따라 ${option} 하의를 고정하고 나머지 상의·아우터·신발·디테일을 후보별로 변주했습니다. ${concept.stylingReason}`
        : replaceAvoidedColors(concept.stylingReason, avoidedColors, replacementColor),
    };
  }).map((candidate) => {
    const enriched = ensureGarmentSpecs(candidate);
    const replacement = ["차콜", "브라운", "네이비", "크림", "버건디"].find(color => !avoidedColors.includes(color)) ?? "네이비";
    // Defaults for previously unspecified attributes must honor explicit exclusions too.
    const garmentSpecs = enriched.garmentSpecs.map(spec => ({ ...spec,
      item: replaceAvoidedColors(spec.item, avoidedColors, replacement),
      ...(spec.color ? {color: replaceAvoidedColors(spec.color, avoidedColors, replacement)} : {}),
    }));
    return ensureGarmentSpecs({ ...enriched, garmentSpecs, outfitItems: garmentSpecs.map(garmentSpecText) });
  });
}

function buildUserIntentContract(keyword: string) {
  const requestText = sanitizeCoreText(directUserRequestText(keyword));
  const feedbackLines = requestText
    .split("\n")
    .filter((line) => line.trim().startsWith("-"))
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
  const acceptedAgentRecommendations = keyword
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter((line) => /^에이전트 추천 반영\s*:/i.test(line))
    .map((line) => line.replace(/^에이전트 추천 반영\s*:\s*/i, ""))
    .filter(Boolean);
  const directFeedbackLines = feedbackLines.filter((line) => !/^에이전트 추천 반영\s*:/i.test(line));
  const avoidLines = [...requestText.matchAll(/[^\n,.!?]*?(?:싫어|안좋아|좋아하지|빼|피해|피하고|원하지|제외|금지|말고|않고)[^\n,.!?]*/gi)]
    .map((match) => match[0].trim())
    .filter(Boolean);
  const bottom = extractBottomConstraint(keyword);
  return [
    "[사용자 요구사항 우선순위]",
    "1. 사용자가 직접 말한 요구·피드백과 피하고 싶은 요소",
    "2. 날짜·실제 날씨·약속 종류·장소 무드",
    "3. 성별·키·몸무게에 따른 현실적인 비율과 기장",
    "4. 패션 레퍼런스의 스타일 신호",
    directFeedbackLines.length ? `직접 받은 피드백: ${directFeedbackLines.join(" / ")}` : "직접 받은 추가 피드백: 없음",
    acceptedAgentRecommendations.length
      ? `사용자가 승인한 에이전트 추천: ${acceptedAgentRecommendations.join(" / ")}`
      : "승인한 에이전트 추천: 없음",
    avoidLines.length ? `명시적으로 피할 요소: ${avoidLines.join(" / ")}` : "명시적으로 피할 요소: 없음",
    bottom
      ? `하의 제약조건: ${bottom.mode === "all" ? `${bottom.options[0]} 하의를 모든 후보에 적용` : `${bottom.options.join(" / ")} 하의를 후보 그룹으로 나누어 모두 제시`}`
      : "하의 제약조건: 없음",
    "상위 조건과 레퍼런스가 충돌하면 반드시 상위 조건을 따르고, 사용자 요구를 임의로 기본 스타일로 바꾸지 마.",
  ].join("\n");
}

function selectFinalConcepts(concepts: Concept[], evaluations: Evaluation[]) {
  const scoreById = new Map(evaluations.map((item) => [item.id, item.totalScore]));
  const requestById = new Map(evaluations.map((item) => [item.id, item.requestScore]));
  const ranked = [...concepts].sort(
    (a, b) =>
      (requestById.get(b.id) ?? 0) - (requestById.get(a.id) ?? 0)
      || (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0),
  );
  if (ranked.length < 2) return ranked.slice(0, 2);

  const first = ranked[0];
  const rest = ranked.slice(1).map((concept) => ({
    concept,
    score: scoreById.get(concept.id) ?? 0,
    sim: conceptSimilarity(first, concept),
  }));
  const distinct = rest.filter((item) => item.sim <= SIMILARITY_LIMIT);
  const pool = distinct.length ? distinct : rest;
  const second = [...pool].sort(
    (a, b) => b.score - DIVERSITY_LAMBDA * b.sim - (a.score - DIVERSITY_LAMBDA * a.sim),
  )[0];

  agentLog(
    "evaluate",
    distinct.length
      ? `2안 다양성 확보: "${second.concept.name}" (1안과 유사도 ${second.sim} · ${describeSimilarity(second.sim)})`
      : `모든 후보가 1안과 유사해 유사도 패널티를 적용하고 "${second.concept.name}"을 선택`,
  );
  return [first, second.concept];
}

function rankEvaluations(evaluations: Evaluation[]) {
  return [...evaluations]
    .sort((a, b) => {
      if (b.requestScore !== a.requestScore) return b.requestScore - a.requestScore;
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (b.trendScore !== a.trendScore) return b.trendScore - a.trendScore;
      if (b.bodyFitScore !== a.bodyFitScore) return b.bodyFitScore - a.bodyFitScore;
      if (b.weatherScore !== a.weatherScore) return b.weatherScore - a.weatherScore;
      if (b.placeScore !== a.placeScore) return b.placeScore - a.placeScore;
      if (b.colorScore !== a.colorScore) return b.colorScore - a.colorScore;
      if (b.practicalityScore !== a.practicalityScore) return b.practicalityScore - a.practicalityScore;
      return a.id.localeCompare(b.id, "en");
    })
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function applyFinalDecisions(evaluations: Evaluation[], finalConcepts: Concept[]) {
  const finalIds = new Set(finalConcepts.map((concept) => concept.id));
  return rankEvaluations(evaluations).map((item) => {
    const selected = finalIds.has(item.id);
    const defaultDecision = selected
      ? `${item.rank}위, 비교 점수 ${item.totalScore}점으로 최종 룩북 후보로 선택됐어요.`
      : `${item.rank}위, 비교 점수 ${item.totalScore}점으로 최종 룩북에서는 제외됐어요.`;
    return {
      ...item,
      decisionStatus: selected ? "선택" : "탈락",
      decisionReason: item.decisionReason?.trim()
        ? `${item.rank}위 · ${item.decisionReason}`
        : defaultDecision,
    } satisfies Evaluation;
  });
}

async function createPlanJson(system: string, user: string, maxTokens: number, timeoutMs = 60_000) {
  agentLog(
    "concept",
    `NVIDIA 후보 JSON 요청 시작 (${system.length + user.length}자 · ${maxTokens}토큰)`,
    "candidate planner request",
  );
  const request: Record<string, unknown> = {
    model: NVIDIA_PLAN_MODEL,
    temperature: 0.25,
    max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (NVIDIA_PLAN_MODEL === "openai/gpt-oss-20b") request.reasoning_effort = "low";

  const response = await getNvidiaClient().chat.completions.create(
    request as never,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  const content = response.choices[0]?.message?.content;
  const parsed = parseJsonObjectFromText(content);
  agentLog(
    "concept",
    `NVIDIA 후보 JSON 응답 수신 (${content?.length ?? 0}자 · 종료 ${response.choices[0]?.finish_reason ?? "미상"})`,
    "candidate planner response",
  );
  if (!extractConceptList(parsed).length) {
    throw new Error("후보 생성 응답에 concepts/candidates 배열이 없습니다.");
  }
  return parsed;
}

async function generateCandidates(keyword: string, trend: string, intentSummary = "") {
  const compactTrend = trend.length <= 3_600
    ? trend
    : `${trend.slice(0, 1_600)}\n…중간 리서치 생략…\n${trend.slice(-2_000)}`;
  const compactIntent = intentSummary.length <= 1_800
    ? intentSummary
    : `${intentSummary.slice(0, 1_800)}\n…중략…`;
  const structuredIntent = compactIntent ? `\n\n[사용자 요구사항 구조화]\n${compactIntent}` : "";
  const parsed = await createPlanJson(
    `너는 소비자 개인화 스타일링 후보 생성기다. 사고 과정과 설명 없이 JSON 객체 하나만 반환해.
정확히 5개의 서로 다른 한국어 착장을 만들어라. 직접 요구와 피드백을 최우선으로 지키고 실제 날씨·약속·장소·체형을 반영하라. 레퍼런스는 복사하지 말고 스타일 신호로만 사용하라.
5개는 아우터 구조, 하의 실루엣, 신발, 레이어링, 핏, 소재 중 4개 이상을 다르게 하라. 같은 상·하의 조합을 반복하지 마라. outfitItems는 상의·하의·신발과 필요한 아우터만, 카테고리당 1개로 최대 4개, 모든 문자열은 짧게 써라. 키·몸무게가 있으면 bodyProfile에 원 숫자와 현실적인 비율을 적고, 성별이 없으면 남성으로 처리하라.
${CORE_GARMENT_POLICY}
각 outfitItems에는 개별 의류의 정확한 색상, 무지/체크/카모/그래픽 등 패턴, 긴팔/반팔/민소매, 바지의 데님/치노/슬랙스/트레이닝 종류, 셔츠의 버튼/하프집업 여밈을 명시한다. 전체 팔레트에만 색을 쓰지 않는다. 예: 상의: 버건디 무지 긴팔 크루넥 니트, 하의: 베이지 무지 긴바지 코튼 치노 팬츠, 아우터: 네이비 무지 민소매 경량 패딩 베스트.
반드시 다음 필드를 모두 포함하라: id, name, description, mood, colorPalette, targetCustomer, materials, outfitItems, bodyProfile, fitStrategy, stylingReason. name 12자 이내, description 20자 이내, bodyProfile·fitStrategy·stylingReason은 각 30자 이내로 작성하라. 점수와 평가 필드는 만들지 마라. concepts 대신 candidates라는 키를 사용해도 된다.`,
    `${buildUserIntentContract(keyword)}\n\n원문 사용자 요청:\n${keyword}\n\n트렌드·날씨·장소 핵심:\n${compactTrend}${structuredIntent}`,
    1600,
  );
  return applyUserConstraints(normalizeConcepts(extractConceptList(parsed)), keyword);
}

function localEvaluateCandidates(
  keyword: string,
  trend: string,
  candidates: Concept[],
  weather: WeatherSnapshot | null,
  round: 1 | 2,
) {
  const formalRequest = /결혼|장례|회의|면접|오피스|비즈니스/.test(keyword);
  const relaxedRequest = /카페|데이트|여행|공원|놀이|방탈출|lp\s*바/i.test(keyword);
  const trendText = `${keyword} ${trend}`;
  const subjective = candidates.map((concept) => {
    const text = `${concept.name} ${concept.mood} ${concept.fitStrategy} ${concept.outfitItems.join(" ")}`;
    const formalConcept = /포멀|클래식|세미포멀|블레이저|테일러드|더비/.test(text);
    const casualConcept = /캐주얼|스트리트|워크웨어|니트|데님|스니커즈/.test(text);
    const directionalSignals = [
      /체크|스트라이프|헤링본|그래픽|워시드|패턴/.test(text),
      /크롭|숏|롱|와이드|슬림|테이퍼드|세미오버|릴랙스드/.test(text),
      /브러시드|스웨이드|레더|코팅|메쉬|텍스처|울/.test(text),
      /레이어드|베스트|셔츠 재킷|유틸리티|하드웨어|메탈릭/.test(text),
    ].filter(Boolean).length;
    const venueSignals = [
      /카페|식당|쇼핑|백화점/.test(keyword) && /니트|셔츠|카디건|로퍼|데님|스웨이드/.test(text),
      /lp\s*바|음악|공연|전시/.test(keyword) && /텍스처|새틴|벨벳|실버|로퍼|부츠|카디건/.test(text),
      /데이트|친구|모임/.test(keyword) && /캐주얼|니트|데님|스니커즈|셔츠/.test(text),
      /여행|공원|놀이|방탈출|이동/.test(keyword) && /스니커즈|유틸리티|셸|드로스트링|레이어/.test(text),
    ].filter(Boolean).length;
    const placeScore = Math.max(
      45,
      Math.min(98, 64 + (formalRequest && formalConcept ? 15 : 0) + (relaxedRequest && casualConcept ? 10 : 0) + venueSignals * 5 - (formalRequest && !formalConcept ? 15 : 0)),
    );
    const fitSignals = [
      /상체|어깨/.test(text),
      /하체|허리|밑단/.test(text),
      /세미|레귤러|스트레이트|테이퍼드|와이드|오버|슬림/.test(text),
      /기장|비율|수직선|실루엣/.test(text),
    ].filter(Boolean).length;
    const bodyFitScore = Math.min(98, 60 + (concept.bodyProfile ? 8 : 0) + fitSignals * 6);
    const trendScore = Math.min(96, 62 + directionalSignals * 7 + (concept.materials.length >= 2 ? 6 : 0) + (trendText.length > 100 ? 5 : 0));
    const categoryCoverage = [
      /상의|이너|셔츠|티셔츠|니트|후드|블라우스/.test(text),
      /하의|팬츠|바지|스커트|치마|쇼츠/.test(text),
      /신발|슈즈|스니커즈|로퍼|부츠/.test(text),
      /아우터|재킷|자켓|코트|카디건|베스트|오버셔츠/.test(text),
    ].filter(Boolean).length;
    const practicalityScore = Math.max(
      45,
      Math.min(96, 48 + categoryCoverage * 9 + (weather?.forecastAvailable ? 7 : 0) - (concept.outfitItems.length > 7 ? 8 : 0)),
    );
    const failureReasons = [
      directionalSignals < 2
        ? "실루엣·표면감·패턴 중 선명한 패션 디테일이 부족해 최신 레퍼런스와 거리가 있어요."
        : formalRequest && !formalConcept
        ? "입력된 공식적인 약속에 비해 착장의 격식과 구조감이 부족할 수 있어요."
        : "현재 상황에서 아이템 간 격식 균형을 한 번 더 확인할 필요가 있어요.",
      weather?.forecast?.precipitationMm && weather.forecast.precipitationMm > 2
        ? "예상 강수에 대응하는 방수 또는 여분 레이어가 충분히 명시되지 않았어요."
        : "날씨 변화에 대비한 레이어링 여지가 남아 있어요.",
    ];
    const revisionPlan = [
      directionalSignals < 2
        ? "크롭/롱 비율, 절제된 체크·스트라이프, 브러시드·스웨이드 질감 중 상황에 맞는 한 가지를 추가해요."
        : formalRequest && !formalConcept
        ? "구조적인 재킷이나 셔츠 중심으로 상체의 격식을 높여요."
        : "상·하의 실루엣 대비를 조정해 상황에 맞는 균형을 만들어요.",
      weather?.forecast?.precipitationMm && weather.forecast.precipitationMm > 2
        ? "경량 방수 아우터 또는 방수 신발 요소를 추가해요."
        : "기온 변화에 대응할 수 있는 가벼운 레이어를 보완해요.",
    ];
    return {
      id: concept.id,
      name: concept.name,
      placeScore,
      bodyFitScore,
      trendScore,
      practicalityScore,
      failureReasons,
      revisionPlan,
    } satisfies SubjectiveEvaluation;
  });
  agentLog("evaluate", `${round}차 로컬 Subjective 평가 완료`, "local heuristic + objective verifier");
  return scoreEvaluations(subjective, candidates, weather, round, keyword);
}

function scoreEvaluations(
  subjective: SubjectiveEvaluation[],
  candidates: Concept[],
  weather: WeatherSnapshot | null,
  round: 1 | 2,
  keyword: string,
) {
  const objective = runObjectiveVerifiers(candidates, weather);

  agentLog("weather", `weather_fit ${round}차 검증 완료`, "objective verifier");
  agentLog("evaluate", `color_harmony ${round}차 검증 완료`, "objective verifier");
  agentLog("evaluate", `diversity ${round}차 검증 완료`, "objective verifier");
  agentLog("evaluate", `occasion_fit ${round}차 검증 완료`, "local heuristic");

  return subjective.map((item) => {
    const scores = objective.get(item.id);
    // Only the user's request and explicit feedback are hard constraints.
    // The intent agent may infer useful context, but it must not lower every
    // candidate when its inferred fields are not represented verbatim.
    const requestScore = scoreUserRequestFit(keyword, candidates.find((candidate) => candidate.id === item.id) ?? candidates[0]);
    const weatherScore = scoreOrFallback(scores?.weather.score);
    const colorScore = scoreOrFallback(scores?.color.score);
    const diversityScore = scoreOrFallback(scores?.diversity.score);
    const placeScore = scoreOrFallback(item.placeScore);
    const bodyFitScore = scoreOrFallback(item.bodyFitScore);
    const trendScore = scoreOrFallback(item.trendScore);
    const practicalityScore = scoreOrFallback(item.practicalityScore);
    const qualityTotal =
      placeScore * 0.28 +
      weatherScore * 0.22 +
      bodyFitScore * 0.18 +
      trendScore * 0.14 +
      colorScore * 0.12 +
      practicalityScore * 0.06;
    const totalScore = Math.max(0, Math.min(requestScore, Math.round(qualityTotal)));
    const verifierIssues = [
      ...(scores?.weather.issues ?? []),
      ...(scores?.color.issues ?? []),
      ...(scores?.diversity.issues ?? []),
    ];
    return {
      ...item,
      placeScore,
      bodyFitScore,
      trendScore,
      practicalityScore,
      requestScore,
      weatherScore,
      colorScore,
      diversityScore,
      totalScore,
      verifierIssues,
      failureReasons: [...new Set([...item.failureReasons, ...verifierIssues])].slice(0, 4),
    };
  });
}

async function repairCandidates(
  keyword: string,
  trend: string,
  candidates: Concept[],
  evaluations: Evaluation[],
  diversityFocus = false,
  intentSummary = "",
) {
  const concerns = evaluations.map(({ id, failureReasons, revisionPlan }) => ({ id, failureReasons, revisionPlan }));
  const parsed = await createPlanJson(
    `너는 퍼스널 스타일링 후보 수정 도구다. JSON 객체 하나만 반환한다.
${CORE_GARMENT_POLICY}
각 outfitItems에는 개별 의류의 정확한 색상, 무지/체크/카모/그래픽 등 패턴, 긴팔/반팔/민소매, 바지의 데님/치노/슬랙스/트레이닝 종류, 셔츠의 버튼/하프집업 여밈을 명시한다. 전체 팔레트에만 색을 쓰지 않는다. 예: 상의: 버건디 무지 긴팔 크루넥 니트, 하의: 베이지 무지 긴바지 코튼 치노 팬츠, 아우터: 네이비 무지 민소매 경량 패딩 베스트.
후보 수·순서·id를 유지하고 사용자 요청을 지키면서 평가에서 지적한 의류만 최소한으로 바꾼다.
상의·하의·신발을 포함하고 필요하면 벗을 수 있는 아우터를 추가한다. 제외 조건은 반드시 지킨다.
원래 후보와 다른 이유 없는 변경은 하지 않는다. 신발 브랜드의 대안은 OR 조건이다.
${diversityFocus ? "비슷한 후보는 하의 실루엣이나 겉옷 구조를 달리한다. 색상만 바꾸지 않는다." : "날씨와 이동량에 맞는 실용적인 보완을 우선한다."}
응답: {"concepts": Concept[]}. Concept 필드: id, name, description, mood, colorPalette, targetCustomer, materials, outfitItems, bodyProfile, fitStrategy, stylingReason.
각 문장은 짧게 작성한다. 평가·점수는 서버가 계산하므로 출력하지 않는다.`,
    `${buildUserIntentContract(keyword)}\n원문 요청: ${keyword}\n분석: ${trend.slice(0, 1800)}\n요청 정리: ${intentSummary.slice(0, 1200)}\n후보: ${JSON.stringify(candidates)}\n보완할 점: ${JSON.stringify(concerns)}`,
    2400,
    45_000,
  );
  const repaired = normalizeConcepts(extractConceptList(parsed), candidates);
  if (repaired.length !== candidates.length) throw new Error("수정 응답이 기존 후보를 모두 포함하지 않았습니다.");
  return applyUserConstraints(repaired, keyword);
}

export async function POST(req: Request) {
  try {
    const { keyword, trend, weather, intent, consultationProposal } = await req.json();
    if (typeof keyword !== "string" || !keyword.trim()) {
      throw new Error("사용자 입력이 없어 후보를 생성할 수 없습니다.");
    }
    if (typeof trend !== "string" || !trend.trim()) {
      throw new Error("날씨·장소·트렌드 분석이 없어 후보를 생성할 수 없습니다.");
    }
    if (!intent || typeof intent !== "object") {
      throw new Error("사용자 요구사항 구조화 결과가 없어 후보를 생성할 수 없습니다.");
    }
    const consultationContext = typeof consultationProposal === "string" && consultationProposal.trim()
      ? `\n상담에서 제안한 조합(사용자 직접 요청과 피드백 우선, 임의로 새 필수 조건 추가 금지): ${consultationProposal.trim().slice(0, 1600)}`
      : "";
    // Put the accepted consultation proposal first so compact prompts retain it.
    const intentSummary = consultationContext + (intent && typeof intent === "object" ? JSON.stringify(intent).slice(0, 4_000) : "");
    const weatherSnapshot = weather && typeof weather === "object"
      ? (weather as WeatherSnapshot)
      : null;
    agentLog(
      "concept",
      `"${keyword}" 후보 생성 Tool 시작`,
      `generate_outfit_candidates · ${NVIDIA_PLAN_MODEL}`,
    );

    const result = await recoverPlanning<Concept, Evaluation>({
      generate: () => generateCandidates(keyword, trend, intentSummary),
      fallback: () => applyUserConstraints(createBackupCandidates(keyword, weatherSnapshot), keyword),
      validate: (candidates) => assertCandidateSet(candidates, keyword, "후보 검사"),
      evaluate: (candidates, round) => rankEvaluations(localEvaluateCandidates(keyword, trend, candidates, weatherSnapshot, round)),
      repair: (candidates, evaluations, diversity) => repairCandidates(keyword, trend, candidates, evaluations, diversity, intentSummary),
      needsDiversity: (candidates) => candidateSimilaritySummary(candidates).maximum >= 0.5,
      onFailure: (stage, error) => agentLog("evaluate", `${stage} 보완 중단, 확보한 후보로 계속: ${error instanceof Error ? error.message : "알 수 없는 오류"}`, "candidate recovery"),
    });
    const { originalCandidates, round1, warnings, evaluationStage, candidateSource } = result;
    const candidateBase = result.candidates;
    const finalConcepts = selectFinalConcepts(candidateBase, result.evaluations);
    const round2 = applyFinalDecisions(result.evaluations, finalConcepts);
    const missingPreferences = candidateBase.flatMap((concept) => missingUserRequestTerms(keyword, concept));
    if (missingPreferences.length || round2.some((evaluation) => evaluation.requestScore < 100)) {
      warnings.push("일부 세부 취향은 완전히 반영되지 않았어요. 후보별 비교 점수와 보완할 점을 확인해주세요.");
    }
    if (finalConcepts.length < 2) throw new Error("요청 조건을 지키는 착장 2개를 준비하지 못했어요. 제외 조건을 조정해주세요.");
    agentLog("evaluate", `${evaluationStage === "repaired" ? "보완 후보" : "확보한 후보"}로 최종 선택: ${finalConcepts.map((item) => item.name).join(" / ")}`);

    const finalSimilarity = conceptSimilarity(finalConcepts[0], finalConcepts[1]);
    return NextResponse.json({
      originalCandidates,
      round1,
      repairSummary: warnings,
      planStatus: warnings.length ? "partial" : "complete",
      evaluationStage,
      candidateSource,
      warnings,
      repairedCandidates: candidateBase,
      round2,
      finalConcepts,
      finalSimilarity,
      finalSimilarityLabel: describeSimilarity(finalSimilarity),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "스타일링 Agent 실행 중 알 수 없는 오류";
    agentLog("evaluate", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
