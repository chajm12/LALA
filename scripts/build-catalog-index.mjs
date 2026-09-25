#!/usr/bin/env node
/**
 * 카탈로그 CSV → 임베딩 인덱스 (data/catalog-index.json)
 *
 * 사용법:
 *   node scripts/build-catalog-index.mjs <csv 경로> [--limit 1500] [--gender 남성|여성|all]
 *
 * 지원 CSV (컬럼명으로 자동 감지):
 *   - H&M  articles.csv   (Kaggle: h-and-m-personalized-fashion-recommendations)
 *   - Myntra styles.csv   (Kaggle: fashion-product-images-dataset / -small)
 *   - 커스텀: id,name,category,subCategory,color,gender,season,usage,description,url,imageUrl
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith("--"));
if (!csvPath) { console.error("CSV 경로를 주세요"); process.exit(1); }
const limit = Number(args[args.indexOf("--limit") + 1] || 1500);
const genderFilter = args.includes("--gender") ? args[args.indexOf("--gender") + 1] : "all";

const API_KEY = process.env.NVIDIA_API_KEY ?? readEnv("NVIDIA_API_KEY");
const BASE_URL = process.env.NVIDIA_BASE_URL ?? readEnv("NVIDIA_BASE_URL") ?? "https://integrate.api.nvidia.com/v1";
const EMBED_MODEL = process.env.NIM_EMBED_MODEL ?? readEnv("NIM_EMBED_MODEL") ?? "nvidia/nemotron-3-embed-1b";
if (!API_KEY) { console.error("NVIDIA_API_KEY 가 없어요 (.env)"); process.exit(1); }

function readEnv(key) {
  try {
    const env = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
    const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : undefined;
  } catch { return undefined; }
}

// ---------- CSV 파서 (따옴표/개행 처리) ----------
function parseCsv(text) {
  const rows = []; let row = []; let field = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// ---------- 스키마 감지 & 정규화 ----------
const HM_GROUP_TO_CAT = {
  "Garment Upper body": "상의", "Garment Lower body": "하의", "Garment Full body": "원피스",
  "Shoes": "신발", "Bags": "가방", "Accessories": "악세사리", "Socks & Tights": "악세사리",
  "Underwear": null, "Swimwear": null, "Nightwear": null, "Cosmetic": null, "Items": null,
  "Furniture": null, "Stationery": null, "Interior textile": null, "Fun": null, "Garment and Shoe care": null,
  "Unknown": null,
};
const HM_OUTER_HINTS = /jacket|coat|blazer|cardigan|parka|trench|anorak|bomber|vest|gilet/i;
const HM_HAT_HINTS = /hat|cap|beanie|bucket/i;

function hmGender(row) {
  const s = `${row.index_group_name} ${row.section_name}`.toLowerCase();
  if (s.includes("ladies") || s.includes("women") || s.includes("divided")) return s.includes("men ") && !s.includes("women") ? "남성" : "여성";
  if (s.includes("menswear") || s.includes("men")) return "남성";
  return "공용";
}

function fromHM(row) {
  let category = HM_GROUP_TO_CAT[row.product_group_name];
  if (category === null || category === undefined) return null;
  if (category === "상의" && HM_OUTER_HINTS.test(row.product_type_name)) category = "아우터";
  if (category === "악세사리" && HM_HAT_HINTS.test(row.product_type_name)) category = "모자";
  return {
    id: row.article_id,
    name: row.prod_name,
    category,
    subCategory: row.product_type_name,
    color: row.colour_group_name,
    gender: hmGender(row),
    season: "",
    usage: row.index_name,
    description: row.detail_desc ?? "",
    url: `https://www2.hm.com/en_us/productpage.${row.article_id}.html`,
    source: "H&M",
  };
}

const MYNTRA_SUB_TO_CAT = {
  "Topwear": "상의", "Bottomwear": "하의", "Dress": "원피스", "Shoes": "신발", "Sandal": "신발", "Flip Flops": "신발",
  "Bags": "가방", "Headwear": "모자", "Watches": "악세사리", "Belts": "악세사리", "Jewellery": "악세사리",
  "Eyewear": "악세사리", "Wallets": "악세사리", "Scarves": "악세사리", "Ties": "악세사리", "Socks": "악세사리",
  "Innerwear": null, "Loungewear and Nightwear": null, "Saree": null, "Apparel Set": null, "Fragrance": null,
  "Lips": null, "Nails": null, "Makeup": null, "Skin": null, "Skin Care": null, "Eyes": null, "Hair": null,
  "Bath and Body": null, "Free Gifts": null, "Water Bottle": null, "Sports Equipment": null, "Perfumes": null,
  "Cufflinks": "악세사리", "Mufflers": "악세사리", "Gloves": "악세사리", "Umbrellas": null, "Vouchers": null,
  "Home Furnishing": null, "Shoe Accessories": null, "Sports Accessories": null, "Beauty Accessories": null,
  "Wristbands": "악세사리",
};
const MYNTRA_OUTER = /jacket|blazer|sweater|cardigan|coat|shrug|waistcoat|sweatshirt/i;

function fromMyntra(row) {
  let category = MYNTRA_SUB_TO_CAT[row.subCategory];
  if (category === null || category === undefined) return null;
  if (category === "상의" && MYNTRA_OUTER.test(row.articleType)) category = "아우터";
  const g = row.gender;
  return {
    id: row.id,
    name: row.productDisplayName,
    category,
    subCategory: row.articleType,
    color: row.baseColour,
    gender: g === "Men" || g === "Boys" ? "남성" : g === "Women" || g === "Girls" ? "여성" : "공용",
    season: row.season ?? "",
    usage: row.usage ?? "",
    description: "",
    url: `https://www.myntra.com/${row.id}`,
    imageUrl: `images/${row.id}.jpg`,
    source: "Myntra",
  };
}

function fromCustom(row) {
  return { source: "custom", description: "", season: "", usage: "", ...row };
}

function detect(header) {
  if (header.includes("article_id") && header.includes("product_group_name")) return ["H&M", fromHM];
  if (header.includes("productDisplayName") && header.includes("articleType")) return ["Myntra", fromMyntra];
  if (header.includes("name") && header.includes("category")) return ["custom", fromCustom];
  throw new Error(`알 수 없는 CSV 스키마: ${header.join(",")}`);
}

// ---------- 임베딩 ----------
function passageText(it) {
  return [
    `${it.name}.`,
    `Category: ${it.category} / ${it.subCategory}.`,
    `Color: ${it.color}.`,
    `Gender: ${it.gender}.`,
    it.season ? `Season: ${it.season}.` : "",
    it.usage ? `Usage: ${it.usage}.` : "",
    it.description ? it.description.slice(0, 400) : "",
  ].filter(Boolean).join(" ");
}

async function embedBatch(texts) {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, input_type: "passage", encoding_format: "float", truncate: "END" }),
  });
  if (!res.ok) throw new Error(`임베딩 실패 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ---------- 메인 ----------
const text = fs.readFileSync(csvPath, "utf8");
const rows = parseCsv(text);
const [schema, convert] = detect(Object.keys(rows[0]));
console.log(`스키마: ${schema}, 원본 행: ${rows.length}`);

let items = rows.map(convert).filter(Boolean).filter((it) => it.name && it.category);
if (genderFilter !== "all") items = items.filter((it) => it.gender === genderFilter || it.gender === "공용");

// 카테고리 가중 샘플링: 코디의 뼈대인 상의/하의/아우터/신발에 비중을 두고 나머지는 소량
const WEIGHTS = { "상의": 4, "하의": 3, "아우터": 4, "신발": 4, "가방": 1.5, "악세사리": 1, "모자": 0.5, "원피스": 0.5 };
const byCat = new Map();
for (const it of items) { if (!byCat.has(it.category)) byCat.set(it.category, []); byCat.get(it.category).push(it); }
for (const arr of byCat.values()) arr.sort(() => Math.random() - 0.5);
const totalW = [...byCat.keys()].reduce((a, k) => a + (WEIGHTS[k] ?? 1), 0);
const picked = [];
for (const [k, arr] of byCat) picked.push(...arr.slice(0, Math.round(limit * (WEIGHTS[k] ?? 1) / totalW)));
console.log(`선택: ${picked.length}개`, Object.fromEntries([...byCat.keys()].map((k) => [k, picked.filter((p) => p.category === k).length])));

const vectors = [];
const BATCH = 64;
for (let i = 0; i < picked.length; i += BATCH) {
  const chunk = picked.slice(i, i + BATCH);
  vectors.push(...(await embedBatch(chunk.map(passageText))).map((v) => v.map((x) => Math.round(x * 1e4) / 1e4)));
  process.stdout.write(`\r임베딩 ${Math.min(i + BATCH, picked.length)}/${picked.length}`);
}
console.log();

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/catalog-index.json", JSON.stringify({ model: EMBED_MODEL, dim: vectors[0].length, items: picked, vectors }));
console.log(`저장: data/catalog-index.json (${picked.length}개, dim=${vectors[0].length})`);
