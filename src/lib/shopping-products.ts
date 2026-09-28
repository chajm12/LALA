export type ShoppingProduct = {
  kind: "product";
  category: string;
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

export type ProductRequirement = { category: string; item: string; raw: string; targetGender?: "male" | "female"; color?: string; pattern?: string; sleeve?: string; material?: string; fit?: string; closure?: string; brand?: string; model?: string; length?: string };
export type ProductEvidence = { title: string; description: string; brand: string; color: string; category: string; imageUrl?: string; price?: string; unavailable: boolean };

const RETAILERS = [
  "musinsa.com", "29cm.co.kr", "kream.co.kr", "a-bly.com", "converse.co.kr", "newbalance.co.kr",
  "uniqlo.com", "nike.com", "adidas.co.kr", "adidas.com", "wconcept.co.kr", "ssfshop.com", "eqlstore.com",
];

export function isShoppingHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && (!parsed.port || parsed.port === "443") &&
      RETAILERS.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function isSpecificProductUrl(value: string): boolean {
  if (!isShoppingHost(value)) return false;
  const url = new URL(value);
  if (/\/(search|category|categories|collections|brands|events)(\/|$)/i.test(url.pathname)) return false;
  if ([...url.searchParams.keys()].some(key => /^(q|query|keyword|search|searchKeyword)$/i.test(key))) return false;
  if (/29cm\.co\.kr$/.test(url.hostname) && /^\/(?:catalog|products)\/\d+\/?$/.test(url.pathname)) return true;
  if (/a-bly\.com$/.test(url.hostname) && /^\/goods\/\d+\/?$/.test(url.pathname)) return true;
  if (/\/(?:products?|goods|items?)\/(?:[^/]+)(?:\/[^/]+)*\/?$/i.test(url.pathname)) return true;
  if ([...url.searchParams.entries()].some(([key, val]) => /^(goodsNo|productNo|productId|itemNo|itemId|goodsId|prdtNo)$/i.test(key) && /^[\w-]+$/.test(val))) return true;
  // Official retailer detail conventions that do not use /product/.
  if (/converse\.co\.kr$/.test(url.hostname) && /\/product-detail\//.test(url.pathname)) return true;
  if (/nike\.com$/.test(url.hostname) && /^\/t\/[^/]+\//.test(url.pathname)) return true;
  if (/adidas\.(?:co\.kr|com)$/.test(url.hostname) && /\/[A-Z0-9]+\.html$/i.test(url.pathname)) return true;
  return false;
}

export function canonicalProductUrl(value: string): string | null {
  if (!isSpecificProductUrl(value)) return null;
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|ref$|source$|campaign|click|gclid|fbclid)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function plain(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(?:x([a-f0-9]+)|(\d+));/gi, (_, hex, num) => String.fromCodePoint(parseInt(hex || num, hex ? 16 : 10))).replace(/\s+/g, " ").trim() : "";
}

function meta(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(match => [match[1].toLowerCase(), match[2]]));
    if (attrs.property === key || attrs.name === key) return plain(attrs.content);
  }
  return "";
}

function productNodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(productNodes);
  const record = value as Record<string, unknown>;
  const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
  if (types.includes("Product")) return [record];
  return Object.values(record).flatMap(productNodes);
}

export function readProductEvidence(html: string, pageUrl?: string): ProductEvidence | null {
  const products: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { products.push(...productNodes(JSON.parse(match[1]))); } catch { /* Broken unrelated structured blocks are ignored. */ }
  }
  const ogTitle = meta(html, "og:title");
  // Only use the main Product; related/recommended product blocks are not availability evidence.
  const samePage = (value: unknown) => {
    if (!pageUrl || !plain(value)) return false;
    try {
      const found = new URL(plain(value), pageUrl), expected = new URL(pageUrl);
      const host = (value: string) => value.replace(/^(www|m|product)\./, "");
      if (host(found.hostname) !== host(expected.hostname)) return false;
      if (found.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "")) return true;
      const foundId = found.pathname.match(/\/(\d+)\/?$/)?.[1], expectedId = expected.pathname.match(/\/(\d+)\/?$/)?.[1];
      return !!foundId && foundId === expectedId;
    } catch { return false; }
  };
  const product = products.find(value => samePage(value.url)) ?? products.find(value => plain(value.name) && ogTitle.toLowerCase().includes(plain(value.name).toLowerCase())) ?? (!ogTitle && products.length === 1 ? products[0] : undefined);
  if (product && pageUrl && plain(product.url) && !samePage(product.url)) return null;
  const title = plain(product?.name) || ogTitle || plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  if (!title || /존재하지\s*않|찾을\s*수\s*없|페이지.*없|not\s*found|access denied|just a moment|captcha/i.test(title)) return null;
  const hasDetailEvidence = !!product || (!!ogTitle && (meta(html, "og:image") !== "" || /product:price|장바구니|구매하기|상품\s*정보/.test(html)));
  if (!hasDetailEvidence) return null;
  const offersValue = product?.offers;
  const offers = (Array.isArray(offersValue) ? offersValue : [offersValue]).filter((value): value is Record<string, unknown> => !!value && typeof value === "object");
  const states = offers.map(value => plain(value.availability)).filter(Boolean);
  const unavailable = (states.length > 0 && states.every(value => /OutOfStock|SoldOut|Discontinued/i.test(value))) || /(?:^|[\[(:\s])(?:품절|판매\s*종료|sold\s*out)(?:$|[\]):\s])/i.test(title);
  const brand = product?.brand;
  const brandText = typeof brand === "object" && brand ? plain((brand as Record<string, unknown>).name) : plain(brand);
  const description = plain(product?.description) || meta(html, "og:description") || meta(html, "description");
  const image = product?.image;
  const imageUrl = plain(Array.isArray(image) ? image[0] : typeof image === "object" && image ? (image as Record<string, unknown>).url : image) || meta(html, "og:image");
  const offer = offers.find(value => value.price != null && !/OutOfStock|SoldOut|Discontinued/i.test(plain(value.availability))) ?? offers[0];
  const priceNumber = Number(offer?.price ?? meta(html, "product:price:amount"));
  const currency = plain(offer?.priceCurrency) || meta(html, "product:price:currency");
  const price = Number.isFinite(priceNumber) && priceNumber > 0 && currency === "KRW" ? `${Math.round(priceNumber).toLocaleString("ko-KR")}원` : undefined;
  return { title, description, brand: brandText, color: plain(product?.color), category: plain(product?.category), unavailable, ...(imageUrl.startsWith("https://") ? { imageUrl } : {}), ...(price ? { price } : {}) };
}

