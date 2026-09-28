import { coreGarmentCategory, normalizeCoreOutfitItems, sanitizeCoreConcept, type CoreGarmentCategory } from "@/lib/garments";

export type GarmentSpec = {
  category: CoreGarmentCategory;
  item: string;
  color?: string;
  pattern?: string;
  sleeve?: string;
  material?: string;
  fit?: string;
  closure?: string;
  brand?: string;
  model?: string;
  length?: string;
};
const FIELDS = ["color", "pattern", "sleeve", "material", "fit", "closure", "brand", "model", "length"] as const;
const COLORS: [string, RegExp][] = [
  ["차콜", /차콜|charcoal/i], ["네이비", /네이비|남색|navy/i], ["버건디", /버건디|와인|burgundy|wine/i],
  ["카멜", /카멜|camel/i], ["베이지", /베이지|beige/i], ["카키", /카키|khaki/i], ["올리브", /올리브|olive/i],
  ["인디고", /인디고|indigo/i], ["아이보리", /아이보리|오프화이트|ivory|off.?white/i],
  ["그레이", /그레이|회색|실버|grey|gray|silver/i], ["블랙", /블랙|검정|검은|흑청|black/i],
  ["화이트", /화이트|흰색|흰\s|white/i], ["브라운", /브라운|갈색|brown/i], ["블루", /블루|파란|blue/i],
  ["그린", /그린|초록|green/i], ["레드", /레드|빨강|red/i], ["핑크", /핑크|pink/i],
];
export function garmentColor(value: string): string | undefined { return COLORS.find(([, pattern]) => pattern.test(value))?.[0]; }

function attributes(item: string, category: CoreGarmentCategory): Partial<GarmentSpec> {
  const spec: Partial<GarmentSpec> = {};
  const color = garmentColor(item); if (color) spec.color = color;
  if (/카모|카무|위장|camo/i.test(item)) spec.pattern = "카모플라쥬";
  else if (/체크|check|plaid|tartan/i.test(item)) spec.pattern = "체크";
  else if (/스트라이프|줄무늬|stripe/i.test(item)) spec.pattern = "스트라이프";
  else if (/그래픽|프린트|프린팅|graphic|print/i.test(item)) spec.pattern = "그래픽";
  else if (/무지|단색|plain|solid/i.test(item)) spec.pattern = "무지";
  if (/민소매|나시|슬리브리스|sleeveless|베스트|조끼|\bvest\b/i.test(item)) spec.sleeve = "민소매";
  else if (/반팔|반소매|숏.?슬리브|short.?sleeve/i.test(item)) spec.sleeve = "반팔";
  else if (/긴팔|긴소매|롱.?슬리브|long.?sleeve/i.test(item)) spec.sleeve = "긴팔";
  if (/데님|청바지|흑청|denim|jeans/i.test(item)) spec.material = "데님";
  else if (/치노|면바지|코튼|chino|cotton/i.test(item)) spec.material = "코튼";
  else if (/트레이닝|스웨트|저지|조거|sweat|jersey|jogger/i.test(item)) spec.material = "스웨트";
  else if (/니트|스웨터|knit|sweater/i.test(item)) spec.material = "니트";
  else if (/나일론|nylon/i.test(item)) spec.material = "나일론";
  else if (/가죽|레더|leather/i.test(item)) spec.material = "가죽";
  if (/하프집|반집|반지퍼|half.?zip|quarter.?zip/i.test(item)) spec.closure = "하프집업";
  else if (/버튼|단추|button/i.test(item)) spec.closure = "버튼";
  else if (/집업|지퍼|zip/i.test(item)) spec.closure = "집업";
  if (/오버핏|오버사이즈|oversiz/i.test(item)) spec.fit = "오버핏";
  else if (/와이드|wide/i.test(item)) spec.fit = "와이드";
  else if (/스트레이트|straight/i.test(item)) spec.fit = "스트레이트";
  else if (/슬림|slim/i.test(item)) spec.fit = "슬림";
  else if (/루즈|릴랙스|loose|relax/i.test(item)) spec.fit = "릴랙스";
  if (category === "하의" && /쇼츠|반바지|shorts/i.test(item)) spec.length = "반바지";
  else if (category === "하의" && /팬츠|바지|슬랙스|데님|pants|jeans|trouser/i.test(item)) spec.length = "긴바지";
  if (/뉴발란스|new\s?balance/i.test(item)) { spec.brand = "뉴발란스"; spec.model = item.match(/(?:574|530|990(?:v\d)?|2002R|1906R|9060)/i)?.[0]; }
  if (/컨버스|converse/i.test(item)) { spec.brand = "컨버스"; spec.model = /70/.test(item) ? "척 70" : /올스타|all\s?star/i.test(item) ? "올스타" : undefined; }
  return Object.fromEntries(Object.entries(spec).filter(([,value]) => value !== undefined)) as Partial<GarmentSpec>;
}

