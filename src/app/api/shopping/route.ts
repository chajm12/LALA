import { NextResponse } from "next/server";
import { OPENAI_SERVICE_TIER, openai, TREND_MODEL } from "@/lib/openai";
import { agentLog } from "@/lib/log";

type ShoppingLink = {
  category?: string;
  item: string;
  title: string;
  url: string;
  source: string;
  reason: string;
};

type OutfitRequirement = {
  raw: string;
  category?: string;
  item: string;
};

type LinkValidation = {
  ok: boolean;
  reason?: string;
};

const CATEGORY_KEYWORDS = [
  { category: "모자", patterns: ["모자", "볼캡", "캡", "비니", "버킷햇", "hat", "cap", "beanie"] },
  { category: "상의(이너)", patterns: ["티셔츠", "티", "셔츠", "이너", "니트", "스웨터", "맨투맨", "후드", "top", "inner", "t-shirt", "shirt"] },
  { category: "상의(아우터)", patterns: ["아우터", "자켓", "재킷", "블레이저", "코트", "점퍼", "패딩", "가디건", "outer", "jacket", "blazer", "coat"] },
  { category: "상의(레이어드)", patterns: ["레이어드", "베스트", "조끼", "뷔스티에", "vest", "layer"] },
  { category: "하의", patterns: ["바지", "슬랙스", "데님", "청바지", "팬츠", "스커트", "쇼츠", "하의", "pants", "denim", "slacks"] },
  { category: "신발", patterns: ["신발", "스니커즈", "로퍼", "부츠", "구두", "샌들", "shoes", "sneakers", "loafer", "boots"] },
  { category: "가방", patterns: ["가방", "백", "토트", "크로스백", "백팩", "bag", "tote"] },
  { category: "악세사리", patterns: ["악세사리", "액세서리", "목걸이", "반지", "팔찌", "시계", "벨트", "선글라스", "accessory", "necklace", "ring", "belt"] },
];

function detectFocusCategories(keyword: string) {
  const normalized = keyword.toLowerCase();
  return CATEGORY_KEYWORDS
    .filter((entry) => entry.patterns.some((pattern) => normalized.includes(pattern.toLowerCase())))
    .map((entry) => entry.category);
}

function normalizeCategory(value: string) {
  const normalized = value.toLowerCase();
  return CATEGORY_KEYWORDS.find((entry) =>
    entry.patterns.some((pattern) => normalized.includes(pattern.toLowerCase())) ||
    normalized.includes(entry.category.toLowerCase())
  )?.category;
}

function parseOutfitRequirement(raw: string): OutfitRequirement {
  const [left, ...rest] = raw.split(/[:：]/);
  const item = rest.join(":").trim();
  const category = item ? normalizeCategory(left) : normalizeCategory(raw);
  return {
    raw,
    ...(category ? { category } : {}),
    item: item || raw,
  };
}

function sortFocusLinks(links: ShoppingLink[], focusCategories: string[]) {
  if (!focusCategories.length) return links;
  return [...links].sort((a, b) => {
    const aFocused = a.category && focusCategories.includes(a.category) ? 0 : 1;
    const bFocused = b.category && focusCategories.includes(b.category) ? 0 : 1;
    return aFocused - bFocused;
  });
}

const SEARCH_URL_PATTERNS = [
  /\/search\b/i,
  /\/search\//i,
  /\/s\?/i,
  /[?&](q|query|keyword|search|searchKeyword|keyword1)=/i,
  /search\./i,
  /\/catalog\b/i,
  /\/category\b/i,
  /\/categories\b/i,
  /\/collections\b/i,
];

const PRODUCT_URL_PATTERNS = [
  /\/product\b/i,
  /\/products\b/i,
  /\/goods\b/i,
  /\/goods\//i,
  /\/item\b/i,
  /\/items\b/i,
  /goodsNo=/i,
  /productNo=/i,
  /productId=/i,
  /itemNo=/i,
  /itemId=/i,
  /goodsId=/i,
];

function isDirectProductUrl(url: string) {
  if (SEARCH_URL_PATTERNS.some((pattern) => pattern.test(url))) return false;
  return PRODUCT_URL_PATTERNS.some((pattern) => pattern.test(url));
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  return JSON.parse(source.slice(start, end + 1));
}

function normalizeLinks(value: unknown, options: { allowSearchFallback?: boolean } = {}): ShoppingLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const link = item as Record<string, unknown>;
      const url = typeof link.url === "string" ? link.url : "";
      if (!/^https?:\/\//.test(url)) return null;
      if (!options.allowSearchFallback && !isDirectProductUrl(url)) return null;
      const category = typeof link.category === "string"
        ? link.category
        : normalizeCategory(String(link.item ?? ""));
      return {
        ...(category ? { category } : {}),
        item: String(link.item ?? "추천 아이템"),
        title: String(link.title ?? "비슷한 상품"),
        url,
        source: String(link.source ?? new URL(url).hostname),
        reason: String(link.reason ?? "최종 착장과 유사한 아이템이에요."),
      };
    })
    .filter((item): item is ShoppingLink => item !== null)
    .slice(0, 12);
}

