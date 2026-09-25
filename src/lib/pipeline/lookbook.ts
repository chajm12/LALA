import { generateImage } from "@/lib/tools/image";
import { critiqueLookbook } from "@/lib/tools/vision";
import { chatJson, JUDGE_MODEL, VISION_MODEL } from "@/lib/nim";
import { agentLog, fallbackLogger, type TraceEvent } from "@/lib/log";

/** 이미지 생성 → VLM 검증 → 불일치 시 프롬프트 보강 후 재생성 (최대 MAX_RETRIES 회) */
const MAX_RETRIES = 1;

function parseHeightWeight(text: string) {
  const heightMatch = text.match(/(\d{3}(?:\.\d+)?)\s?(?:cm|센티|키)/i);
  const weightMatch = text.match(/(\d{2,3}(?:\.\d+)?)\s?(?:kg|킬로|몸무게)/i);
  const heightCm = heightMatch ? Number(heightMatch[1]) : null;
  const weightKg = weightMatch ? Number(weightMatch[1]) : null;
  if (!heightCm || !weightKg) return null;
  const bmi = weightKg / (heightCm / 100) ** 2;
  let build = "average realistic build";
  if (bmi < 18.5) build = "slender, lean realistic build with narrow body volume";
  else if (bmi < 23) build = "balanced average realistic build";
  else if (bmi < 25) build = "solid average-to-athletic realistic build";
  else if (bmi < 30) build = "fuller realistic build with visible body volume";
  else build = "larger plus-size realistic build with broad body volume";
  let heightDescription = "average height impression";
  if (heightCm < 165) heightDescription = "shorter height impression with proportionally shorter limbs";
  else if (heightCm >= 180) heightDescription = "tall height impression with longer limbs";
  return `${heightCm}cm, ${weightKg}kg, BMI about ${bmi.toFixed(1)}: ${heightDescription}; ${build}.`;
}

function bodyDescription(concept: Record<string, unknown>) {
  const parsed = parseHeightWeight([concept.targetCustomer, concept.bodyProfile, concept.description, concept.fitStrategy].map(String).join(" "));
  const gender = /여성|women|female/i.test(String(concept.targetCustomer ?? "")) ? "female" : "male";
  return `${gender} model, ${parsed ?? "average realistic build"}`;
}

/**
 * FLUX 는 한국어(특히 신체 부위 표현)가 섞이면 CONTENT_FILTERED 로 검은 이미지를 돌려준다.
 * 그래서 LLM 으로 짧은 영어 프롬프트를 먼저 만들고, 실패 시 아이템 목록만 담은 최소 프롬프트로 재시도한다.
 */
async function composeImagePrompt(concept: Record<string, unknown>, trace: TraceEvent[]) {
  agentLog("lookbook", "룩 스펙을 영어 이미지 프롬프트로 변환", `chat.completions · ${JUDGE_MODEL}`, trace);
  const out = await chatJson<{ prompt?: string; outfit?: string }>(JUDGE_MODEL, [
    { role: "system", content: "You write concise, safe, English-only prompts for a fashion image generator. Output JSON only." },
    {
      role: "user",
      content: `Outfit spec (Korean): ${JSON.stringify({ outfitItems: concept.outfitItems, colorPalette: concept.colorPalette, materials: concept.materials, mood: concept.mood, fitStrategy: concept.fitStrategy })}

Return {"outfit": "<comma-separated English list of the garments with color/material/fit, max 40 words>", "prompt": "<one paragraph, max 80 words, English only: editorial full-body lookbook photo, ${bodyDescription(concept)}, the outfit, fit/silhouette, mood, studio lighting, neutral background. No body-part anatomy words, no brand names.>"}`,
    },
  ], { temperature: 0.2, maxTokens: 500, onFallback: fallbackLogger("lookbook", trace) });
  const outfit = replaceKnownTriggers(String(out.outfit ?? (Array.isArray(concept.outfitItems) ? concept.outfitItems.join(", ") : "")));
  const prompt = replaceKnownTriggers(String(out.prompt ?? "").trim()) || minimalPrompt(concept, outfit);
  return { prompt, outfit };
}

function minimalPrompt(concept: Record<string, unknown>, outfit: string) {
  return `Editorial fashion lookbook photo, full body, ${bodyDescription(concept)}, wearing ${outfit}. Studio lighting, neutral background, natural pose, head to shoes visible.`;
}

/**
 * FLUX 호스팅 필터는 단순 단어 목록이라 패션 색상명("sage" 등 식물·음식 이름)에도 걸린다.
 * 필터에 걸리면 LLM 으로 기본 색상어·기본 의류명만 쓰는 프롬프트로 다시 쓴다.
 */
