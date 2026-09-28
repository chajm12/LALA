import { NextResponse } from "next/server";
import { sanitizeCoreText } from "@/lib/garments";
import { ensureGarmentSpecs, compareGarmentSpecs, type GarmentSpec } from "@/lib/garment-specs";
import { inspectLookbookGarments } from "@/lib/shopping-visual";
import { IMAGE_MODEL, openai } from "@/lib/openai";
import { agentLog } from "@/lib/log";
import type { WeatherSnapshot } from "@/lib/verifiers";

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

function buildBodyPrompt(concept: Record<string, unknown>) {
  const source = [
    concept.targetCustomer,
    concept.bodyProfile,
    concept.description,
    concept.fitStrategy,
  ]
    .filter((value) => typeof value === "string")
    .join(" ");
  const parsed = parseHeightWeight(source);
  const bodyProfile = typeof concept.bodyProfile === "string" ? concept.bodyProfile : "";
  return parsed
    ? `${bodyProfile} Explicit numeric body reference for the image model: ${parsed}`
    : bodyProfile;
}

function buildPrompt(
  concept: Record<string, unknown>,
  evaluation: EvaluationContext | null,
  trend: string,
  weather: WeatherSnapshot | null,
  extra?: string,
) {
  const materials = Array.isArray(concept.materials) ? concept.materials.join(", ") : "";
  const colors = Array.isArray(concept.colorPalette) ? concept.colorPalette.join(", ") : "";
  const items = Array.isArray(concept.outfitItems) ? concept.outfitItems.join(", ") : "";
  const target = concept.targetCustomer ?? "";
  const bodyProfile = buildBodyPrompt(concept);
  const fitStrategy = concept.fitStrategy ?? "";
  const refinementRequest = typeof concept.refinementRequest === "string" ? concept.refinementRequest : "";
  const forecast = weather?.forecast;
  const weatherSummary = weather
    ? `${weather.season ?? "계절 미상"}, 예보 가능: ${weather.forecastAvailable ? "예" : "아니오"}, ` +
      `최고 ${forecast?.temperatureMax ?? "미상"}°C, 최저 ${forecast?.temperatureMin ?? "미상"}°C, ` +
      `강수량 ${forecast?.precipitationMm ?? "미상"}mm, 바람 ${forecast?.windSpeedMax ?? "미상"}m/s`
    : "날씨 데이터 없음; 계절감만 사용";
  const verifierIssues = evaluation?.verifierIssues?.map(sanitizeCoreText).filter(Boolean).join(" / ") || "없음";
  const trendSummary = trend.length > 2800 ? `${trend.slice(0, 2800)}...` : trend;

  return `Create a wearable Korean online fashion e-commerce lookbook image for the concept "${concept.name}".
This is a locked outfit specification. Show only tops, bottoms, shoes, and the specified outerwear. No bags, belts, hats, jewelry, watches, scarves, eyewear, ties, or visible socks, even if old context asks for them. Do not invent extra garments, accessories, logos, text, patterns, or props.
Target model: ${target || "성인 남성"}. Body profile: ${bodyProfile || "사용자 체형 정보 없음"}.
The model must have realistic body volume and proportions implied by the user's height and weight. Do not turn the model into a generic tall, thin, muscular, or runway model.
Exact garments to show: ${items || concept.description}.
Authoritative per-garment attributes: ${JSON.stringify(concept.garmentSpecs)}. These color/pattern/sleeve/material/closure choices override the global palette and prose. Solid means no camouflage, checks, stripes, chest graphic or added print; keep brand shoe markings only. Do not replace a long-sleeve knit with a knit vest, woven button shirt with short-sleeve zip polo, chinos or denim with track pants.
Fit and silhouette: ${fitStrategy}. Mood: ${concept.mood}. Color palette: ${colors}. Materials and visible texture: ${materials}.
Situation and styling context: User request, weather, place, and locked outfit specification are primary. The fashion web research inside this context is reference-only style direction, never a template to copy: ${trendSummary}.
Weather requirements: ${weatherSummary}.
Objective verifier context: weather ${evaluation?.weatherScore ?? "미상"}, occasion ${evaluation?.placeScore ?? "미상"}, body fit ${evaluation?.bodyFitScore ?? "미상"}, color harmony ${evaluation?.colorScore ?? "미상"}. Remaining verifier issues to avoid: ${verifierIssues}.
Latest explicit user edit request: ${refinementRequest || "없음"}. Apply it only to the allowed tops, bottoms, shoes, or outerwear; preserve the other listed garments. The no-accessory policy always takes priority.
Use contemporary Korean fashion editorial and premium e-commerce photography, clean neutral studio background, natural standing pose, realistic fabric drape, intentional styling proportions, visible material texture, and a clear full-body front-facing view. Preserve any specified check, stripe, washed finish, graphic, hardware, cropped proportion, curved silhouette, or layered detail instead of simplifying the outfit into plain basics.
Keep comfortable empty space above the head and below the shoes. Show the entire head, hands, legs, and shoes. No added accessories or props.
Do not crop any body part. Do not use editorial runway exaggeration, fantasy clothing, extra layers, random accessories, distorted anatomy, floating garments, or unreadable branding.${extra ? ` ${extra}` : ""}`;
}

