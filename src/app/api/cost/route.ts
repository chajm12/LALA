import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";

const MIN_MARGIN_RATE = 0.5;
const MAX_MARGIN_RATE = 0.8;

export async function POST(req: Request) {
  const { concept } = await req.json();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 의류 제작 원가 산출 전문가야. 주어진 컨셉을 바탕으로 개략적인 제작 원가와 판매 마진율을 JSON으로 산출해줘. 필드: materialCost, laborCost, overheadCost (모두 KRW 숫자), marginRate (0~1 사이 숫자, 패션 리테일 통상 마진율 0.5~0.8 범위에서 컨셉의 포지셔닝에 맞게 선택), breakdown(string[]) - 산출 근거 설명. totalCost나 판매가는 계산하지 마 (별도로 계산함). breakdown의 각 문장은 컨셉 설명(description)과 같은 언어로 작성해.",
      },
      {
        role: "user",
        content: `컨셉: ${JSON.stringify(concept)}`,
      },
    ],
  });

  const raw = JSON.parse(completion.choices[0].message.content ?? "{}");

  const materialCost = Number(raw.materialCost) || 0;
  const laborCost = Number(raw.laborCost) || 0;
  const overheadCost = Number(raw.overheadCost) || 0;
  const totalCost = materialCost + laborCost + overheadCost;

  const marginRate = Math.min(
    Math.max(Number(raw.marginRate) || 0.65, MIN_MARGIN_RATE),
    MAX_MARGIN_RATE,
  );
  const sellCost = Math.round(totalCost / (1 - marginRate));

  const cost = {
    materialCost,
    laborCost,
    overheadCost,
    totalCost,
    marginRate,
    sellCost,
    breakdown: Array.isArray(raw.breakdown) ? raw.breakdown : [],
  };

  return NextResponse.json({ cost });
}
