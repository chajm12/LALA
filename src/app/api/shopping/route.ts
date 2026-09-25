import { NextResponse } from "next/server";
import { chatJson, JUDGE_MODEL } from "@/lib/nim";
import { normalizeCategory, retrieveProducts, type RetrievedItem } from "@/lib/tools/catalog";
import { agentLog, fallbackLogger, type TraceEvent } from "@/lib/log";

/**
 * 상품 매칭 — 웹검색 대신 카탈로그 RAG.
 * 1) JUDGE 가 outfitItems 를 영어 검색 질의 + 카테고리로 변환 (카탈로그가 영어)
 * 2) 임베딩 NIM(query) 으로 카탈로그 벡터 검색, 카테고리/성별 필터
 * 3) JUDGE 가 상위 후보 중 최적 1개를 고르고 이유를 한국어로 (LLM 리랭킹)
 */
type ShoppingLink = { category?: string; item: string; title: string; url: string; source: string; reason: string; imageUrl?: string; score?: number };

type QueryPlan = { item: string; category: string; query: string };

export async function POST(req: Request) {
  const trace: TraceEvent[] = [];
  try {
    const { keyword, concept } = await req.json();
    const outfitItems: string[] = Array.isArray(concept?.outfitItems) ? concept.outfitItems.map(String) : [];
    if (!outfitItems.length) return NextResponse.json({ links: [], trace });

    const gender = /여성|women|female/i.test(String(concept?.targetCustomer ?? "")) ? "여성" : "남성";

    agentLog("shopping", `착용 아이템 ${outfitItems.length}개를 카탈로그 검색 질의로 변환`, `chat.completions · ${JUDGE_MODEL}`, trace);
    const planned = await chatJson<{ queries: QueryPlan[] }>(JUDGE_MODEL, [
      { role: "system", content: "패션 상품 검색 질의를 만드는 도우미. JSON 만 출력." },
      {
        role: "user",
        content: `착용 아이템 목록 ("카테고리: 아이템" 형식):
${JSON.stringify(outfitItems)}
룩 무드: ${concept?.mood ?? ""} / 색상: ${JSON.stringify(concept?.colorPalette ?? [])}

각 아이템을 영어 상품 검색 질의로 바꿔줘. 색상, 소재, 핏, 품목명을 포함한 8~15단어.
category 는 상의|아우터|하의|신발|가방|악세사리|모자 중 하나.
출력: {"queries": [{"item": 원문, "category": "...", "query": "..."}]}`,
      },
    ], { temperature: 0.1, maxTokens: 1500, onFallback: fallbackLogger("shopping", trace) });

    const queries: QueryPlan[] = Array.isArray(planned.queries) && planned.queries.length
      ? planned.queries
      : outfitItems.map((item) => ({ item, category: normalizeCategory(item) ?? "", query: item }));

    agentLog("catalog", `임베딩 검색 ${queries.length}건 (성별 필터: ${gender})`, "tool:retrieve_products", trace);
    const results = await Promise.all(
      queries.map(async (q) => {
        const cat = normalizeCategory(q.category) ?? normalizeCategory(q.item);
        let hits = await retrieveProducts(q.query, { topK: 4, category: cat, gender });
        if (!hits.length && cat) hits = await retrieveProducts(q.query, { topK: 4, gender }); // 카테고리 매칭 실패 시 완화
        return { q, hits };
      }),
    );

    agentLog("shopping", "후보 상품 중 최적 1개 선택 및 추천 이유 작성 (LLM 리랭킹)", `chat.completions · ${JUDGE_MODEL}`, trace);
    const pick = await chatJson<{ picks: { item: string; id: string; reason: string }[] }>(JUDGE_MODEL, [
      { role: "system", content: "패션 MD. 각 아이템에 가장 잘 맞는 상품 1개를 고르고 한국어 한 줄 이유를 쓴다. JSON 만 출력." },
      {
        role: "user",
        content: `사용자 요청: ${keyword}
룩: ${concept?.name} — ${concept?.description}

아이템별 후보 상품:
${JSON.stringify(results.map(({ q, hits }) => ({ item: q.item, candidates: hits.map((h) => ({ id: h.id, name: h.name, sub: h.subCategory, color: h.color, gender: h.gender })) })))}

출력: {"picks": [{"item": 원문, "id": 선택한 상품 id, "reason": "한국어 한 줄"}]}
후보가 없는 아이템은 생략.`,
      },
    ], { temperature: 0.1, maxTokens: 1500, onFallback: fallbackLogger("shopping", trace) });

    const links: ShoppingLink[] = [];
    for (const { q, hits } of results) {
      if (!hits.length) continue;
      const chosen = pick.picks?.find((p) => p.item === q.item);
      const hit: RetrievedItem = hits.find((h) => h.id === chosen?.id) ?? hits[0];
      links.push({
        category: normalizeCategory(q.category) ?? normalizeCategory(q.item),
        item: q.item,
        title: `${hit.name} (${hit.color}, ${hit.subCategory})`,
        url: hit.url,
        source: hit.source,
        reason: chosen?.reason ?? `임베딩 유사도 ${hit.score.toFixed(2)} 로 가장 근접한 상품`,
        imageUrl: hit.imageUrl,
        score: hit.score,
      });
    }

    agentLog("shopping", `매칭 완료: ${links.length}/${outfitItems.length}개`, undefined, trace);
    return NextResponse.json({ links, trace });
  } catch (e) {
    const message = e instanceof Error ? e.message : "상품 매칭 중 알 수 없는 오류";
    agentLog("shopping", `✗ 요청 실패: ${message}`, undefined, trace);
    return NextResponse.json({ error: message, links: [], trace }, { status: 500 });
  }
}
