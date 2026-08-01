import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";

const MIN_MARGIN_RATE = 0.5;
const MAX_MARGIN_RATE = 0.8;
const MARGIN_RETRY_THRESHOLD = 0.65;
const MAX_RETRIES = 2;

async function researchMarket(concept: Record<string, unknown>, materials: string[]) {
  const response = await openai.responses.create({
    model: "gpt-4o",
    tools: [{ type: "web_search_preview" }],
    input: `다음 원단/부자재의 최근 도매 원가 시세와, "${concept.name}" 같은 포지셔닝의 패션 제품군에서 통상적으로 적용되는 소매 마진율을 조사해줘. 원단/부자재: ${materials.join(", ")}. 구체적인 가격대(원/야드 등)와 마진율(%) 범위를 최대한 근거와 함께 요약해줘.`,
  });
  return response.output_text;
}

async function estimateCost(
  concept: Record<string, unknown>,
  materials: string[],
  research: string,
) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 의류 제작 원가 산출 전문가야. 아래 실시간 시장 조사 결과를 근거로 삼아 제작 원가와 마진율을 JSON으로 산출해줘. 필드: materialCost, laborCost, overheadCost (모두 KRW 숫자), marginRate (0~1 사이 숫자, 조사된 통상 마진율 범위에서 선택), breakdown(string[]) - 조사 결과의 구체적 수치를 인용해서 산출 근거 설명. totalCost나 판매가는 계산하지 마 (별도로 계산함). breakdown은 컨셉 설명과 같은 언어로 작성해.",
      },
      {
        role: "user",
        content: `컨셉: ${JSON.stringify(concept)}\n원단/부자재: ${materials.join(", ")}\n\n시장 조사 결과:\n${research}`,
      },
    ],
  });

  return JSON.parse(completion.choices[0].message.content ?? "{}");
}

type MaterialCandidate = { material: string; note: string };

async function compareMaterialAlternatives(primaryMaterial: string, research: string) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 원단 소싱 전문가야. 마진율이 목표치보다 낮아서 더 저렴한 대체 원단이 필요해. 아래 시장 조사 결과를 참고해서, 핵심 기능(방수/보온 등)은 유지하면서 원가가 더 낮은 대체 원단 후보를 2~3개 제안해줘. JSON으로: candidates(배열, 각 항목: material(string, 영문 소재명), note(string, 원가/장단점 설명, 한국어)), selected(string, candidates 중 최종 추천 원단명 — candidates에 있는 값과 정확히 일치해야 함), reason(string, 왜 이걸 선택했는지 한국어).",
      },
      {
        role: "user",
        content: `기존 원단: ${primaryMaterial}\n\n시장 조사 결과:\n${research}`,
      },
    ],
  });

  return JSON.parse(completion.choices[0].message.content ?? "{}");
}

type CostIteration = {
  iteration: number;
  materials: string[];
  materialCost: number;
  laborCost: number;
  overheadCost: number;
  totalCost: number;
  marginRate: number;
  sellCost: number;
  breakdown: string[];
  reason: string | null;
  candidates: MaterialCandidate[] | null;
};

export async function POST(req: Request) {
  const { concept } = await req.json();
  let materials: string[] =
    Array.isArray(concept.materials) && concept.materials.length
      ? concept.materials
      : [concept.mood ?? "general apparel fabric"];

  const history: CostIteration[] = [];
  let reason: string | null = null;
  let candidates: MaterialCandidate[] | null = null;

  for (let i = 0; i <= MAX_RETRIES; i++) {
    const research = await researchMarket(concept, materials);
    const raw = await estimateCost(concept, materials, research);

    const materialCost = Number(raw.materialCost) || 0;
    const laborCost = Number(raw.laborCost) || 0;
    const overheadCost = Number(raw.overheadCost) || 0;
    const totalCost = materialCost + laborCost + overheadCost;

    const marginRate = Math.min(
      Math.max(Number(raw.marginRate) || 0.65, MIN_MARGIN_RATE),
      MAX_MARGIN_RATE,
    );
    const sellCost = Math.round(totalCost / (1 - marginRate));

    history.push({
      iteration: i,
      materials,
      materialCost,
      laborCost,
      overheadCost,
      totalCost,
      marginRate,
      sellCost,
      breakdown: Array.isArray(raw.breakdown) ? raw.breakdown : [],
      reason,
      candidates,
    });

    if (marginRate >= MARGIN_RETRY_THRESHOLD || i === MAX_RETRIES) break;

    const alt = await compareMaterialAlternatives(materials[0], research);
    if (!Array.isArray(alt.candidates) || !alt.candidates.length || !alt.selected) break;

    candidates = alt.candidates;
    reason = typeof alt.reason === "string" ? alt.reason : null;
    materials = [alt.selected, ...materials.slice(1)];
  }

  const last = history[history.length - 1];
  const cost = {
    materialCost: last.materialCost,
    laborCost: last.laborCost,
    overheadCost: last.overheadCost,
    totalCost: last.totalCost,
    marginRate: last.marginRate,
    sellCost: last.sellCost,
    breakdown: last.breakdown,
  };

  return NextResponse.json({
    cost,
    materials: last.materials,
    materialsUpdated: history.length > 1,
    substitutionReason: last.reason,
    candidates: last.candidates,
    history,
  });
}