export function normalizeGarmentSpecs(value: unknown): GarmentSpec[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const record = raw as Record<string, unknown>;
    const item = typeof record.item === "string" ? record.item.trim() : "";
    const category = coreGarmentCategory(`${String(record.category ?? "")}: ${item}`);
    if (!item || !category || seen.has(category)) return [];
    seen.add(category);
    const result: GarmentSpec = { category, item };
    for (const key of FIELDS) if (typeof record[key] === "string" && record[key].trim() && !/^(unknown|미상|모름|확인 불가)$/i.test(record[key])) result[key] = record[key].trim();
    return [result];
  });
}

// Reading an existing look never guesses colors or sleeve lengths from a palette.
export function readGarmentSpecs(concept: Record<string, unknown>): GarmentSpec[] {
  const stored = normalizeGarmentSpecs(concept.garmentSpecs);
  return normalizeCoreOutfitItems(concept.outfitItems).map((raw) => {
    const category = coreGarmentCategory(raw)!;
    const existing = stored.find(value => value.category === category);
    const item = existing && garmentSpecText(existing) === raw ? existing.item : raw.replace(/^[^:]+:\s*/, "");
    return { ...existing, category, item, ...attributes(item, category) };
  });
}

export function garmentSpecText(spec: GarmentSpec): string {
  const item = spec.item.replace(/^[^:]+:\s*/, "");
  const details = [spec.color, spec.pattern, spec.sleeve, spec.length, spec.material, spec.fit, spec.closure, spec.brand, spec.model]
    .filter((value): value is string => !!value && !item.toLowerCase().includes(value.toLowerCase()));
  return `${spec.category}: ${[...new Set(details), item].join(" ")}`;
}

// Complete underspecified attributes as explicit DESIGN choices before generating
// a new image. These defaults are never described as observations of an old image.
export function ensureGarmentSpecs<T extends Record<string, unknown>>(input: T): T & { garmentSpecs: GarmentSpec[]; outfitItems: string[] } {
  const concept = sanitizeCoreConcept(input);
  const paletteText = Array.isArray(concept.colorPalette) ? concept.colorPalette.join(" ") : "";
  const palette = COLORS.filter(([,pattern]) => pattern.test(paletteText)).map(([color]) => color);
  const defaults: Record<CoreGarmentCategory, string> = { "상의": palette[0] ?? "화이트", "하의": palette[1] ?? "차콜", "신발": "그레이", "아우터": palette.find(color => color !== (palette[0] ?? "화이트")) ?? "네이비" };
  const specs = readGarmentSpecs(concept).map((source) => {
    const spec = { ...source };
    spec.color ??= defaults[spec.category];
    if (spec.category !== "신발") spec.pattern ??= "무지";
    if (spec.category === "상의") {
      spec.sleeve ??= /티셔츠|t-?shirt/i.test(spec.item) ? "반팔" : "긴팔";
      if (/셔츠|shirt/i.test(spec.item) && !/티셔츠|t-?shirt|스웨트|sweat|폴로|polo|니트|knit/i.test(spec.item)) { spec.material ??= "직물"; spec.closure ??= "버튼"; }
      if (/니트|스웨터|knit|sweater/i.test(spec.item)) spec.material ??= "니트";
    }
    if (spec.category === "하의") {
      spec.length ??= "긴바지";
      if (!spec.material && !/슬랙스|slacks|정장|트랙|track/i.test(spec.item)) spec.material = "코튼";
      if (/데님|청바지|jeans|denim/i.test(spec.item)) spec.material = "데님";
    }
    if (spec.category === "아우터") spec.sleeve ??= /베스트|조끼|vest/i.test(spec.item) ? "민소매" : "긴팔";
    return spec;
  });
  return { ...concept, garmentSpecs: specs, outfitItems: specs.map(garmentSpecText) };
}

