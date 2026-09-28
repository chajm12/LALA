import { NextResponse } from "next/server";
import { OPENAI_SERVICE_TIER, OPENAI_SHOPPING_MODEL, openai, parseJsonObjectFromText } from "@/lib/openai";
import { agentLog } from "@/lib/log";
import { sanitizeCoreConcept } from "@/lib/garments";
import { readGarmentSpecs, garmentSpecText } from "@/lib/garment-specs";
import { bounded, fetchShoppingDocument, isProductImageUrl, unavailableShoppingHosts } from "@/lib/shopping-fetch";
import { inspectLookbookGarments, compareProductImages, isLookbookDataImage } from "@/lib/shopping-visual";
import { canonicalProductUrl, evidenceMatches, readProductEvidence, type ProductRequirement, type ShoppingProduct } from "@/lib/shopping-products";

const ROUTE_BUDGET_MS = 110_000;
const SEARCH_BUDGET_MS = 25_000;

async function validateProduct(raw: Record<string, unknown>, requirements: ProductRequirement[], signal: AbortSignal): Promise<ShoppingProduct | null> {
  const index = typeof raw.requirementIndex === "number" ? raw.requirementIndex : -1;
  const requirement = requirements[index] ?? requirements.find(value => value.category === raw.category && (raw.item === value.item || raw.item === value.raw));
  const url = canonicalProductUrl(String(raw.url ?? ""));
  if ((!requirement && raw.fromSource !== true) || !url) return null;
  try {
    const page = await fetchShoppingDocument(url, false, signal);
    const evidence = page?.text ? readProductEvidence(page.text, url) : null;
    if (!evidence) return null;
    const matched = requirement ?? requirements.find(value => evidenceMatches(value, evidence));
    if (!matched || !evidenceMatches(matched, evidence)) {
      agentLog("shopping", `품목별 색상·무늬·소매·종류 불일치 제외: ${evidence.title}`); return null;
    }
    return {
      kind: "product", category: matched.category, item: matched.item,
      title: evidence.title, url, source: new URL(url).hostname.replace(/^www\./, ""),
      reason: "판매처 상세 정보로 찾은 상품 후보입니다. 사진 비교는 아직 완료하지 않았습니다.",
      visualStatus: "unverified",
      ...(evidence.imageUrl && isProductImageUrl(evidence.imageUrl) ? { imageUrl: evidence.imageUrl } : {}), ...(evidence.price ? { price: evidence.price } : {}),
    };
  } catch { return null; }
}

function productQuery(value: ProductRequirement) {
  const extras = [value.color, value.pattern, value.sleeve, value.brand, value.model].filter((term): term is string => !!term && !value.item.toLowerCase().includes(term.toLowerCase()));
  return [...new Set(extras), value.item].join(" ");
}
function searchPrompt(concept: Record<string, unknown>, requirements: ProductRequirement[], retry: boolean, rejectedUrls: string[]) {
  return `패션 착장에 맞는 실제 개별 상품을 웹검색으로 찾으세요. 검색 결과·목록·기획전 URL은 반환하지 마세요.
검색할 착용 품목(인덱스는 이 목록 기준):
${requirements.map((value, index) => `${index}: ${value.category}: ${productQuery(value)} · 필수 시각 조건: ${JSON.stringify({color:value.color,pattern:value.pattern,sleeve:value.sleeve,material:value.material,closure:value.closure,brand:value.brand,model:value.model,length:value.length})}`).join("\n")}
대상: ${requirements[0]?.targetGender === "male" ? "남성 또는 공용 (여성 전용 상품 제외)" : requirements[0]?.targetGender === "female" ? "여성 또는 공용" : "미지정, 공용 우선"}
검색어는 각 품목의 간결한 색상·종류·브랜드·모델을 사용하세요. 세부 조건 JSON은 결과를 확인할 때 사용하고, 전부 검색창에 붙이지 마세요. 티셔츠의 knit는 저지 편성 원단을 뜻하며 니트 스웨터/니트 폴로를 뜻하지 않습니다. 풀오버는 여밈 방식이며 검색 키워드에서 빼세요.
전역 색상표로 개별 품목 색을 추측하지 마세요. 각 품목에 기록된 색상만 해당 품목에 적용하세요.
유사도 참고 핏(필수 조건 아님): ${String(concept.fitStrategy ?? "미지정").replace(/\d+(?:\.\d+)?\s*(?:cm|kg)/gi, "").slice(0, 160)}
${retry ? "첫 검색에서 이 품목의 상품 상세를 확인하지 못했습니다. 각 품목을 따로 검색하고, 먼저 접근 가능한 판매처의 다른 개별 상품을 찾으세요. 필요할 때 판매처를 바꾸세요." : "각 품목에 가장 가까운 실제 상품 후보를 찾으세요."}
현재 요청 제한으로 이용할 수 없는 판매처: ${unavailableShoppingHosts().join(", ") || "없음"}. 이 판매처는 이번 검색에서 제외하고 다른 판매처를 찾으세요.
이미 접근 실패하거나 조건에 맞지 않은 URL(재사용 금지): ${rejectedUrls.slice(0, 8).join(", ") || "없음"}
무신사(musinsa.com), 29CM(29cm.co.kr/catalog/상품번호 또는 /products/상품번호), 에이블리(a-bly.com/goods/상품번호)를 우선 탐색하고, 없으면 컨버스·뉴발란스·유니클로·나이키·아디다스 공식몰, W컨셉·SSF샵·EQL을 확인하세요. KREAM은 다른 판매처에서 찾지 못했을 때만 탐색하세요.
검색은 개별 상품 경로를 우선 지정하세요. 예: site:musinsa.com/products 카키 카고 팬츠, site:product.29cm.co.kr/catalog 네이비 재킷. 검색 결과 화면이나 상품의 /reviews 후기 탭은 제외하세요.
각 품목은 상의/하의/신발/아우터 중 하나입니다. 가방, 벨트, 모자, 시계 등 액세서리는 절대 찾지 마세요.
품목에 명시된 브랜드·색상·의류 종류는 반드시 유지하세요. 예: 컨버스 스니커즈는 실제 컨버스 상품, 검정 티셔츠는 실제 검정 티셔츠입니다. 색상 미지정이면 임의의 색을 확인했다고 말하지 마세요.
원단 질감/무늬/소매/종류/여밈은 유지하세요. 무지 카고에 카모, 긴팔 니트에 프린트 민소매, 우븐 단추 셔츠에 반팔 집업 니트, 치노/데님에 스웨트/트랙 팬츠를 대체하지 마세요. 베스트/조끼도 아우터입니다. 동일 제품이나 재고를 확인했다고 추정하지 마세요.
반드시 웹검색에서 찾은 실제 상세 URL만 사용하세요. 상품번호를 만들거나 기억으로 URL을 완성하지 마세요.
확인 가능한 상품이 없으면 해당 품목은 생략하세요. 각 품목당 최대2개 후보를 선호순으로 주세요.
JSON만 반환: {"links":[{"requirementIndex":0,"category":"상의","item":"원래 아이템명","url":"https://실제-상품-상세주소"}]}`;
}

