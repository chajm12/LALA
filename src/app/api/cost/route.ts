import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";

export async function POST(req: Request) {
  const { concept } = await req.json();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 의류 제작 원가 산출 전문가야. 주어진 컨셉을 바탕으로 개략적인 제작 원가를 JSON으로 산출해줘. 필드: materialCost, laborCost, overheadCost, totalCost (모두 KRW 숫자), breakdown(string[]) - 산출 근거 설명. breakdown의 각 문장은 컨셉 설명(description)과 같은 언어로 작성해.",
      },
      {
        role: "user",
        content: `컨셉: ${JSON.stringify(concept)}`,
      },
    ],
  });

  const cost = JSON.parse(completion.choices[0].message.content ?? "{}");
  return NextResponse.json({ cost });
}
