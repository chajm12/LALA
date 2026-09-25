import fs from "node:fs";
import path from "node:path";
import { embed } from "@/lib/nim";

/**
 * 카탈로그 RAG 도구.
 * scripts/build-catalog-index.mjs 가 만든 data/catalog-index.json 을 메모리에 올리고
 * 임베딩 NIM(query 모드)으로 질의를 벡터화해 코사인 유사도 상위 K 개를 돌려준다.
 */
export type CatalogItem = {
  id: string;
  name: string;
  category: string;      // 상의 / 하의 / 아우터 / 신발 / 가방 / 악세사리 / 모자 ...
  subCategory: string;
  color: string;
  gender: string;        // 남성 / 여성 / 공용
  season: string;
  usage: string;
  description: string;
  url: string;
  imageUrl?: string;
  source: string;        // 데이터 출처 (H&M / Myntra ...)
};

type IndexFile = { model: string; dim: number; items: CatalogItem[]; vectors: number[][] };

let cache: IndexFile | null = null;

export function loadCatalog(): IndexFile {
  if (cache) return cache;
  const file = path.join(process.cwd(), "data", "catalog-index.json");
  if (!fs.existsSync(file)) {
    throw new Error("data/catalog-index.json 이 없어요. `npm run catalog:index` 를 먼저 실행하세요.");
  }
  cache = JSON.parse(fs.readFileSync(file, "utf8")) as IndexFile;
  return cache;
}

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export type RetrieveOptions = {
  topK?: number;
  category?: string;
  gender?: string;
};

export type RetrievedItem = CatalogItem & { score: number };

export async function retrieveProducts(query: string, opts: RetrieveOptions = {}): Promise<RetrievedItem[]> {
  const index = loadCatalog();
  const [qv] = await embed([query], "query");
  const topK = opts.topK ?? 5;
  const wantCat = opts.category?.trim();
  const wantGender = opts.gender?.trim();

  const qTokens = tokenize(query);
  const scored: RetrievedItem[] = [];
  for (let i = 0; i < index.items.length; i++) {
    const item = index.items[i];
    if (wantCat && !matchesCategory(item.category, wantCat)) continue;
    if (wantGender && item.gender !== "공용" && item.gender !== wantGender) continue;
    // 하이브리드: 벡터 유사도 + 품목/색상 토큰 일치 보너스 (재킷 질의에 샌들이 뜨는 것을 막는다)
    const lexical = lexicalBoost(qTokens, item);
    scored.push({ ...item, score: cosine(qv, index.vectors[i]) + lexical });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function tokenize(text: string) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9가-힣 ]/g, " ").split(/\s+/).filter((t) => t.length > 2));
}

const TYPE_SYNONYMS: Record<string, string[]> = {
  jacket: ["jacket", "jackets", "blazer", "blazers", "bomber", "trucker"],
  coat: ["coat", "coats", "overcoat", "trench"],
  sweater: ["sweater", "sweaters", "knit", "pullover", "cardigan"],
  sweatshirt: ["sweatshirt", "sweatshirts", "hoodie"],
  shirt: ["shirt", "shirts"],
  tshirt: ["tshirt", "tshirts", "tee", "henley"],
  jeans: ["jeans", "denim"],
  trousers: ["trousers", "chinos", "chino", "slacks", "pants", "trouser"],
  shorts: ["shorts"],
  boots: ["boots", "boot", "chukka", "chelsea"],
  sneakers: ["sneakers", "sneaker", "trainers"],
  loafers: ["loafers", "loafer", "formal"],
  sandals: ["sandals", "sandal", "flip"],
  bag: ["bag", "tote", "backpack", "messenger", "handbag"],
  belt: ["belt", "belts"],
  watch: ["watch", "watches"],
  cap: ["cap", "caps", "hat", "beanie"],
};

function lexicalBoost(qTokens: Set<string>, item: CatalogItem) {
  const hay = `${item.subCategory} ${item.name} ${item.color}`.toLowerCase();
  let boost = 0;
  for (const [, syns] of Object.entries(TYPE_SYNONYMS)) {
    const inQuery = syns.some((w) => qTokens.has(w));
    const inItem = syns.some((w) => hay.includes(w));
    if (inQuery && inItem) { boost += 0.15; break; }
  }
  if (item.color && qTokens.has(item.color.toLowerCase())) boost += 0.05;
  return boost;
}

const CATEGORY_ALIASES: Record<string, string[]> = {
  "상의": ["상의", "이너", "탑", "top", "shirt", "티셔츠", "니트", "셔츠"],
  "아우터": ["아우터", "outer", "자켓", "재킷", "블레이저", "코트", "점퍼", "가디건"],
  "하의": ["하의", "bottom", "팬츠", "바지", "슬랙스", "데님", "스커트", "쇼츠"],
  "신발": ["신발", "shoes", "스니커즈", "로퍼", "부츠", "구두", "샌들"],
  "가방": ["가방", "bag", "백", "토트", "백팩"],
  "악세사리": ["악세사리", "액세서리", "accessory", "목걸이", "벨트", "시계", "선글라스", "반지"],
  "모자": ["모자", "hat", "캡", "볼캡", "비니", "버킷햇"],
};

export function normalizeCategory(label: string): string | undefined {
  const l = label.toLowerCase();
  for (const [canon, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.some((a) => l.includes(a.toLowerCase()))) return canon;
  }
  return undefined;
}

function matchesCategory(itemCategory: string, wanted: string) {
  const a = normalizeCategory(itemCategory) ?? itemCategory;
  const b = normalizeCategory(wanted) ?? wanted;
  return a === b;
}

export function catalogSummary() {
  const index = loadCatalog();
  const byCat: Record<string, number> = {};
  for (const item of index.items) byCat[item.category] = (byCat[item.category] ?? 0) + 1;
  return { total: index.items.length, byCategory: byCat, embedModel: index.model };
}
