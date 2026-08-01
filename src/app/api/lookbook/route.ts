import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import { agentLog } from "@/lib/log";

const MAX_RETRIES = 1;

function buildPrompt(concept: Record<string, unknown>, extra?: string) {
  const materials = Array.isArray(concept.materials) ? concept.materials.join(", ") : "";
  const colors = Array.isArray(concept.colorPalette) ? concept.colorPalette.join(", ") : "";
  const target = concept.targetCustomer ?? "";
  return `Fashion lookbook photo of an avatar model wearing an outfit for the concept "${concept.name}". The model's apparent gender, age range, and styling MUST match this target customer profile: "${target}". Mood: ${concept.mood}. Color palette: ${colors}. Materials/fabric: ${materials}. Editorial fashion photography, full body, studio lighting.${extra ? ` ${extra}` : ""}`;
}

async function generateImage(prompt: string) {
  const image = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024",
    n: 1,
  });
  const b64 = image.data?.[0]?.b64_json;
  return b64 ? `data:image/png;base64,${b64}` : null;
}

async function critiqueImage(imageDataUrl: string, concept: Record<string, unknown>) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `이 이미지가 아래 스펙과 일치하는지 확인해줘.\ncolorPalette: ${JSON.stringify(concept.colorPalette)}\nmaterials: ${JSON.stringify(concept.materials)}\nmood: ${concept.mood}\ntargetCustomer(모델의 성별/연령대가 반드시 이 타겟과 일치해야 함): ${concept.targetCustomer}\n\n주의: materials(원단 성분)는 사진만으로 확인이 불가능한 항목이야. 원단이 색상/질감상 명백히 모순되는 경우(예: denim이라고 했는데 실크처럼 광택 나는 소재로 보임)가 아니라면 materials 불일치로 잡지 마. colorPalette와 targetCustomer(모델 성별/연령대)의 명백한 불일치만 mismatches에 넣어줘.\n\nJSON으로 답해: matches(boolean, 색상/모델 성별·연령대가 맞으면 true), mismatches(string[], 명백한 불일치만 한국어로 구체적으로).`,
          },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });
  return JSON.parse(completion.choices[0].message.content ?? "{}");
}

export async function POST(req: Request) {
  const { concept } = await req.json();

  agentLog("lookbook", `룩북 이미지 생성 시작 (1차)`);
  let imageUrl = await generateImage(buildPrompt(concept));
  let verified = false;
  let mismatches: string[] = [];
  let retried = false;

  for (let i = 0; imageUrl && i <= MAX_RETRIES; i++) {
    agentLog("lookbook", `Vision으로 이미지-스펙 정합성 검증 중...`);
    try {
      const critique = await critiqueImage(imageUrl, concept);
      verified = Boolean(critique.matches);
      mismatches = Array.isArray(critique.mismatches) ? critique.mismatches : [];
    } catch {
      agentLog("lookbook", `✗ Vision 검증 실패 (best-effort, 미검증 상태로 진행)`);
      break;
    }

    if (verified) {
      agentLog("lookbook", `✓ 스펙 일치 확인됨`);
      break;
    }
    if (i === MAX_RETRIES) {
      agentLog("lookbook", `⚠ 불일치 남음(재시도 한도 도달): ${mismatches.join(", ")}`);
      break;
    }

    agentLog("lookbook", `⚠ 불일치 발견: ${mismatches.join(", ")} → 프롬프트 보강 후 재생성`);
    imageUrl = await generateImage(
      buildPrompt(concept, `Make sure to clearly include: ${mismatches.join("; ")}.`),
    );
    retried = true;
  }

  return NextResponse.json({ imageUrl, verified, mismatches, retried });
}
