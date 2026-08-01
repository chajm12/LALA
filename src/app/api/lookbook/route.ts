import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";

const MAX_RETRIES = 1;

function buildPrompt(concept: Record<string, unknown>, extra?: string) {
  const materials = Array.isArray(concept.materials) ? concept.materials.join(", ") : "";
  const colors = Array.isArray(concept.colorPalette) ? concept.colorPalette.join(", ") : "";
  return `Fashion lookbook photo of an avatar model wearing an outfit for the concept "${concept.name}". Mood: ${concept.mood}. Color palette: ${colors}. Materials/fabric: ${materials}. Editorial fashion photography, full body, studio lighting.${extra ? ` ${extra}` : ""}`;
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
            text: `이 이미지가 아래 스펙과 일치하는지 확인해줘.\ncolorPalette: ${JSON.stringify(concept.colorPalette)}\nmaterials: ${JSON.stringify(concept.materials)}\nmood: ${concept.mood}\n\nJSON으로 답해: matches(boolean, 전반적으로 일치하면 true), mismatches(string[], 불일치하거나 누락된 항목을 한국어로 구체적으로).`,
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

  let imageUrl = await generateImage(buildPrompt(concept));
  let verified = false;
  let mismatches: string[] = [];
  let retried = false;

  for (let i = 0; imageUrl && i <= MAX_RETRIES; i++) {
    try {
      const critique = await critiqueImage(imageUrl, concept);
      verified = Boolean(critique.matches);
      mismatches = Array.isArray(critique.mismatches) ? critique.mismatches : [];
    } catch {
      // vision critique is best-effort; treat as unverified rather than failing the request
      break;
    }

    if (verified || i === MAX_RETRIES) break;

    imageUrl = await generateImage(
      buildPrompt(concept, `Make sure to clearly include: ${mismatches.join("; ")}.`),
    );
    retried = true;
  }

  return NextResponse.json({ imageUrl, verified, mismatches, retried });
}
