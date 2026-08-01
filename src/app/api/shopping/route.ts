import { NextResponse } from "next/server";
import { openai, TREND_MODEL } from "@/lib/openai";
import { agentLog } from "@/lib/log";

type ShoppingLink = {
  item: string;
  title: string;
  url: string;
  source: string;
  reason: string;
};

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
      return {
        item: String(link.item ?? "추천 아이템"),
        title: String(link.title ?? "비슷한 상품"),
        url,
        source: String(link.source ?? new URL(url).hostname),
        reason: String(link.reason ?? "최종 착장과 유사한 아이템이에요."),
      };
    })
    .filter((item): item is ShoppingLink => item !== null)
    .slice(0, 8);
}

async function searchFallbackLinks({
  keyword,
  concept,
  outfitItems,
  outfitItemText,
}: {
  keyword: string;
  concept: Record<string, unknown>;
  outfitItems: string[];
  outfitItemText: string;
}) {
  agentLog(
    "shopping",
    "직접 상품 링크 0개 → 정교한 쇼핑 검색 결과 fallback 실행",
    `responses.create + web_search_preview · ${TREND_MODEL}`,
  );

  const response = await openai.responses.create({
    model: TREND_MODEL,
    tools: [{ type: "web_search_preview" }],
    input: `사용자 요청: ${keyword}

최종 착장:
- 이름: ${concept.name}
- 설명: ${concept.description}
- 무드: ${concept.mood}
- 색감: ${Array.isArray(concept.colorPalette) ? concept.colorPalette.join(", ") : ""}
- 아이템: ${outfitItemText}
- 원단/질감: ${Array.isArray(concept.materials) ? concept.materials.join(", ") : ""}

직접 상품 상세 링크를 충분히 찾지 못했으므로, 이번에는 쇼핑 검색 결과 링크를 찾아줘.
단, 일반적인 넓은 검색어가 아니라 룩북 아이템의 색감, 핏, 재질/원단, 디자인이 최대한 들어간 정교한 검색어로 연결되는 쇼핑 검색 결과여야 해.

아이템별 검색어 작성 규칙:
- 각 아이템마다 색상 + 핏/실루엣 + 소재/원단 + 디자인 디테일 + 아이템명을 포함해.
- 예: "네이비 세미오버 린넨 블레이저", "블랙 와이드 울 슬랙스", "브라운 스웨이드 로퍼".
- 룩북과 관계없는 브랜드명이나 과도하게 넓은 단어만 쓰지 마.
- 쇼핑몰 검색 결과 URL이어도 검색어가 URL 또는 title/reason에 명확히 드러나야 해.

대상 아이템:
${outfitItems.length ? outfitItems.map((item, index) => `${index + 1}. ${item}`).join("\n") : "- 설명에서 상의/하의/아우터/신발/가방/액세서리를 추출"}

우선 쇼핑몰:
무신사, 29CM, W컨셉, EQL, SSF샵, 브랜드 공식몰, 백화점/편집샵

주의:
- 상품 상세 링크를 만들지 마. 실제로 접근 가능한 쇼핑 검색 결과 링크만 써.
- 블로그/뉴스/핀터레스트 금지.
- 검색어가 색감/핏/재질/디자인을 충분히 포함하지 않으면 제외해.
- 결과는 반드시 한국어 JSON만 반환해. 설명 문장, 마크다운 금지.

JSON 스키마:
{
  "links": [
    {
      "item": "아이템명",
      "title": "정교한 검색어 또는 검색 결과 제목",
      "url": "https://...",
      "source": "사이트명",
      "reason": "검색어가 룩북의 색감, 핏, 재질/원단, 디자인 중 무엇을 반영하는지 한 문장"
    }
  ]
}

links는 핵심 아이템 수만큼, 최대 8개.`,
  });

  const parsed = parseJsonObject(response.output_text);
  return normalizeLinks((parsed as Record<string, unknown>).links, { allowSearchFallback: true });
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
    const outfitItemText = outfitItems.length ? outfitItems.join(", ") : concept.description;

    agentLog(
      "shopping",
      `"${concept.name ?? "최종 착장"}" 비슷한 구매 링크 검색 시작`,
      `responses.create + web_search_preview · ${TREND_MODEL}`,
    );

    const response = await openai.responses.create({
      model: TREND_MODEL,
      tools: [{ type: "web_search_preview" }],
      input: `사용자 요청: ${keyword}

최종 착장:
- 이름: ${concept.name}
- 설명: ${concept.description}
- 무드: ${concept.mood}
- 색감: ${Array.isArray(concept.colorPalette) ? concept.colorPalette.join(", ") : ""}
- 아이템: ${outfitItemText}
- 원단/질감: ${Array.isArray(concept.materials) ? concept.materials.join(", ") : ""}

위 착장과 비슷한 옷을 실제로 살 수 있는 한국어 쇼핑 링크를 웹검색으로 찾아줘.
가장 중요한 목표는 "룩북에 나온 모든 핵심 아이템에 대해 색감, 핏, 재질/원단, 디자인이 가장 비슷한 직접 상품 상세 링크를 찾는 것"이야.
아래 아이템 목록이 있으면 각 아이템마다 최소 1개 이상의 직접 상품 상세 링크를 찾아야 해:
${outfitItems.length ? outfitItems.map((item, index) => `${index + 1}. ${item}`).join("\n") : "- 아이템 목록이 없으면 설명에서 상의/하의/아우터/신발/가방/액세서리를 추출"}

우선순위:
1. 무신사, 29CM, W컨셉, EQL, SSF샵, 브랜드 공식몰, 백화점/편집샵
2. 착장 전체가 아니라 상의/하의/아우터/신발/가방/액세서리 등 핵심 아이템별 유사 상품
3. 반드시 실제 상품 상세 페이지 URL만 선택
4. 색감, 핏, 재질/원단, 디자인 중 최소 3개 이상이 룩북 아이템과 맞는 상품만 선택

주의:
- 존재하지 않는 URL을 만들지 마.
- 검색 결과 페이지, 카테고리 페이지, 기획전 페이지, 브랜드 메인 페이지, 블로그/뉴스/핀터레스트 링크는 절대 반환하지 마.
- 직접 구매 가능한 상품 상세 페이지가 아니면 반환하지 마.
- 가능한 한 URL에 product, goods, item, products, shop, goodsNo 등 상품 상세를 암시하는 링크를 골라.
- URL에 search, query, keyword, category, collection 같은 검색/목록 단어가 있으면 제외해.
- 같은 쇼핑몰만 반복하지 말고 서로 다른 핵심 아이템의 직접 상품 링크를 섞어.
- item 필드는 반드시 원래 아이템명과 대응되게 써. 예: "체크 셔츠", "와이드 슬랙스", "로퍼".
- 링크 제목이 아이템과 맞지 않으면 포함하지 마.
- 색감/소재/핏/디자인이 룩북과 너무 다르면 제외해.
- 직접 상품 상세 링크를 찾지 못한 아이템은 검색 결과로 대체하지 말고 links에서 제외해.
- 결과는 반드시 한국어 JSON만 반환해. 설명 문장, 마크다운 금지.

JSON 스키마:
{
      "links": [
    {
      "item": "아이템명",
      "title": "상품명",
      "url": "https://...",
      "source": "사이트명",
      "reason": "색감, 핏, 재질/원단, 디자인 중 무엇이 비슷한지 한 문장"
    }
  ]
}

links는 직접 상품 상세 링크만 포함하고, 최대 8개.`,
    });

    const parsed = parseJsonObject(response.output_text);
    let links = normalizeLinks((parsed as Record<string, unknown>).links);
    if (links.length === 0) {
      links = await searchFallbackLinks({ keyword, concept, outfitItems, outfitItemText });
    }
    agentLog("shopping", `구매 링크 ${links.length}개 검색 완료`);

    return NextResponse.json({ links });
  } catch (e) {
    const message = e instanceof Error ? e.message : "구매 링크 검색 중 알 수 없는 오류";
    agentLog("shopping", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