async function searchProducts(concept: Record<string, unknown>, requirements: ProductRequirement[], retry: boolean, rejectedUrls: string[], signal: AbortSignal) {
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_BUDGET_MS)]);
  const response = await bounded(openai.responses.create({
    model: OPENAI_SHOPPING_MODEL, service_tier: OPENAI_SERVICE_TIER,
    tools: [{ type: "web_search_preview" }], tool_choice: "required", include: ["web_search_call.action.sources"],
    input: searchPrompt(concept, requirements, retry, rejectedUrls), max_output_tokens: 1800,
  }, { signal: callSignal, maxRetries: 0 }), callSignal);
  const parsed = parseJsonObjectFromText(response.output_text);
  const raw = Array.isArray(parsed.links) ? parsed.links.filter((value): value is Record<string, unknown> => !!value && typeof value === "object").slice(0, requirements.length * 2) : [];
  const sourceLinks: Record<string, unknown>[] = [];
  for (const output of response.output ?? []) {
    if (output.type === "web_search_call" && "action" in output && output.action && "sources" in output.action && Array.isArray(output.action.sources)) {
      for (const source of output.action.sources) if (source && "url" in source && canonicalProductUrl(String(source.url))) sourceLinks.push({ url: source.url, fromSource: true });
    }
    if (output.type === "message") for (const content of output.content) if (content.type === "output_text") {
      for (const annotation of content.annotations ?? []) if (annotation.type === "url_citation" && canonicalProductUrl(annotation.url)) sourceLinks.push({url: annotation.url, fromSource:true});
    }
  }
  const seen = new Set<string>(rejectedUrls.map(value => canonicalProductUrl(value)).filter((value): value is string => !!value));
  const candidates = [...raw, ...sourceLinks].filter(value => {
    const key = canonicalProductUrl(String(value.url ?? ""));
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, Math.max(requirements.length * 2, 4));
  const results = await Promise.all(candidates.map(value => validateProduct(value, requirements, signal)));
  const products = results.filter((value): value is ShoppingProduct => value !== null);
  // Keep up to two real alternatives for each item so visual rejection can select the other.
  const selected = requirements.flatMap(requirement => products.filter(value => value.category === requirement.category && value.item === requirement.item).slice(0,2));
  return { products: selected, attemptedUrls: candidates.map(value => String(value.url ?? "")).filter(Boolean) };
}

