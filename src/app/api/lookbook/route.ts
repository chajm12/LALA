import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";

export async function POST(req: Request) {
  const { concept } = await req.json();

  const prompt = `Fashion lookbook photo of an avatar model wearing an outfit for the concept "${concept.name}". Mood: ${concept.mood}. Color palette: ${(concept.colorPalette ?? []).join(", ")}. Editorial fashion photography, full body, studio lighting.`;

  const image = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024",
    n: 1,
  });

  const b64 = image.data?.[0]?.b64_json;
  return NextResponse.json({ imageUrl: b64 ? `data:image/png;base64,${b64}` : null });
}
