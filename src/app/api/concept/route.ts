import { NextResponse } from "next/server";
import { openai, parseJsonContent, TEXT_MODEL } from "@/lib/openai";
import { agentLog } from "@/lib/log";

export type Concept = {
  id: string;
  name: string;
  description: string;
  mood: string;
  colorPalette: string[];
  targetCustomer: string;
  materials: string[];
  outfitItems: string[];
  bodyProfile: string;
  fitStrategy: string;
  stylingReason: string;
};

export async function POST(req: Request) {
  try {
    const { keyword, trend } = await req.json();

    agentLog("concept", `"${keyword}" 기반 착장 후보 5개 생성 시작`, `chat.completions · ${TEXT_MODEL}`);

    const completion = await openai.chat.completions.create({
      model: TEXT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "너는 소비자 개인화 퍼스널 스타일링 에이전트야. 사용자 요청과 트렌드/날씨/장소 분석을 바탕으로 착장 후보 5개를 JSON으로 생성해줘. 모든 name/description/mood/targetCustomer/bodyProfile/fitStrategy/stylingReason/outfitItems/materials/colorPalette 값은 한국어로 작성해. 사용자가 성별을 말하지 않았다면 기본값은 남성 코디로 둬. 디자이너 컬렉션, 원가, 판매가 이야기는 하지 마. 후보들은 서로 다른 무드/핏/아이템 조합이어야 하며 색상만 다른 정도는 안 된다. 날짜와 장소의 날씨/계절감, 장소 무드, 상황의 포멀리티, 사용자 성별·키·몸무게가 있으면 모두 반영해. 키와 몸무게가 입력됐다면 bodyProfile에 반드시 원 숫자(예: 175cm, 70kg)를 그대로 포함하고, 현실적인 체형 인상(마른/보통/탄탄한/볼륨 있는/큰 체형 등)을 과장 없이 적어. 핏은 체형 + 무드 + 트렌드 적합성을 함께 고려해 정한다. 원단(materials)은 원가 계산용이 아니라 옷 추천과 이미지 질감 표현용이다. outfitItems에는 실제 착용한 모든 제품을 카테고리와 함께 최대한 구체적으로 넣어. 예: '모자: 블랙 볼캡', '상의(이너): 화이트 코튼 티셔츠', '상의(아우터): 네이비 세미오버 블레이저', '상의(레이어드): 라이트그레이 니트 베스트', '하의: 차콜 와이드 슬랙스', '신발: 블랙 레더 로퍼', '악세사리: 실버 체인 목걸이'. 없는 카테고리는 억지로 만들지 말되, 룩북 이미지에 착용될 아이템은 빠짐없이 포함해. 사용자가 색감, 소재, 기장, 핏, 피하고 싶은 옷, 특정 추천 제품군을 말하면 반영한다. JSON 스키마: { concepts: Concept[] } 이며 concepts는 정확히 5개. Concept 필드: id('look_01' 형식), name, description, mood, colorPalette(string[]), targetCustomer, materials(string[]), outfitItems(string[]), bodyProfile, fitStrategy, stylingReason.",
        },
        {
          role: "user",
          content: `사용자 요청: ${keyword}\n\n트렌드/날씨/장소 분석:\n${trend}`,
        },
      ],
    });

    const parsed = parseJsonContent(completion.choices[0].message.content);
    const concepts: Concept[] = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 5) : [];

    if (concepts.length < 5) {
      throw new Error("착장 후보 5개 생성에 실패했어요.");
    }

    agentLog("concept", `착장 후보 ${concepts.length}개 생성 완료`);
    return NextResponse.json({ concepts });
  } catch (e) {
    const message = e instanceof Error ? e.message : "착장 후보 생성 중 알 수 없는 오류";
    agentLog("concept", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
