import { NextResponse } from "next/server";
import { openai, TREND_MODEL } from "@/lib/openai";
import { agentLog } from "@/lib/log";

export async function POST(req: Request) {
  try {
    const { keyword } = await req.json();

    agentLog(
      "trend",
      `"${keyword}" 키워드로 날짜·장소 날씨와 트렌드 조사 시작`,
      `responses.create + web_search_preview · ${TREND_MODEL}`,
    );

    const response = await openai.responses.create({
      model: TREND_MODEL,
      tools: [{ type: "web_search_preview" }],
      input: `사용자 요청: "${keyword}"

이 요청에서 날짜, 계절/시기, 지역(장소), 성별, 키, 몸무게, 약속/상황이 언급되어 있는지 파악하고, 다음을 각각 실제로 검색해서 조사해줘:
성별이 명시되지 않았다면 기본값은 남성 코디로 분석해.
1. 핵심 스타일 키워드, 전반적 스타일 방향, 타겟 고객층
2. 지역이 언급됐다면: 그 지역 특유의 스트릿 패션/로컬 브랜드/팝업스토어 등 하이퍼로컬 트렌드 (일반적인 전국 트렌드 말고 그 지역만의 특징)
3. 날짜와 장소가 있다면: 해당 날짜·장소의 날씨 또는 예보를 우선 조사해. 예보가 불가능한 먼 날짜라면 해당 날짜의 계절감과 장소 대분류(시/군/구)의 대표 기후를 사용해.
4. 날씨 관련 키워드(여름, 장마, 추움, 더움 등)가 이미 입력에 있으면 그 키워드를 1순위로 반영하고, 없다면 장소의 대분류 기준 날씨/기후를 보조로 반영해.
5. 날씨/계절/장소에 맞는 원단, 실루엣, 레이어링 방향을 제시해. "여름이니까 반팔"처럼 뭉뚱그리지 말고 가능한 경우 실제 기온/강수/습도 근거를 포함해.
6. 키와 몸무게가 있다면 체형과 트렌드가 충돌하지 않도록 추천 핏 방향을 제시해.

반드시 포함할 항목:
- 입력 해석
- 날짜·장소 기반 날씨/계절 판단
- 트렌드 분석
- 체형/핏 방향
- 착장 후보 생성 시 주의할 실패 가능성

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
