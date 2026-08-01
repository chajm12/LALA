import { NextResponse } from "next/server";
import { openai, parseJsonContent } from "@/lib/openai";
import { agentLog } from "@/lib/log";

type Concept = {
  name: string;
  description: string;
  mood: string;
  colorPalette: string[];
  targetCustomer: string;
  materials: string[];
};

async function checkContradiction(concept: Concept) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 패션 QA 검수자야. 아래 패션 컨셉에서 트렌드/시즌 맥락과 원단(materials) 사이에 명백한 논리적 모순이 있는지 확인해줘 (예: 여름 컬렉션에 헤비 울 사용, 방수 아우터에 메시 원단만 사용 등). JSON으로: hasContradiction(boolean), issue(string|null, 모순 내용 한국어 설명), fixedMaterials(string[]|null, 모순이 있을 때만 수정된 원단 목록 제시, 없으면 null).",
      },
      {
        role: "user",
        content: JSON.stringify(concept),
      },
    ],
  });

  return parseJsonContent(completion.choices[0].message.content);
}

export async function POST(req: Request) {
  try {
    const { keyword, trend } = await req.json();

    agentLog("concept", `"${keyword}" 기반 컨셉 2안 기획 시작`, "chat.completions · gpt-4o");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "너는 패션 브랜드 기획자야. 주어진 키워드와 트렌드 조사 결과를 바탕으로 서로 뚜렷하게 다른 패션 컬렉션 컨셉 2개를 JSON으로 기획해줘. 옷은 다양하니까 두 방향이 실루엣/무드/가격 포지셔닝 중 최소 하나는 확실히 갈려야 해 (예: A안은 미니멀 프리미엄, B안은 볼드 캐주얼 — 색상만 다른 정도는 안 됨). 필드: concepts(배열, 정확히 2개). 각 항목: name, description, mood, colorPalette(string[]), targetCustomer, materials(string[]) - 핵심 원단/부자재 목록, 가장 비중 큰 주 원단을 배열 맨 앞에 배치 (예: ['3-layer waterproof recycled nylon', 'YKK waterproof zipper']), 영문 소재명으로 작성 (원가 조사에 그대로 검색어로 쓰임). 트렌드 조사 결과에 실제 기후(기온/습도) 정보가 있다면 materials는 반드시 그 기후에 실제로 적합한 원단이어야 해 (예: 고온다습한 여름이면 통기성/속건성 좋은 가벼운 원단을 우선하고 두꺼운 겨울 원단은 피해). 트렌드 조사 결과에 지역 특유의 로컬 트렌드가 있다면 description/mood에 반영해. name과 colorPalette, materials 값을 제외한 모든 텍스트(description, mood, targetCustomer)는 사용자 입력과 같은 언어로 작성해. 사용자 입력이 한국어면 한국어로 작성해.",
        },
        {
          role: "user",
          content: `키워드: ${keyword}\n트렌드 조사: ${trend}`,
        },
      ],
    });

    const parsed = parseJsonContent(completion.choices[0].message.content);
    const concepts: Concept[] = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 2) : [];

    if (concepts.length < 2) {
      throw new Error("컨셉 2안 생성에 실패했어요 (모델이 2개를 반환하지 않음)");
    }

    agentLog(
      "concept",
      `컨셉 2안 생성 완료: A) "${concepts[0].name}" / B) "${concepts[1].name}"`,
    );

    agentLog("concept", `시즌/소재 모순 체크 중 (2안 병렬)...`, "chat.completions · gpt-4o");
    const contradictionIssues = await Promise.all(
      concepts.map(async (concept, i) => {
        try {
          const check = await checkContradiction(concept);
          if (
            check.hasContradiction &&
            Array.isArray(check.fixedMaterials) &&
            check.fixedMaterials.length
          ) {
            concept.materials = check.fixedMaterials;
            const issue = typeof check.issue === "string" ? check.issue : null;
            agentLog(
              "concept",
              `⚠ ${i === 0 ? "A안" : "B안"} 모순 발견: ${issue} → 원단 자동 수정: ${concept.materials.join(", ")}`,
            );
            return issue;
          }
          agentLog("concept", `✓ ${i === 0 ? "A안" : "B안"} 모순 없음`);
          return null;
        } catch {
          agentLog("concept", `✗ ${i === 0 ? "A안" : "B안"} 모순 체크 실패 (best-effort, 원본 유지)`);
          return null;
        }
      }),
    );

    return NextResponse.json({ concepts, contradictionIssues });
  } catch (e) {
    const message = e instanceof Error ? e.message : "컨셉 기획 중 알 수 없는 오류";
    agentLog("concept", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