const UNAVAILABLE_TEXT_PATTERNS = [
  /상품이\s*존재하지\s*않/i,
  /존재하지\s*않는\s*상품/i,
  /판매\s*종료/i,
  /품절/i,
  /일시\s*품절/i,
  /재고가\s*없/i,
  /검색\s*결과가\s*없/i,
  /검색결과가\s*없/i,
  /찾을\s*수\s*없/i,
  /페이지를\s*찾을\s*수\s*없/i,
  /not\s*found/i,
  /sold\s*out/i,
  /out\s*of\s*stock/i,
  /no\s*results/i,
  /no\s*products/i,
];

const PRODUCT_PAGE_HINTS = [
  /og:type["']?\s*content=["']product/i,
  /product:price/i,
  /application\/ld\+json/i,
  /"@type"\s*:\s*"Product"/i,
  /장바구니/i,
  /구매하기/i,
  /바로\s*구매/i,
  /상품\s*정보/i,
  /판매가/i,
  /price/i,
];

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function validateShoppingLink(link: ShoppingLink): Promise<LinkValidation> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(link.url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return { ok: true };
    }

    const html = await response.text();
    const bodyText = stripHtml(html).slice(0, 50000);
    if (UNAVAILABLE_TEXT_PATTERNS.some((pattern) => pattern.test(bodyText))) {
      return { ok: false, reason: "없는 상품/품절/빈 결과 문구 감지" };
    }

    if (isDirectProductUrl(link.url) && PRODUCT_PAGE_HINTS.some((pattern) => pattern.test(html))) {
      return { ok: true };
    }

    if (!isDirectProductUrl(link.url) && bodyText.length < 800) {
      return { ok: false, reason: "상품 정보가 부족한 페이지" };
    }

    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error && e.name === "AbortError" ? "검증 타임아웃" : "페이지 접근 실패",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function filterValidShoppingLinks(links: ShoppingLink[]) {
  const results = await Promise.all(
    links.map(async (link) => ({
      link,
      validation: await validateShoppingLink(link),
    })),
  );
  const invalid = results.filter((result) => !result.validation.ok);
  if (invalid.length) {
    agentLog(
      "shopping",
      `실제 상품 없음/접근 실패 링크 ${invalid.length}개 제거: ${invalid
        .map((item) => `${item.link.item}(${item.validation.reason})`)
        .join(", ")}`,
    );
  }
  return results.filter((result) => result.validation.ok).map((result) => result.link);
}

// One web_search_preview call per category (run via Promise.all) instead
// of one giant call covering every category, plus a full re-search when
// anything's missing. Same matching bar (direct product URL, color/fit/
// material/design match) - just scoped down and run concurrently, so a
// category that comes up short only costs a second call for that category,
// not a full-scope redo. Kept alongside OPENAI_SERVICE_TIER and the
// filterValidShoppingLinks existence check - independent speed/quality levers.

function groupItemsByCategory(outfitItems: string[]) {
  const groups = new Map<string, string[]>();
  for (const raw of outfitItems) {
    const { category, item } = parseOutfitRequirement(raw);
    const key = category ?? "기타";
    groups.set(key, [...(groups.get(key) ?? []), item || raw]);
  }
  return groups;
}

async function searchCategoryLinks({
  category,
  items,
  keyword,
  concept,
  strict,
}: {
  category: string;
  items: string[];
  keyword: string;
  concept: Record<string, unknown>;
  strict: boolean;
}) {
  const itemText = items.join(", ");
  const rules = strict
    ? `우선순위:
1. 무신사, 29CM, W컨셉, EQL, SSF샵, 브랜드 공식몰, 백화점/편집샵
2. 반드시 실제 상품 상세 페이지 URL만 선택
3. 색감, 핏, 재질/원단, 디자인 중 최소 3개 이상이 룩북 아이템과 맞는 상품만 선택

주의:
- 존재하지 않는 URL을 만들지 마.
- 검색 결과 페이지, 카테고리 페이지, 기획전 페이지, 브랜드 메인 페이지, 블로그/뉴스/핀터레스트 링크는 절대 반환하지 마.
- 직접 구매 가능한 상품 상세 페이지가 아니면 반환하지 마.
- 가능한 한 URL에 product, goods, item, products, shop, goodsNo 등 상품 상세를 암시하는 링크를 골라.
- URL에 search, query, keyword, category, collection 같은 검색/목록 단어가 있으면 제외해.
- 색감/소재/핏/디자인이 룩북과 너무 다르면 제외해.`
    : `직접 상품 상세 링크를 충분히 못 찾았을 가능성이 있으니, 이번엔 쇼핑 검색 결과 링크도 허용해.
단, 일반적인 넓은 검색어가 아니라 색상 + 핏/실루엣 + 소재/원단 + 디자인 디테일 + 아이템명이 들어간 정교한 검색어로 연결되는 결과여야 해.
예: "네이비 세미오버 린넨 블레이저", "블랙 와이드 울 슬랙스", "브라운 스웨이드 로퍼".
블로그/뉴스/핀터레스트는 여전히 금지.`;

  const response = await openai.responses.create({
    model: TREND_MODEL,
    service_tier: OPENAI_SERVICE_TIER,
    tools: [{ type: "web_search_preview" }],
    input: `사용자 요청: ${keyword}

최종 착장 컨셉:
- 이름: ${concept.name}
- 무드: ${concept.mood}
- 색감: ${Array.isArray(concept.colorPalette) ? concept.colorPalette.join(", ") : ""}
- 원단/질감: ${Array.isArray(concept.materials) ? concept.materials.join(", ") : ""}

지금 찾아야 할 카테고리: ${category}
이 카테고리의 아이템: ${itemText}

위 아이템과 색감/핏/재질/디자인이 비슷한 옷을 실제로 살 수 있는 한국어 쇼핑 링크를 웹검색으로 찾아줘. 이 카테고리에 대해 최소 1개 이상의 링크를 찾아야 해.

${rules}

- category 필드는 반드시 "${category}"로 써.
- item 필드는 원래 아이템명과 대응되게 써.
- 결과는 반드시 한국어 JSON만 반환해. 설명 문장, 마크다운 금지.

JSON 스키마:
{ "links": [ { "category": "${category}", "item": "아이템명", "title": "상품명", "url": "https://...", "source": "사이트명", "reason": "색감, 핏, 재질/원단, 디자인 중 무엇이 비슷한지 한 문장" } ] }

links는 최대 2개.`,
  });

  const parsed = parseJsonObject(response.output_text);
  return normalizeLinks((parsed as Record<string, unknown>).links, { allowSearchFallback: !strict });
}

async function searchAllLinksFallback(keyword: string, concept: Record<string, unknown>) {
  // No structured outfitItems to group by category (e.g. description-only
  // concept) - fall back to a single broad-scope search.
  agentLog(
    "shopping",
    `아이템 목록이 없어 전체 범위 검색 실행`,
    `responses.create + web_search_preview · ${TREND_MODEL} · ${OPENAI_SERVICE_TIER}`,
  );
  return searchCategoryLinks({
    category: "전체",
    items: [String(concept.description ?? concept.name ?? "")],
    keyword,
    concept,
    strict: false,
  });
}

export async function POST(req: Request) {
  try {
    const { keyword, concept } = await req.json();
    if (!concept || typeof concept !== "object") {
      throw new Error("구매 링크를 찾을 컨셉 정보가 없어요.");
    }

    const outfitItems: string[] = Array.isArray(concept.outfitItems)
      ? concept.outfitItems.map((item: unknown) => String(item)).filter(Boolean)
      : [];
    const focusCategories = detectFocusCategories(keyword);

    if (outfitItems.length === 0) {
      agentLog("shopping", `"${concept.name ?? "최종 착장"}" 비슷한 구매 링크 검색 시작`);
      const links = sortFocusLinks(
        await filterValidShoppingLinks(await searchAllLinksFallback(keyword, concept)),
        focusCategories,
      ).slice(0, 12);
      agentLog("shopping", `구매 링크 ${links.length}개 검색 완료`);
      return NextResponse.json({ links });
    }

    const groups = groupItemsByCategory(outfitItems);
    const categories = [...groups.keys()];

    agentLog(
      "shopping",
      `"${concept.name ?? "최종 착장"}" 카테고리 ${categories.length}개 병렬 검색 시작: ${categories.join(", ")}`,
      `responses.create + web_search_preview · ${TREND_MODEL} · ${OPENAI_SERVICE_TIER} (동시 ${categories.length}건)`,
    );

    const primaryResults = await Promise.all(
      categories.map((category) =>
        searchCategoryLinks({ category, items: groups.get(category)!, keyword, concept, strict: true }),
      ),
    );

    // Validation failures just drop the link - no fallback re-search. A
    // second round after every rejected link doubled latency for a
    // marginal quality gain; better to return fewer, verified links fast.
    const links = sortFocusLinks(await filterValidShoppingLinks(primaryResults.flat()), focusCategories).slice(
      0,
      12,
    );
    agentLog("shopping", `구매 링크 ${links.length}개 검색 완료 (병렬)`);

    return NextResponse.json({ links });
  } catch (e) {
    const message = e instanceof Error ? e.message : "구매 링크 검색 중 알 수 없는 오류";
    agentLog("shopping", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
