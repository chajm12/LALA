import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import { agentLog } from "@/lib/log";

async function checkContradiction(concept: Record<string, unknown>) {
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

  return JSON.parse(completion.choices[0].message.content ?? "{}");
}

export async function POST(req: Request) {
  const { keyword, trend } = await req.json();

  agentLog("concept", `"${keyword}" 기반 컨셉 기획 시작`);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 패션 브랜드 기획자야. 주어진 키워드와 트렌드 조사 결과를 바탕으로 패션 컬렉션 컨셉을 JSON으로 기획해줘. 필드: name, description, mood, colorPalette(string[]), targetCustomer, materials(string[]) - 이 컨셉에 사용할 핵심 원단/부자재 목록, 가장 비중 큰 주 원단을 배열 맨 앞에 배치 (예: ['3-layer waterproof recycled nylon', 'YKK waterproof zipper']), 영문 소재명으로 작성 (원가 조사에 그대로 검색어로 쓰임). name과 colorPalette, materials 값을 제외한 모든 텍스트(description, mood, targetCustomer)는 사용자 입력과 같은 언어로 작성해. 사용자 입력이 한국어면 한국어로 작성해.",
      },
      {
        role: "user",
        content: `키워드: ${keyword}\n트렌드 조사: ${trend}`,
      },
    ],
  });

  const concept = JSON.parse(completion.choices[0].message.content ?? "{}");
  agentLog(
    "concept",
    `컨셉 생성 완료: "${concept.name}" / 원단: ${(concept.materials ?? []).join(", ")}`,
  );

  let contradictionIssue: string | null = null;
  agentLog("concept", `시즌/소재 모순 체크 중...`);
  try {
    const check = await checkContradiction(concept);
    if (check.hasContradiction && Array.isArray(check.fixedMaterials) && check.fixedMaterials.length) {
      concept.materials = check.fixedMaterials;
      contradictionIssue = typeof check.issue === "string" ? check.issue : null;
      agentLog(
        "concept",
        `⚠ 모순 발견: ${contradictionIssue} → 원단 자동 수정: ${concept.materials.join(", ")}`,
      );
    } else {
      agentLog("concept", `✓ 모순 없음`);
    }
  } catch {
    agentLog("concept", `✗ 모순 체크 실패 (best-effort, 원본 컨셉 유지)`);
  }

  return NextResponse.json({ concept, contradictionIssue });
}