const KNOWN_TRIGGERS: Record<string, string> = { sage: "light green", olive: "dark green", camel: "tan", mustard: "yellow", wine: "dark red", nude: "beige", blush: "light pink", coral: "orange pink", rust: "orange brown", cream: "off white" };

function replaceKnownTriggers(text: string) {
  return Object.entries(KNOWN_TRIGGERS).reduce((acc, [bad, good]) => acc.replace(new RegExp(`\\b${bad}\\b`, "gi"), good), text);
}

async function sanitizePrompt(concept: Record<string, unknown>, outfit: string, trace: TraceEvent[]) {
  agentLog("lookbook", "필터 회피용으로 기본 색상어·의류명만 쓰는 프롬프트로 재작성", `chat.completions · ${JUDGE_MODEL}`, trace);
  const gender = /여성|women|female/i.test(String(concept.targetCustomer ?? "")) ? "woman" : "man";
  const out = await chatJson<{ prompt?: string }>(JUDGE_MODEL, [
    { role: "system", content: "You rewrite image prompts to pass a strict keyword filter. Output JSON only." },
    {
      role: "user",
      content: `Outfit: ${replaceKnownTriggers(outfit)}

Rewrite as one sentence (max 45 words): "Catalog photo of a ${gender} standing in a photo studio, wearing ..., plain background, full length."
Rules: use ONLY these color words: white, black, gray, navy, blue, light blue, green, dark green, beige, tan, brown, red, yellow, pink, orange. Use simple garment nouns (shirt, t-shirt, sweater, jacket, coat, pants, jeans, shoes, sneakers, boots, bag). No fabric brand names, no plant/food/herb words, no body-part words.
Output {"prompt": "..."}`,
    },
  ], { temperature: 0.1, maxTokens: 300, onFallback: fallbackLogger("lookbook", trace) });
  const p = String(out.prompt ?? "").trim();
  return p || `Catalog photo of a ${gender} standing in a photo studio, wearing ${replaceKnownTriggers(outfit)}, plain background, full length.`;
}

export type LookbookResult = { imageUrl: string | null; verified: boolean; mismatches: string[]; retried: boolean; provider: string; error: string | null };

/** 이미지 생성 → VLM 검증 → 재생성. 라우트와 에이전트가 공유. */
export async function renderLookbook(concept: Record<string, unknown>, trace: TraceEvent[]): Promise<LookbookResult> {
    const { prompt, outfit } = await composeImagePrompt(concept, trace);
    agentLog("lookbook", "룩북 이미지 생성 (1차)", "tool:generate_image", trace);
    let gen = await generateImage(prompt);
    if (!gen.imageUrl && gen.error) {
      agentLog("lookbook", `✗ 생성 실패: ${gen.error} → 최소 프롬프트로 재시도 (실패 프롬프트: ${prompt.slice(0, 140)}…)`, "tool:generate_image", trace);
      gen = await generateImage(minimalPrompt(concept, outfit));
    }
    if (!gen.imageUrl && gen.error) {
      agentLog("lookbook", `✗ 재시도 실패: ${gen.error} → 필터 회피 프롬프트로 마지막 시도`, "tool:generate_image", trace);
      gen = await generateImage(await sanitizePrompt(concept, outfit, trace));
    }

    let imageUrl = gen.imageUrl;
    let verified = false;
    let mismatches: string[] = [];
    let retried = false;

    for (let i = 0; imageUrl && i <= MAX_RETRIES; i++) {
      agentLog("lookbook", "VLM 으로 이미지-스펙 정합성 검증", `chat.completions (vision) · ${VISION_MODEL}`, trace);
      try {
        const critique = await critiqueLookbook(imageUrl, concept, trace);
        verified = critique.matches;
        mismatches = critique.mismatches;
      } catch (e) {
        agentLog("lookbook", `✗ VLM 검증 실패 (미검증 상태로 진행): ${e instanceof Error ? e.message : e}`, undefined, trace);
        break;
      }
      if (verified) { agentLog("lookbook", "✓ 스펙 일치 확인", undefined, trace); break; }
      if (i === MAX_RETRIES) { agentLog("lookbook", `⚠ 불일치 남음: ${mismatches.join(", ")}`, undefined, trace); break; }

      agentLog("lookbook", `⚠ 불일치: ${mismatches.join(", ")} → 프롬프트 보강 후 재생성`, "tool:generate_image", trace);
      const retry = await generateImage(`${prompt} Make sure the outfit clearly shows: ${outfit}.`);
      if (retry.imageUrl) imageUrl = retry.imageUrl;
      else agentLog("lookbook", `✗ 재생성 실패: ${retry.error} (1차 이미지 유지)`, undefined, trace);
      retried = true;
    }

  return { imageUrl, verified, mismatches, retried, provider: gen.provider, error: imageUrl ? null : gen.error };
}
