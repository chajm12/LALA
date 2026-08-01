import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";

export async function POST(req: Request) {
  const { keyword, trend } = await req.json();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 패션 브랜드 기획자야. 주어진 키워드와 트렌드 조사 결과를 바탕으로 패션 컬렉션 컨셉을 JSON으로 기획해줘. 필드: name, description, mood, colorPalette(string[]), targetCustomer. name과 colorPalette 값(예: 'Sage Green')을 제외한 모든 텍스트(description, mood, targetCustomer)는 사용자 입력과 같은 언어로 작성해. 사용자 입력이 한국어면 한국어로 작성해.",
      },
      {
        role: "user",
        content: `키워드: ${keyword}\n트렌드 조사: ${trend}`,
      },
    ],
  });

  const concept = JSON.parse(completion.choices[0].message.content ?? "{}");
  return NextResponse.json({ concept });
}