type GenerateResult = { imageUrl: string | null; error: string | null };

type EvaluationContext = {
  weatherScore?: number;
  placeScore?: number;
  bodyFitScore?: number;
  trendScore?: number;
  practicalityScore?: number;
  colorScore?: number;
  diversityScore?: number;
  verifierIssues?: string[];
  failureReasons?: string[];
  revisionPlan?: string[];
};

async function generateImage(prompt: string): Promise<GenerateResult> {
  try {
    const image = await openai.images.generate({
      model: IMAGE_MODEL,
      prompt,
      size: "1024x1536",
      quality: "medium",
      output_format: "jpeg",
      output_compression: 88,
      n: 1,
    }, { signal: AbortSignal.timeout(60_000) });
    const b64 = image.data?.[0]?.b64_json;
    return { imageUrl: b64 ? `data:image/jpeg;base64,${b64}` : null, error: b64 ? null : "이미지 생성 응답에 이미지가 없습니다." };
  } catch (e) {
    const message = e instanceof Error ? e.message : "이미지 생성 중 알 수 없는 오류";
    return { imageUrl: null, error: message };
  }
}

export async function POST(req: Request) {
  try {
    const { concept: rawConcept, evaluation, trend: rawTrend = "", weather } = await req.json();
    if (!rawConcept || typeof rawConcept !== "object") return NextResponse.json({ error: "룩 정보를 보내주세요." }, { status: 400 });
    const concept = ensureGarmentSpecs(rawConcept as Record<string, unknown>);
    const trend = sanitizeCoreText(rawTrend);
    if (!(concept.outfitItems as string[]).length) return NextResponse.json({ error: "상의·하의·신발·아우터 중 추천할 의류가 없어요." }, { status: 400 });
    const evaluationContext = evaluation && typeof evaluation === "object"
      ? (evaluation as EvaluationContext)
      : null;
    const weatherContext = weather && typeof weather === "object"
      ? (weather as WeatherSnapshot)
      : null;

    agentLog("lookbook", `룩북 이미지 생성 시작 (1차)`, `images.generate · ${IMAGE_MODEL}`);
    const gen = await generateImage(buildPrompt(concept, evaluationContext, trend, weatherContext));
    if (!gen.imageUrl && gen.error) {
      agentLog("lookbook", `✗ 이미지 생성 실패(재시도 생략): ${gen.error}`, `images.generate · ${IMAGE_MODEL}`);
    }

    const imageUrl = gen.imageUrl;
    const generationError = gen.error;
    let verified = false;
    let mismatches: string[] = [];
    let imageGarmentSpecs: GarmentSpec[] = [];
    if (imageUrl) {
      agentLog("lookbook", "이미지의 품목별 색상·무늬·소매를 확인합니다.", "OpenAI image attribute verification");
      try {
        const observation = await inspectLookbookGarments(imageUrl, concept.garmentSpecs, req.signal);
        imageGarmentSpecs = observation.specs;
        if (observation.status === "verified") {
          const comparison = compareGarmentSpecs(concept.garmentSpecs, imageGarmentSpecs);
          verified = comparison.matches;
          mismatches = comparison.differences;
        }
        agentLog("lookbook", verified ? "품목별 이미지 명세 비교 완료" : "이미지는 유지하고 확인 미완료·차이 항목을 표시합니다.");
      } catch { agentLog("lookbook", "이미지 속성 확인을 완료하지 못했습니다. 생성 이미지는 유지합니다."); }
    }

    return NextResponse.json({
      imageUrl,
      concept,
      imageGarmentSpecs,
      verified,
      mismatches,
      retried: false,
      error: imageUrl ? null : generationError,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "룩북 생성 중 알 수 없는 오류";
    agentLog("lookbook", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
