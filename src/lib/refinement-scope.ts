import { coreGarmentCategory, normalizeCoreOutfitItems, sanitizeCoreConcept, type CoreGarmentCategory } from "./garments";

type Concept = Record<string, unknown>;
type Spec = Record<string, unknown> & { category: CoreGarmentCategory; item: string };
const ORDER: CoreGarmentCategory[] = ["상의", "하의", "신발", "아우터"];
const COLOR_NAMES = ["오프화이트", "라이트 그레이", "다크 그레이", "올리브 그린", "아이보리", "버건디", "카멜", "크림", "베이지", "브라운", "차콜", "네이비", "남색", "블랙", "검정색", "검정", "화이트", "흰색", "하얀색", "그레이", "회색", "카키", "올리브", "블루", "파란색", "그린", "초록색", "와인색", "와인", "레드", "빨간색", "핑크", "실버", "indigo", "burgundy", "charcoal", "navy", "black", "white", "ivory", "cream", "beige", "camel", "brown", "khaki", "olive", "gray", "grey", "blue", "green", "red", "silver"];
const COLOR_RE = new RegExp(COLOR_NAMES.join("|"), "gi");
const ALIASES: Record<string, string> = { 남색: "네이비", navy: "네이비", 검정: "블랙", 검정색: "블랙", black: "블랙", 흰색: "화이트", 하얀색: "화이트", white: "화이트", 회색: "그레이", gray: "그레이", grey: "그레이", charcoal: "차콜", 와인색: "버건디", 와인: "버건디", burgundy: "버건디", beige: "베이지", camel: "카멜", khaki: "카키", olive: "올리브", silver: "실버", ivory: "아이보리", cream: "크림", blue: "블루", green: "그린", red: "레드", brown: "브라운" };
const colorKey = (value: string) => ALIASES[value.toLowerCase()] ?? value.toLowerCase();
const colorsIn = (value: unknown) => typeof value === "string" ? [...new Set((value.match(COLOR_RE) ?? []).map(colorKey))] : [];
const nameOf = (value: string) => value.replace(/^[^:：]+[:：]\s*/, "").trim();
const CATEGORY_MATCH: Record<CoreGarmentCategory, RegExp> = {
  아우터: /아우터|겉옷|재킷|자켓|블루종|블레이저|패딩|코트|가디건|카디건|베스트|조끼|바람막이/,
  상의: /상의|이너|티셔츠|셔츠|맨투맨|후드|니트|폴로|스웨터/,
  하의: /하의|팬츠|바지|데님|청바지|슬랙스|치노/,
  신발: /신발|스니커즈|운동화|컨버스|뉴발란스|로퍼|부츠|구두/,
};
function mentionedCategories(text: string): CoreGarmentCategory[] {
  const withoutOuterNames = text.replace(/(?:데님|셔츠|니트)\s*(?:재킷|자켓|조끼|베스트)/g, "아우터");
  return ORDER.filter((category) => CATEGORY_MATCH[category].test(withoutOuterNames));
}
function originalItems(concept: Concept) {
  return new Map(normalizeCoreOutfitItems(concept.outfitItems).map((item) => [coreGarmentCategory(item)!, item]));
}
function specsByCategory(concept: Concept) {
  const result = new Map<CoreGarmentCategory, Spec>();
  if (Array.isArray(concept.garmentSpecs)) {
    for (const entry of concept.garmentSpecs) {
      if (!entry || typeof entry !== "object") continue;
      const spec = entry as Record<string, unknown>;
      const category = ORDER.includes(spec.category as CoreGarmentCategory) ? spec.category as CoreGarmentCategory : null;
      if (category && typeof spec.item === "string") result.set(category, { ...spec, category, item: spec.item });
    }
  }
  return result;
}
function categorySegment(feedback: string, category: CoreGarmentCategory) {
  const segments = feedback.split(/[,.;\n]|그리고|하고(?=\s*(?:상의|하의|아우터|신발))/);
  return segments.find((segment) => CATEGORY_MATCH[category].test(segment)) ?? feedback;
}
function recolor(item: string, color: string) {
  const category = coreGarmentCategory(item)!;
  const base = nameOf(item).replace(COLOR_RE, "").replace(/색(?=\s|$)/g, "").replace(/[([]\s*[)\]]/g, "").replace(/\s+/g, " ").trim();
  return `${category}: ${color} ${base}`;
}
function explicitOuter(feedback: string) {
  const type = feedback.match(/(?:데님|셔츠)\s*(?:재킷|자켓)|트렌치\s*코트|경량\s*(?:패딩|조끼)|바람막이|블루종|블레이저|재킷|자켓|코트|가디건|카디건|베스트|조끼/);
  if (!type) return null;
  const color = colorsIn(categorySegment(feedback, "아우터"))[0];
  const fit = feedback.match(/오버사이즈|세미오버|레귤러|릴랙스|크롭|롱(?=\s*(?:코트|패딩))/)?.[0];
  return [color, fit, type[0]].filter(Boolean).join(" ");
}
export function describeRefinementScope(feedback: string, selectedCategory?: CoreGarmentCategory) {
  const mentioned = mentionedCategories(feedback);
  const onlyOne = /둘\s*중|두\s*(?:개|가지)\s*중|(?:중에?\s*)?하나만|한\s*(?:개|가지|품목)만|중에?\s*하나/.test(feedback);
  const explicitOnly = ORDER.find((category) => new RegExp(`(?:${category}|${category === "상의" ? "이너" : category === "아우터" ? "겉옷" : category})\\s*만`).test(feedback));
  const keep = new Set(ORDER.filter((category) => {
    const segment = categorySegment(feedback, category);
    return CATEGORY_MATCH[category].test(segment) && /(?:그대로|유지|건드리지|바꾸지)/.test(segment) && !/(?:바꾸|변경|교체|추가|추천)/.test(segment);
  }));
  const allowed = explicitOnly ? [explicitOnly] : selectedCategory ? [selectedCategory] : mentioned.filter((category) => !keep.has(category));
  const colorOnly = /색상|색깔|컬러|색이|색을|색만|색으로|톤이|톤을/.test(feedback)
    && !/(?:핏|소재|원단|패턴|무늬|긴팔|반팔|민소매|길이|기장|종류|아이템).*?(?:도|까지|바꾸|변경|교체)/.test(feedback);
  return { allowed, hasExplicitCategory: mentioned.length > 0 || selectedCategory != null, onlyOne: onlyOne || explicitOnly != null || selectedCategory != null || mentioned.length === 0, colorOnly };
}
/** Model output is a proposed patch. Actual accepted diffs alone drive image generation and replies. */
export function enforceRefinementScope(originalInput: Concept, proposedInput: Concept, feedback: string, selectedCategory?: CoreGarmentCategory) {
  const original = sanitizeCoreConcept(originalInput);
  const proposed = sanitizeCoreConcept(proposedInput);
  const before = originalItems(original);
  const proposal = originalItems(proposed);
  const beforeSpecs = specsByCategory(original);
  const proposedSpecs = specsByCategory(proposed);
  const scope = describeRefinementScope(feedback, selectedCategory);
  const allowed = scope.hasExplicitCategory ? scope.allowed : ORDER.filter((category) => before.get(category) !== proposal.get(category));
  const after = new Map(before);
  const afterSpecs = new Map(beforeSpecs);
  const changed: string[] = [];
  const changedCategories: CoreGarmentCategory[] = [];
  const removeOuter = /(?:아우터|겉옷|재킷|자켓|패딩|코트|가디건|조끼|베스트)(?:를|은|는|을)?\s*(?:빼|제거|없애|벗|삭제)|(?:빼|제거|없애|삭제).*?(?:아우터|겉옷)/.test(feedback);
  for (const category of allowed) {
    if (scope.onlyOne && changedCategories.length) break;
    const oldItem = before.get(category);
    let nextItem = proposal.get(category);
    let nextSpec = proposedSpecs.get(category);
    if (category === "아우터" && removeOuter) {
      if (!oldItem) continue;
      after.delete(category);
      afterSpecs.delete(category);
      changed.push(`아우터: ${nameOf(oldItem)} 제거`);
      changedCategories.push(category);
      continue;
    }
    if (scope.colorOnly && oldItem) {
      const oldSpec = beforeSpecs.get(category);
      const previousColor = colorsIn(oldSpec?.color)[0] ?? colorsIn(oldItem)[0];
      const otherColors = allowed.filter((other) => other !== category).flatMap((other) => colorsIn(beforeSpecs.get(other)?.color ?? before.get(other)));
      const requestedColors = colorsIn(categorySegment(feedback, category));
      const suggestedColors = colorsIn(nextSpec?.color ?? nextItem);
      const destination = categorySegment(feedback, category).match(new RegExp(`(${COLOR_NAMES.join("|")})(?:색)?(?:으로|로)`, "i"));
      const exactColor = destination ? colorKey(destination[1]) : undefined;
      if (exactColor && exactColor === previousColor) continue;
      const nextColor = exactColor ?? [...requestedColors, ...suggestedColors].find((color) => color !== previousColor && (!scope.onlyOne || !otherColors.includes(color)))
        ?? (previousColor === "아이보리" || previousColor === "화이트" || previousColor === "베이지" ? "네이비" : "아이보리");
      nextItem = recolor(oldItem, nextColor);
      nextSpec = { ...(oldSpec ?? {}), category, item: nameOf(nextItem), color: nextColor };
    } else if (category === "아우터" && !removeOuter) {
      const explicit = explicitOuter(feedback);
      if (explicit) {
        nextItem = `아우터: ${explicit}`;
        nextSpec = { category, item: explicit, ...(colorsIn(explicit)[0] ? { color: colorsIn(explicit)[0] } : {}) };
      }
    }
    // A model omission is never permission to remove another garment.
    if (!nextItem || nextItem === oldItem || coreGarmentCategory(nextItem) !== category) continue;
    after.set(category, nextItem);
    afterSpecs.set(category, nextSpec ? { ...nextSpec, category, item: nameOf(nextItem) } : { category, item: nameOf(nextItem) });
    changed.push(oldItem ? `${category}: ${nameOf(oldItem)} → ${nameOf(nextItem)}` : `${category}: ${nameOf(nextItem)} 추가`);
    changedCategories.push(category);
  }
  const items = [...after.values()];
  const concept = sanitizeCoreConcept({
    ...original,
    outfitItems: items,
    garmentSpecs: [...after.keys()].map((category) => afterSpecs.get(category) ?? { category, item: nameOf(after.get(category)!) }),
    ...(changed.length ? {
      description: items.map(nameOf).join(" + "),
      colorPalette: [...new Set([...after.keys()].flatMap((category) => colorsIn(afterSpecs.get(category)?.color ?? after.get(category))))],
      refinementRequest: changed.join(" / "),
      stylingReason: changed.join(" / "),
      explicitChanges: changed,
    } : {}),
  });
  const refinementReply = changed.length
    ? `${changed.join(". ")}. ${changedCategories.length === 1 ? "이 품목만 변경했고 나머지 의류는 유지했어요." : "요청한 품목을 변경하고 나머지 의류는 유지했어요."}`
    : "요청한 범위에서 적용할 변경을 찾지 못해 기존 룩을 유지했어요.";
  return { concept, changed, changedCategories, refinementReply, unchanged: changed.length === 0 };
}