const BRANDS = [
  ["컨버스", "converse"], ["뉴발란스", "new balance", "newbalance"], ["유니클로", "uniqlo"],
  ["나이키", "nike"], ["아디다스", "adidas"], ["스투시", "stussy", "stüssy"],
];
const COLORS = [
  ["블랙", "검정", "검은", "black"], ["화이트", "흰색", "흰", "백색", "white"],
  ["네이비", "남색", "navy"], ["차콜", "차콜그레이", "charcoal"], ["그레이", "회색", "gray", "grey", "실버", "silver"],
  ["카키", "khaki", "올리브", "olive"], ["베이지", "beige"], ["인디고", "indigo"], ["카멜", "camel"],
  ["브라운", "갈색", "brown"], ["버건디", "burgundy", "와인", "wine"], ["그린", "초록", "녹색", "green"],
];
function containsTerm(text: string, term: string) {
  if (term.length >= 2 && /[가-힣]/.test(term)) return text.includes(term);
  return new RegExp(`(?:^|[^a-zA-Z가-힣])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-zA-Z가-힣])`, "i").test(text);
}
function hasAlias(text: string, terms: string[]) { return terms.some(term => containsTerm(text, term)); }

export function evidenceMatches(requirement: ProductRequirement, evidence: ProductEvidence): boolean {
  const wantedItem = requirement.item.toLowerCase();
  const wanted = [requirement.item, requirement.color, requirement.pattern, requirement.sleeve, requirement.material, requirement.closure, requirement.brand, requirement.model, requirement.length].filter(Boolean).join(" ").toLowerCase();
  // Only retrieved product metadata is used, never the model's similarity explanation.
  const found = `${evidence.title} ${evidence.brand} ${evidence.color}`.toLowerCase();
  const garmentType = `${evidence.title} ${evidence.category ?? ""}`;
  if (evidence.unavailable) return false;
  if (requirement.targetGender === "male" && /여성|우먼|우먼스|women|womens|ladies/i.test(evidence.title) && !/남녀공용|공용|unisex/i.test(evidence.title)) return false;
  const requiredBrands = BRANDS.filter(aliases => hasAlias(wanted, aliases));
  if (requiredBrands.length > 1 && /또는|아니면|\bor\b|\/|나\s|이나\s/i.test(wanted)) {
    if (!requiredBrands.some(aliases => hasAlias(found, aliases))) return false;
  } else if (requiredBrands.some(aliases => !hasAlias(found, aliases))) return false;
  const requiredColors = COLORS.filter(aliases => hasAlias(requirement.color || requirement.item, aliases));
  const foundColors = COLORS.filter(aliases => hasAlias(found, aliases));
  if (requiredColors.length && foundColors.length && !requiredColors.some(aliases => foundColors.includes(aliases))) return false;
  // Unknown color is not a match claim; the image comparison resolves it later.
  const modelNumber = requirement.model?.match(/(?:^|\D)(530|574|990|991|992|993|2002|1906)(?:\D|$)/)?.[1] ?? requirement.item.match(/(?:뉴발란스|new\s*balance).*?\b(530|574|990|991|992|993|2002|1906)\b/i)?.[1];
  if (modelNumber && !found.includes(modelNumber)) return false;
  const plainWanted = /무지|단색|솔리드|\bsolid\b|\bplain\b/i.test(wanted);
  const loudPattern = /카모|카무|밀리터리\s*(?:패턴|프린트)|camouflage|\bcamo\b|프린트(?!스타)|프린팅|그래픽|\bgraphic\b|\bprint(?:ed)?\b|체크|\bcheck(?:ed)?\b|플래드|\bplaid\b|스트라이프|\bstripe(?:d)?\b|패치워크|\bpatchwork\b/i;
  if (plainWanted && loudPattern.test(garmentType)) return false;
  if (/긴팔|장소매|long[-\s]*sleeve/i.test(wanted) && /민소매|슬리브리스|반팔|sleeveless|short[-\s]*sleeve|tank\b|베스트|\bvest\b/i.test(garmentType)) return false;
  if (/민소매|슬리브리스|sleeveless/i.test(wanted) && /긴팔|반팔|long[-\s]*sleeve|short[-\s]*sleeve/i.test(garmentType)) return false;
  if (/단추|버튼|button/i.test(wanted) && /하프집|집업|zip[-\s]*up|half[-\s]*zip/i.test(garmentType)) return false;
  if (/직물|우븐|woven|옥스포드|oxford/i.test(wanted) && /니트|knit|저지|jersey/i.test(garmentType)) return false;
  if (requirement.category === "하의") {
    if (/코튼|직물|우븐|woven|cotton/i.test(requirement.material ?? "") && /트랙|트레이닝|조거|스웨트|track|training|jogger|sweat/i.test(garmentType) && !/트랙|트레이닝|조거|스웨트|track|training|jogger|sweat/i.test(requirement.item)) return false;
    if (/치노|면바지|chino/i.test(wanted) && /트랙|트레이닝|조거|스웨트|track|training|jogger|sweat|데님|denim|jeans/i.test(garmentType)) return false;
    if (/데님|청바지|블랙진|denim|jeans/i.test(wanted) && !/데님|청바지|블랙진|denim|jeans/i.test(garmentType)) return false;
    if (/카고|cargo/i.test(wanted) && !/카고|cargo/i.test(garmentType)) return false;
  }
  if (requirement.category === "상의" && !/베스트|조끼|vest/i.test(wanted) && /베스트|조끼|vest/i.test(garmentType)) return false;
  const types: Record<string, RegExp> = {
    "상의": /티셔츠|반팔|긴팔|셔츠|니트|스웨터|맨투맨|후드|t-?shirt|shirt|sweater|knit|hoodie|sweatshirt|polo/i,
    "하의": /팬츠|바지|슬랙스|데님|청바지|스커트|쇼츠|pants|trouser|slacks|jeans|denim|skirt|shorts/i,
    "신발": /신발|스니커|슈즈|로퍼|샌들|구두|부츠|척\s*70|척테일러|574|530|990|2002|sneaker|shoe|loafer|boot|chuck|all\s*star/i,
    "아우터": /재킷|자켓|코트|점퍼|블루종|가디건|패딩|아우터|베스트|조끼|jacket|coat|cardigan|blouson|outerwear|vest/i,
  };
  if (!(types[requirement.category]?.test(garmentType) ?? false)) return false;
  if (/셔츠|shirt/i.test(wantedItem) && !/티셔츠|티\s*셔츠|t-?shirt|스웨트셔츠|sweatshirt/i.test(wantedItem)) {
    if (!/셔츠|shirt/i.test(garmentType) || /티셔츠|t-?shirt|스웨트셔츠|sweatshirt/i.test(garmentType)) return false;
  }
  const families = [
    { requested: /베스트|조끼|vest/i, product: /베스트|조끼|vest/i },
    { requested: /패딩|puffer|down jacket/i, product: /패딩|푸퍼|다운|puffer|down/i },
    { requested: /티셔츠|반팔티|긴팔티|t-?shirt/i, product: /티셔츠|반팔티|긴팔티|t-?shirt|크루넥\s*티|반팔\s*티|긴팔\s*티/i },
    { requested: /맨투맨|스웨트셔츠|sweatshirt/i, product: /맨투맨|스웨트셔츠|sweatshirt/i },
    { requested: /니트|스웨터|sweater|knit/i, product: /니트|스웨터|sweater|knit/i },
    { requested: /슬랙스|slacks/i, product: /슬랙스|slacks|trouser|정장\s*바지/i },
    { requested: /스니커|sneaker/i, product: /스니커|sneaker|척\s*70|척테일러|chuck|all\s*star|574|530|990|2002/i },
    { requested: /로퍼|loafer/i, product: /로퍼|loafer/i },
    { requested: /샌들|sandal/i, product: /샌들|sandal/i },
    { requested: /부츠|boots?/i, product: /부츠|boots?/i },
    { requested: /코트|coat/i, product: /코트|coat/i },
    { requested: /재킷|자켓|jacket/i, product: /재킷|자켓|jacket|블루종|점퍼/i },
  ];
  for (const family of families) if (family.requested.test(wantedItem) && !family.product.test(garmentType)) return false;
  if (requirement.category === "하의" && /재킷|자켓|셔츠|코트|jacket|shirt|coat/i.test(evidence.title) && !/팬츠|바지|slacks|pants|jeans|trouser|skirt|스커트|쇼츠/i.test(evidence.title)) return false;
  return true;
}




