import { NextResponse } from "next/server";
import { generateImage } from "@/lib/tools/image";
import { critiqueLookbook } from "@/lib/tools/vision";
import { VISION_MODEL } from "@/lib/nim";
import { agentLog, type TraceEvent } from "@/lib/log";

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

function buildPrompt(concept: Record<string, unknown>, extra?: string) {
  const materials = Array.isArray(concept.materials) ? concept.materials.join(", ") : "";
  const colors = Array.isArray(concept.colorPalette) ? concept.colorPalette.join(", ") : "";
  const items = Array.isArray(concept.outfitItems) ? concept.outfitItems.join(", ") : "";
  const target = String(concept.targetCustomer ?? "");
  const bodyProfile = String(concept.bodyProfile ?? "");
  const parsed = parseHeightWeight([target, bodyProfile, String(concept.description ?? ""), String(concept.fitStrategy ?? "")].join(" "));
  const gender = /여성|women|female/i.test(target) ? "female" : "male";
  return `Editorial fashion lookbook photo, full body, studio lighting, neutral background. A ${gender} model with ${parsed ?? "an average realistic build"} ${bodyProfile}. Represent the body realistically according to the height and weight; do not make the model runway-proportioned. Outfit: ${items || concept.description}. Fit: ${concept.fitStrategy ?? ""}. Mood: ${concept.mood}. Colors: ${colors}. Fabrics: ${materials}. Natural pose, realistic clothing, show from top of head to shoes with margin, do not crop head or feet.${extra ? ` ${extra}` : ""}`;
}

export async function POST(req: Request) {
  const trace: TraceEvent[] = [];
  try {
    const { concept } = await req.json();

    agentLog("lookbook", "룩북 이미지 생성 (1차)", "tool:generate_image", trace);
    let gen = await generateImage(buildPrompt(concept));
    if (!gen.imageUrl && gen.error) {
      agentLog("lookbook", `✗ 생성 실패: ${gen.error} → 안전한 프롬프트로 1회 재시도`, "tool:generate_image", trace);
      gen = await generateImage(`${buildPrompt(concept)} Tasteful, fully clothed, professional catalog photography.`);
    }

    let imageUrl = gen.imageUrl;
    let verified = false;
    let mismatches: string[] = [];
    let retried = false;

    for (let i = 0; imageUrl && i <= MAX_RETRIES; i++) {
      agentLog("lookbook", "VLM 으로 이미지-스펙 정합성 검증", `chat.completions (vision) · ${VISION_MODEL}`, trace);
      try {
        const critique = await critiqueLookbook(imageUrl, concept);
        verified = critique.matches;
        mismatches = critique.mismatches;
      } catch (e) {
        agentLog("lookbook", `✗ VLM 검증 실패 (미검증 상태로 진행): ${e instanceof Error ? e.message : e}`, undefined, trace);
        break;
      }
      if (verified) { agentLog("lookbook", "✓ 스펙 일치 확인", undefined, trace); break; }
      if (i === MAX_RETRIES) { agentLog("lookbook", `⚠ 불일치 남음: ${mismatches.join(", ")}`, undefined, trace); break; }

      agentLog("lookbook", `⚠ 불일치: ${mismatches.join(", ")} → 프롬프트 보강 후 재생성`, "tool:generate_image", trace);
      const retry = await generateImage(buildPrompt(concept, `Make sure to clearly include: ${mismatches.join("; ")}.`));
      if (retry.imageUrl) imageUrl = retry.imageUrl;
      retried = true;
    }

    return NextResponse.json({ imageUrl, verified, mismatches, retried, provider: gen.provider, error: imageUrl ? null : gen.error, trace });
  } catch (e) {
    const message = e instanceof Error ? e.message : "룩북 생성 중 알 수 없는 오류";
    agentLog("lookbook", `✗ 요청 실패: ${message}`, undefined, trace);
    return NextResponse.json({ error: message, trace }, { status: 500 });
  }
}
