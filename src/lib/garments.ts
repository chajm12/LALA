export type CoreGarmentCategory = "상의" | "하의" | "신발" | "아우터";

// Product scope is an application policy, including old saved concepts and model output.
export const CORE_GARMENT_POLICY = "추천 품목은 상의·하의·신발·아우터로만 제한한다. 가방·벨트·모자·양말·주얼리·시계·안경 등 액세서리는 요청/이전 대화에 있어도 추가하거나 추천하지 않는다. outfitItems는 카테고리별 한 품목, 최대 4개이며 상의와 아우터는 별도로 유지한다.";
const ACCESSORY = /액세서리|악세사리|가방|백팩|크로스\s*백|숄더\s*백|토트\s*백|미니\s*백|클러치|파우치|벨트|모자|볼캡|비니|버킷햇|양말|삭스|주얼리|쥬얼리|목걸이|팔찌|반지(?!퍼)|귀걸이|시계|선글라스|안경|스카프|머플러|넥타이|장갑|\b(?:accessor\w*|bags?|backpacks?|handbags?|belts?|hats?|caps?|beanies?|socks?|jewel\w*|necklaces?|bracelets?|rings?|earrings?|watches|watch|sunglasses|scarves|scarf|ties?|gloves?)\b/i;
const OUTER = /아우터|겉옷|재킷|자켓|블레이저|블루종|코트|패딩|파카|점퍼|가디건|카디건|바람막이|오버셔츠|베스트|조끼|\b(?:outer\w*|jackets?|coats?|blazers?|cardigans?|overshirts?|vests?|parkas?)\b/i;
const SHOES = /신발|슈즈|스니커즈|운동화|러닝화|로퍼|부츠|구두|샌들|더비|러너|\b(?:shoes?|sneakers?|loafers?|boots?|sandals?|footwear|trainers?)\b/i;
const BOTTOM = /하의|팬츠|바지|슬랙스|청바지|스커트|치마|쇼츠|\b(?:bottoms?|pants?|trousers?|jeans?|skirts?|shorts?)\b/i;
const TOP = /상의|이너|티셔츠|셔츠|니트|후드|후디|맨투맨|폴로|블라우스|터틀넥|반폴라|스웨터|스웨트|반팔|긴팔|\b(?:tops?|inners?|t-?shirts?|shirts?|sweaters?|knitwear|hoodies?|sweatshirts?|blouses?|polos?)\b/i;

export function coreGarmentCategory(value: string): CoreGarmentCategory | null {
  if (ACCESSORY.test(value)) return null;
  // A denim/shirt jacket remains outerwear regardless of a misleading model label.
  if (SHOES.test(value)) return "신발";
  if (OUTER.test(value)) return "아우터";
  if (BOTTOM.test(value)) return "하의";
  if (TOP.test(value)) return "상의";
  return null;
}

/** Remove accessory-bearing clauses from context so they cannot leak into image prompts. */
export function sanitizeCoreText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.split(/(?<=[.!?。])\s+|[\n,;|]+/)
    .map((sentence) => sentence.split(/\s*[+·]\s*|\s+(?:그리고|and|with)\s+/i)
      .filter((part) => !ACCESSORY.test(part)).join(" "))
    .filter(Boolean).join(" ").trim();
}

export function normalizeCoreOutfitItems(input: unknown): string[] {
  const source: string[] = typeof input === "string" ? [input]
    : Array.isArray(input) ? input.flatMap((item) => typeof item === "string" ? [item]
      : item && typeof item === "object" ? typeof item.category === "string" && typeof (item.item ?? item.name) === "string"
        ? [`${item.category}: ${item.item ?? item.name}`]
        : Object.entries(item).map(([key, value]) => `${key}: ${value}`) : [])
    : input && typeof input === "object" ? Object.entries(input).map(([key, value]) => `${key}: ${value}`) : [];
  const byCategory = new Map<CoreGarmentCategory, string>();
  for (const sourceItem of source) {
    for (const raw of sourceItem.split(/[,;\n|]+/)) {
      const item = sanitizeCoreText(raw).trim();
      if (!item) continue;
      const category = coreGarmentCategory(item);
      if (!category || byCategory.has(category)) continue;
      const name = item.replace(/^[^:：]{1,20}[:：]\s*/, "").trim();
      if (!name) continue;
      byCategory.set(category, `${category}: ${name}`);
    }
  }
  return [...byCategory.values()];
}

/** Keep identity/status fields intact; remove accessories from the renderable specification. */
export function sanitizeCoreConcept<T extends Record<string, unknown>>(concept: T): T {
  const copy: Record<string, unknown> = { ...concept, outfitItems: normalizeCoreOutfitItems(concept.outfitItems) };
  for (const key of ["name", "description", "mood", "fitStrategy", "stylingReason", "refinementRequest", "bodyProfile", "targetCustomer"]) {
    if (typeof copy[key] === "string") copy[key] = sanitizeCoreText(copy[key]);
  }
  for (const key of ["materials", "colorPalette", "explicitChanges"]) {
    if (Array.isArray(copy[key])) copy[key] = copy[key].map(sanitizeCoreText).filter(Boolean);
  }
  const items = copy.outfitItems as string[];
  // Useful empty-field defaults describe only retained garments, never a removed accessory.
  if (typeof concept.name === "string" && !copy.name) copy.name = "기본 의류 조합";
  if (typeof concept.description === "string" && !copy.description) copy.description = items.map((item) => item.replace(/^[^:]+:\s*/, "")).join(" + ");
  if (typeof concept.mood === "string" && !copy.mood) copy.mood = "기존 의류의 분위기 유지";
  if (typeof concept.fitStrategy === "string" && !copy.fitStrategy) copy.fitStrategy = "상의와 하의의 기존 실루엣 유지";
  if (typeof concept.stylingReason === "string" && !copy.stylingReason) copy.stylingReason = "상의·하의·신발과 필요한 겉옷으로 구성했어요.";
  return copy as T;
}
