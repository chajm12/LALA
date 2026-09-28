import { NextResponse } from "next/server";
import { IMAGE_MODEL, openai, parseJsonObjectFromText } from "@/lib/openai";
import { getNvidiaClient, NVIDIA_VISION_MODEL } from "@/lib/nvidia";
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
  const verifierIssues = evaluation?.verifierIssues?.join(" / ") || "없음";
  const trendSummary = trend.length > 2800 ? `${trend.slice(0, 2800)}...` : trend;

  return `Create a wearable Korean online fashion e-commerce lookbook image for the concept "${concept.name}".
This is a locked outfit specification. Show exactly the listed garments and do not invent extra garments, accessories, logos, text, patterns, or props.
Target model: ${target || "성인 남성"}. Body profile: ${bodyProfile || "사용자 체형 정보 없음"}.
The model must have realistic body volume and proportions implied by the user's height and weight. Do not turn the model into a generic tall, thin, muscular, or runway model.
Exact garments to show: ${items || concept.description}.
Fit and silhouette: ${fitStrategy}. Mood: ${concept.mood}. Color palette: ${colors}. Materials and visible texture: ${materials}.
Situation and styling context: User request, weather, place, and locked outfit specification are primary. The fashion web research inside this context is reference-only style direction, never a template to copy: ${trendSummary}.
Weather requirements: ${weatherSummary}.
Objective verifier context: weather ${evaluation?.weatherScore ?? "미상"}, occasion ${evaluation?.placeScore ?? "미상"}, body fit ${evaluation?.bodyFitScore ?? "미상"}, color harmony ${evaluation?.colorScore ?? "미상"}. Remaining verifier issues to avoid: ${verifierIssues}.
Latest explicit user edit request: ${refinementRequest || "없음"}. This request has priority over the previous outfit; reflect it exactly in the visible garment specification.
Use contemporary Korean fashion editorial and premium e-commerce photography, clean neutral studio background, natural standing pose, realistic fabric drape, intentional styling proportions, visible material texture, and a clear full-body front-facing view. Preserve any specified check, stripe, washed finish, graphic, hardware, cropped proportion, curved silhouette, or layered detail instead of simplifying the outfit into plain basics.
Keep comfortable empty space above the head and below the shoes. Show the entire head, hands, legs, socks if present, and shoes.
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
    return { imageUrl: b64 ? `data:image/jpeg;base64,${b64}` : null, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : "이미지 생성 중 알 수 없는 오류";
    return { imageUrl: null, error: message };
  }
}

async function critiqueImage(
  imageDataUrl: string,
  concept: Record<string, unknown>,
  evaluation: EvaluationContext | null,
  trend: string,
) {
  const items = Array.isArray(concept.outfitItems) ? concept.outfitItems.join(", ") : "";
  const colors = Array.isArray(concept.colorPalette) ? concept.colorPalette.join(", ") : "";
  const completion = await getNvidiaClient().chat.completions.create({
    model: NVIDIA_VISION_MODEL,
    temperature: 0.1,
    max_tokens: 900,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `너는 룩북 Objective Vision Verifier야. 이미지를 아래의 잠금 스펙과 비교해.
착용 아이템: ${items}
색상 팔레트: ${colors}
무드: ${concept.mood}
핏/실루엣: ${concept.fitStrategy}
모델 타겟: ${concept.targetCustomer}
상황 컨텍스트: ${trend.slice(0, 1800)}
평가 점수 참고: ${JSON.stringify(evaluation)}

다음 항목을 각각 확인해: full_body, garment_match, color_match, silhouette_match, body_profile_match, occasion_fit.
materials는 사진만으로 원단 성분을 확정하지 말고, 색상·광택·질감이 명백히 모순될 때만 불일치로 판단해.
착용 아이템이 이미지에 없거나 전혀 다른 종류이면 garment_match를 false로 해.
전신이 잘렸거나 신발이 보이지 않으면 full_body를 false로 해.
상황 적합성은 이미지에서 확인 가능한 복장 격식과 레이어링만 판단하고, 장소가 사진에 보이지 않는다는 이유로 실패시키지 마.
모든 항목이 true에 가깝고 명백한 불일치가 없을 때만 matches를 true로 해.
반드시 JSON만 반환해: {"matches": boolean, "checks": {"full_body": boolean, "garment_match": boolean, "color_match": boolean, "silhouette_match": boolean, "body_profile_match": boolean, "occasion_fit": boolean}, "mismatches": string[]}. mismatches는 구체적인 한국어 문장으로 작성해.`,
          },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  } as never, { signal: AbortSignal.timeout(15_000) });
  const content = completion.choices[0]?.message?.content;
  return parseJsonObjectFromText(content);
}

export async function POST(req: Request) {
  try {
    const { concept, evaluation, trend = "", weather } = await req.json();
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
    if (imageUrl) {
      agentLog(
        "lookbook",
        `Vision으로 이미지-스펙 정합성 검증 중 (재생성 없음)...`,
        `NVIDIA NIM vision · ${NVIDIA_VISION_MODEL}`,
      );
      try {
        const critique = await critiqueImage(imageUrl, concept, evaluationContext, trend);
        verified = Boolean(critique.matches);
        mismatches = Array.isArray(critique.mismatches) ? critique.mismatches : [];
      } catch {
        agentLog("lookbook", `✗ Vision 검증 실패 (best-effort, 미검증 상태로 진행)`);
      }

      if (verified) {
        agentLog("lookbook", `✓ 스펙 일치 확인됨`);
      } else if (mismatches.length) {
        agentLog("lookbook", `⚠ 불일치 기록(자동 재생성 생략): ${mismatches.join(", ")}`);
      }
    }

    return NextResponse.json({
      imageUrl,
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
