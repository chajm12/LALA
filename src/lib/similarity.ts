type ConceptLike = {
  colorPalette: string[];
  materials: string[];
  outfitItems: string[];
  mood: string;
  fitStrategy: string;
};

const STOPWORDS = new Set(["느낌", "스타일", "룩", "톤", "감", "있는", "한", "및"]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,·/()[\]{}"'`~!@#$%^&*\-_=+|\\:;<>?.]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function listSimilarity(a: string[], b: string[]): number {
  return jaccard(tokenize(a.join(" ")), tokenize(b.join(" ")));
}

/** "상의(아우터): 네이비 블레이저" → Map{ "상의(아우터)" => "네이비 블레이저" } */
function parseItems(items: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of items) {
    const i = raw.indexOf(":");
    if (i > 0) map.set(raw.slice(0, i).trim(), raw.slice(i + 1).trim());
    else map.set(raw.trim(), raw.trim());
  }
  return map;
}

/** 카테고리별로 비교한다. 한쪽에만 있는 카테고리는 '다름'(0점)으로 본다. */
function itemSimilarity(a: string[], b: string[]): number {
  const ma = parseItems(a);
  const mb = parseItems(b);
  const cats = new Set([...ma.keys(), ...mb.keys()]);
  if (!cats.size) return 0;
  let sum = 0;
  for (const c of cats) {
    const va = ma.get(c);
    const vb = mb.get(c);
    if (va === undefined || vb === undefined) continue;
    sum += jaccard(tokenize(va), tokenize(vb));
  }
  return sum / cats.size;
}

const W = { items: 0.45, colors: 0.2, materials: 0.15, mood: 0.2 };

/** 0(완전히 다름) ~ 1(동일) */
export function conceptSimilarity(a: ConceptLike, b: ConceptLike): number {
  const score =
    W.items * itemSimilarity(a.outfitItems, b.outfitItems) +
    W.colors * listSimilarity(a.colorPalette, b.colorPalette) +
    W.materials * listSimilarity(a.materials, b.materials) +
    W.mood * jaccard(tokenize(`${a.mood} ${a.fitStrategy}`), tokenize(`${b.mood} ${b.fitStrategy}`));
  return Math.round(score * 1000) / 1000;
}

export function describeSimilarity(sim: number): string {
  if (sim >= 0.6) return "거의 같은 착장";
  if (sim >= 0.45) return "유사한 착장";
  if (sim >= 0.25) return "일부 겹침";
  return "충분히 다른 착장";
}