function visibleFamily(spec: GarmentSpec): string | undefined {
  const name = spec.item;
  const groups: [string, RegExp][] = spec.category === "하의" ? [
    ["트랙·스웨트", /트랙|트레이닝|스웨트|track|sweat|jogger/i], ["카고", /카고|cargo/i],
    ["데님", /데님|청바지|블랙진|denim|jeans/i], ["치노", /치노|면바지|chino/i], ["슬랙스", /슬랙스|slacks|dress pants/i],
  ] : spec.category === "상의" ? [
    ["티셔츠", /티셔츠|t-?shirt/i], ["맨투맨", /맨투맨|스웨트셔츠|sweatshirt/i], ["니트", /니트|스웨터|knit|sweater/i], ["셔츠", /셔츠|shirt/i],
  ] : spec.category === "아우터" ? [
    ["조끼", /조끼|베스트|vest/i], ["패딩", /패딩|푸퍼|puffer|down jacket/i], ["가디건", /가디건|cardigan/i], ["코트", /코트|coat/i], ["재킷", /재킷|자켓|블루종|jacket|blouson/i],
  ] : [];
  return groups.find(([,pattern]) => pattern.test(name))?.[0];
}
function comparableAttribute(key: string, value: string): string {
  if (key === "color") return garmentColor(value) ?? value;
  const aliases: Record<string, [string, RegExp][]> = {
    pattern: [["무지", /^(무지|단색|solid|plain)$/i], ["카모", /카모|카무|camo/i]],
    sleeve: [["긴팔", /긴팔|긴소매|long.?sleeve/i], ["반팔", /반팔|반소매|short.?sleeve/i], ["민소매", /민소매|sleeveless/i]],
    closure: [["집업", /^(지퍼|집업|zip|zipper|zip-up)$/i], ["버튼", /버튼|단추|button/i], ["하프집업", /하프집|반집|half.?zip|quarter.?zip/i]],
    material: [["직물", /직물|우븐|woven/i], ["데님", /데님|denim/i], ["니트", /니트|knit/i], ["스웨트", /스웨트|fleece|sweat/i]],
    length: [["긴바지", /긴바지|long|full.?length/i], ["반바지", /반바지|shorts/i]],
  };
  return aliases[key]?.find(([,pattern]) => pattern.test(value))?.[0] ?? value;
}

export function compareGarmentSpecs(expected: GarmentSpec[], observed: GarmentSpec[]): { matches: boolean; differences: string[] } {
  const differences: string[] = [];
  for (const spec of expected) {
    const actual = observed.find(value => value.category === spec.category);
    if (!actual) { differences.push(`${spec.category}: 이미지에서 의류를 확인하지 못했어요.`); continue; }
    const wantedFamily = visibleFamily(spec), actualFamily = visibleFamily(actual);
    if (wantedFamily && actualFamily && wantedFamily !== actualFamily) differences.push(spec.category + ": 명세 '" + wantedFamily + "' / 이미지 '" + actualFamily + "'");
    const visualMaterials = new Set(["직물", "데님", "니트", "스웨트"]);
    const wantedMaterial = comparableAttribute("material", spec.material ?? ""), actualMaterial = comparableAttribute("material", actual.material ?? "");
    if (visualMaterials.has(wantedMaterial) && visualMaterials.has(actualMaterial) && wantedMaterial !== actualMaterial) differences.push(spec.category + ": 원단 질감 명세 '" + spec.material + "' / 이미지 '" + actual.material + "'");
    for (const key of ["color", "pattern", "sleeve", "closure", "length"] as const) {
      if (!spec[key]) continue;
      const expectedValue = comparableAttribute(key, spec[key]!);
      const actualValue = actual[key] ? comparableAttribute(key, actual[key]!) : undefined;
      if (!actualValue) differences.push(`${spec.category}: ${key === "color" ? "색상" : key === "pattern" ? "무늬" : key === "sleeve" ? "소매" : key === "closure" ? "여밈" : "기장"}을 이미지에서 확인하지 못했어요.`);
      else if (expectedValue !== actualValue) differences.push(`${spec.category}: 명세 '${spec[key]}' / 이미지 '${actual[key]}'`);
    }
  }
  return { matches: expected.length > 0 && differences.length === 0, differences };
}
