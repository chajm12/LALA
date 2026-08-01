import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";

export async function POST(req: Request) {
  const { keyword } = await req.json();

  const response = await openai.responses.create({
    model: "gpt-4o",
    tools: [{ type: "web_search_preview" }],
    input: `"${keyword}" 관련 최신 패션 시장 트렌드를 조사해줘. 핵심 키워드, 스타일 방향, 타겟 고객층을 요약해줘.`,
  });

  return NextResponse.json({ trend: response.output_text });
}
