import { NextResponse } from "next/server";
import { CORE_GARMENT_POLICY, sanitizeCoreConcept, sanitizeCoreText, type CoreGarmentCategory } from "@/lib/garments";
import { ensureGarmentSpecs, normalizeGarmentSpecs, readGarmentSpecs, garmentSpecText } from "@/lib/garment-specs";
import { getCachedLookbookGarments } from "@/lib/shopping-visual";
import { describeRefinementScope, enforceRefinementScope } from "@/lib/refinement-scope";
import { getNvidiaClient, NVIDIA_PLAN_MODEL } from "@/lib/nvidia";
import { parseJsonObjectFromText } from "@/lib/openai";
import { agentLog } from "@/lib/log";

type Concept = Record<string, unknown>;
const categories: CoreGarmentCategory[] = ["상의", "하의", "신발", "아우터"];

async function proposeRefinement(concept: Concept, feedback: string, trend: string, selectedCategory?: CoreGarmentCategory) {
  const response = await getNvidiaClient().chat.completions.create(
    {
      model: NVIDIA_PLAN_MODEL,
      temperature: 0.25,
      max_tokens: 1800,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "너는 룩 수정 에이전트야. 한국어 JSON만 작성해. " + CORE_GARMENT_POLICY + " " +
            "사용자가 언급하지 않은 의류와 속성은 원문 그대로 유지해. 전체 룩을 새로 제안하지 마. " +
            "색만 바꾸라는 요청이면 해당 품목의 color만 변경하고 종류·핏·소매·패턴·소재·브랜드는 유지해. " +
            "'둘 중 하나' 또는 '하나만'이면 정확히 한 품목만 변경해. 상의와 아우터를 둘 다 바꾸지 마. " +
            "아우터 추가는 기존 상의 위에 새 아우터를 추가하는 작업이고 상의를 교체하는 작업이 아니야. " +
            "명시적으로 여러 품목을 요청한 경우에만 그 품목들을 수정해. 단순 개선 요청은 가장 작은 한 품목 변경으로 해석해. " +
            "반드시 {\"concept\": Concept} 형태로 반환해. concept.garmentSpecs와 outfitItems를 일치시켜.",
        },
        {
          role: "user",
          content:
            `기존 코디:\n${JSON.stringify(concept, null, 2)}\n\n` +
            `사용자 수정 요청:\n${feedback}\n\n` +
            `허용 수정 범위:\n${JSON.stringify(describeRefinementScope(feedback, selectedCategory))}\n\n` +
            `날씨·장소·스타일 참고:\n${trend.slice(0, 5000)}\n\n` +
            "허용 범위 밖의 속성은 그대로 복사해.",
        },
      ],
    } as never,
    { signal: AbortSignal.timeout(30_000) },
  );
  const parsed = parseJsonObjectFromText(response.choices[0]?.message?.content);
  const candidate = parsed.concept && typeof parsed.concept === "object" ? parsed.concept as Concept : {};
  return sanitizeCoreConcept({ ...concept, ...candidate, id: concept.id });
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    let concept = body.concept && typeof body.concept === "object" ? sanitizeCoreConcept(body.concept as Concept) : null;
    const feedback = typeof body.feedback === "string" ? body.feedback.split(/[,;\n]/).map(sanitizeCoreText).filter(Boolean).join(", ") : "";
    if (!concept || !feedback) {
      return NextResponse.json({ error: "수정할 룩과 상의·하의·신발·아우터 중 변경할 의류를 알려주세요." }, { status: 400 });
    }
    // This lookup only hashes image bytes and reads the in-process cache.
    // Refinement never sends the prior image to another vision endpoint.
    const declared = readGarmentSpecs(concept);
    const cached = typeof body.imageUrl === "string" ? getCachedLookbookGarments(body.imageUrl, declared) : undefined;
    const observed = cached?.status === "verified" ? cached.specs : normalizeGarmentSpecs(body.imageGarmentSpecs);
    if (observed.length) {
      const merged = declared.map((spec) => {
        const observation = observed.find((value) => value.category === spec.category);
        if (!observation) return spec;
        let item = observation.item;
        // Explicit brand/model requirements are not replaced by a visual guess.
        for (const key of ["brand", "model"] as const) {
          if (spec[key] && observation[key] && spec[key] !== observation[key]) item = item.replaceAll(observation[key]!, spec[key]!);
        }
        return { ...spec, ...observation, category: spec.category, item,
          ...(spec.brand ? { brand: spec.brand } : {}), ...(spec.model ? { model: spec.model } : {}) };
      });
      concept = ensureGarmentSpecs({ ...concept, garmentSpecs: merged, outfitItems: merged.map(garmentSpecText) });
    } else {
      concept = ensureGarmentSpecs(concept);
    }
    const selectedCategory = categories.includes(body.selectedCategory as CoreGarmentCategory) ? body.selectedCategory as CoreGarmentCategory : undefined;
    agentLog("concept", `룩 수정 요청 해석: ${feedback}`, `NVIDIA NIM · ${NVIDIA_PLAN_MODEL}`);
    let proposed = concept;
    try {
      proposed = await proposeRefinement(concept, feedback, sanitizeCoreText(body.trend), selectedCategory);
    } catch (error) {
      agentLog("concept", `모델 수정 응답 실패, 명시된 변경 범위를 유지합니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
    const result = enforceRefinementScope(concept, proposed, feedback, selectedCategory);
    if (result.unchanged) return NextResponse.json(result);
    const completed = ensureGarmentSpecs(result.concept);
    // Defaults apply only to changed/new garments; unrelated specs remain exact.
    const garmentSpecs = completed.garmentSpecs.map((spec) => result.changedCategories.includes(spec.category)
      ? spec : result.concept.garmentSpecs.find((value) => value.category === spec.category) ?? spec);
    const enforcedConcept = { ...completed, garmentSpecs, outfitItems: garmentSpecs.map(garmentSpecText) };
    const lookbookResponse = await fetch(new URL("/api/lookbook", req.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: enforcedConcept,
        evaluation: body.evaluation,
        trend: sanitizeCoreText(body.trend),
        weather: body.weather,
      }),
      signal: req.signal,
      cache: "no-store",
    });
    const lookbook = await lookbookResponse.json() as Record<string, unknown>;
    if (!lookbookResponse.ok) throw new Error(String(lookbook.error ?? "수정된 룩북 이미지 생성에 실패했어요."));
    return NextResponse.json({
      ...lookbook,
      concept: lookbook.concept && typeof lookbook.concept === "object" ? lookbook.concept : enforcedConcept,
      refinementReply: result.refinementReply,
      changed: result.changed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "룩 수정에 실패했어요.";
    agentLog("concept", `✗ 룩 수정 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
