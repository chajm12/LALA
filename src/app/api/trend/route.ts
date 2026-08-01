import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import { agentLog } from "@/lib/log";

export async function POST(req: Request) {
  const { keyword } = await req.json();

  agentLog("trend", `"${keyword}" 키워드로 웹검색 기반 트렌드 조사 시작`);

  const response = await openai.responses.create({
    model: "gpt-4o",
    tools: [{ type: "web_search_preview" }],
    input: `"${keyword}" 관련 최신 패션 시장 트렌드를 조사해줘. 핵심 키워드, 스타일 방향, 타겟 고객층을 요약해줘. 답변은 "${keyword}"와 같은 언어로 작성해.`,
  });

  agentLog("trend", `조사 완료 (${response.output_text.length}자)`);

  return NextResponse.json({ trend: response.output_text });
}