export async function POST(req: Request) {
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(ROUTE_BUDGET_MS)]);
  try {
    const body = await bounded(req.json(), signal);
    if (!body.concept || typeof body.concept !== "object" || Array.isArray(body.concept)) {
      return NextResponse.json({ error: "상품을 찾을 착장 정보가 없어요." }, { status: 400 });
    }
    const concept = sanitizeCoreConcept(body.concept as Record<string, unknown>);
    const targetText = `${String(body.keyword ?? "")} ${String(concept.targetCustomer ?? "")}`;
    const targetGender = /남자|남성|맨즈|\bmen\b|\bmale\b/i.test(targetText) ? "male" as const : /여자|여성|우먼|\bwomen\b|\bfemale\b/i.test(targetText) ? "female" as const : undefined;
    const lockedSpecs = readGarmentSpecs(concept);
    const imageUrl = isLookbookDataImage(body.imageUrl) ? body.imageUrl : undefined;
    // Never trust client-supplied observed attributes from a possibly different image.
    const observation = imageUrl ? await inspectLookbookGarments(imageUrl, lockedSpecs, signal) : undefined;
    const visualSpecs = lockedSpecs.map(spec => {
      const observed = observation?.specs.find(value => value.category === spec.category);
      return observed ? {...spec,...observed,brand:spec.brand,model:spec.model} : spec;
    });
    const requirements: ProductRequirement[] = visualSpecs.map(spec => ({...spec, raw:garmentSpecText(spec), targetGender}));
    if (!requirements.length) return NextResponse.json({ links: [], missingItems: [], status: "partial", warning: "상의·하의·신발·아우터 품목을 확인하지 못했어요." });
    const products = new Map<string, ShoppingProduct>();
    const missing = () => requirements.filter(value => !products.has(value.raw));
    const remember = (found: ShoppingProduct[]) => {
      for (const requirement of requirements) {
        const matches = found.filter(value => value.category === requirement.category && value.item === requirement.item);
        const match = matches.find(value => value.visualStatus === "verified") ?? matches[0];
        if (match && !products.has(requirement.raw)) products.set(requirement.raw, match);
      }
    };
    agentLog("shopping", `"${String(concept.name ?? "착장")}" 개별 상품 ${requirements.length}개 검색 시작`, `web_search_preview · ${OPENAI_SHOPPING_MODEL}`);
    const rejectedProductUrls = new Set<string>();
    const evaluatePhotos = async (found: ShoppingProduct[]) => {
      const compared = await compareProductImages(imageUrl, found, visualSpecs, signal);
      const retainedUrls = new Set(compared.map(value => value.url));
      // Unknown comparisons remain in compared, so only explicit visual mismatches enter this list.
      found.forEach(value => { if (!retainedUrls.has(value.url)) rejectedProductUrls.add(value.url); });
      remember(compared);
    };
    let rejectedUrls: string[] = [];
    const searchedCategories = new Set<string>();
    let initialCompleted = false;
    try {
      const result = await searchProducts(concept, missing(), false, [], signal);
      initialCompleted = true;
      requirements.forEach(value => searchedCategories.add(value.category));
      rejectedUrls = result.attemptedUrls;
      await evaluatePhotos(result.products);
    } catch (error) { agentLog("shopping", `첫 상품 검색 미완료: ${error instanceof Error ? error.name : "응답 오류"}`); }
    if (missing().length && !signal.aborted) {
      const targets = initialCompleted ? missing().map(value => [value]) : [missing()];
      agentLog("shopping", `미확인 품목별 추가 검색: ${missing().map(value => value.item).join(", ")}`);
      const found: ShoppingProduct[] = [];
      let next = 0;
      await Promise.all(Array.from({length:Math.min(2,targets.length)}, async () => {
        while (next < targets.length && !signal.aborted) {
          const pendingItems = targets[next++];
          try {
            const result = await searchProducts(concept, pendingItems, true, rejectedUrls, signal);
            pendingItems.forEach(value => searchedCategories.add(value.category));
            found.push(...result.products);
            rejectedUrls = [...rejectedUrls,...result.attemptedUrls];
          } catch (error) { agentLog("shopping", `추가 상품 검색 미완료: ${error instanceof Error ? error.name : "응답 오류"}`); }
        }
      }));
      await evaluatePhotos(found);
    }
    const links = requirements.flatMap(value => products.has(value.raw) ? [products.get(value.raw)!] : []);
    const missingItems = missing().map(value => value.raw);
    const warning = missingItems.length ? `${links.length}개 품목의 상세 상품을 찾았어요. ${missingItems.map(value => value.split(":")[0]).join("·")} 상품은 아직 확인하지 못했어요. 다시 찾기를 눌러 재시도할 수 있어요.` : null;
    agentLog("shopping", `개별 상품 ${links.length}/${requirements.length}개 확인 완료; 미확인 ${missingItems.length}개`);
    return NextResponse.json({ links, missingItems, warning, status: missingItems.length ? "partial" : "complete", imageObservationStatus: observation?.status ?? "unverified", searchedCategories: [...searchedCategories], rejectedProductUrls: [...rejectedProductUrls] });
  } catch (error) {
    return NextResponse.json({ error: signal.aborted ? "상품 검색 시간이 초과되었거나 취소됐어요. 다시 찾기를 눌러주세요." : error instanceof Error ? error.message : "상품 검색 오류" }, { status: signal.aborted ? 408 : 500 });
  }
}
