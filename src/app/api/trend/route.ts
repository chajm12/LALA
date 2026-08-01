import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import { agentLog } from "@/lib/log";

export async function POST(req: Request) {
  try {
    const { keyword } = await req.json();

    agentLog(
      "trend",
      `"${keyword}" 키워드로 웹검색 기반 트렌드 조사 시작`,
      "responses.create + web_search_preview · gpt-4o",
    );

    const response = await openai.responses.create({
      model: "gpt-4o",
      tools: [{ type: "web_search_preview" }],
      input: `사용자 요청: "${keyword}"

이 요청에서 계절/시기와 지역(장소)이 언급되어 있는지 파악하고, 다음을 각각 실제로 검색해서 조사해줘 (언급이 없으면 해당 항목은 생략):
1. 핵심 스타일 키워드, 전반적 스타일 방향, 타겟 고객층
2. 지역이 언급됐다면: 그 지역 특유의 스트릿 패션/로컬 브랜드/팝업스토어 등 하이퍼로컬 트렌드 (일반적인 전국 트렌드 말고 그 지역만의 특징)
3. 계절이 언급됐다면: 해당 시기 실제 기후(평균 기온, 습도)와 그에 맞는 원단/실루엣/레이어링 방향 — "여름이니까 반팔"처럼 뭉뚱그리지 말고 실제 날씨 수치를 근거로 제시

답변은 "${keyword}"와 같은 언어로 작성해.`,
    });

    agentLog("trend", `조사 완료 (${response.output_text.length}자)`);

    return NextResponse.json({ trend: response.output_text });
  } catch (e) {
    const message = e instanceof Error ? e.message : "트렌드 조사 중 알 수 없는 오류";
    agentLog("trend", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
