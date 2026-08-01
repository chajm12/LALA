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
            "너는 소비자 개인화 퍼스널 스타일링 에이전트야. 사용자 요청과 트렌드/날씨/장소 분석을 바탕으로 착장 후보 5개를 JSON으로 생성해줘. 모든 name/description/mood/targetCustomer/bodyProfile/fitStrategy/stylingReason/outfitItems/materials/colorPalette 값은 한국어로 작성해. 사용자가 성별을 말하지 않았다면 기본값은 남성 코디로 둬. 디자이너 컬렉션, 원가, 판매가 이야기는 하지 마. 후보들은 서로 다른 무드/핏/아이템 조합이어야 하며 색상만 다른 정도는 안 된다. 날짜와 장소의 날씨/계절감, 장소 무드, 상황의 포멀리티, 사용자 성별·키·몸무게가 있으면 모두 반영해. 핏은 체형 + 무드 + 트렌드 적합성을 함께 고려해 정한다. 원단(materials)은 원가 계산용이 아니라 옷 추천과 이미지 질감 표현용이다. 사용자가 색감, 소재, 기장, 핏, 피하고 싶은 옷을 말하면 반영한다. JSON 스키마: { concepts: Concept[] } 이며 concepts는 정확히 5개. Concept 필드: id('look_01' 형식), name, description, mood, colorPalette(string[]), targetCustomer, materials(string[]), outfitItems(string[]), bodyProfile, fitStrategy, stylingReason.",
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
