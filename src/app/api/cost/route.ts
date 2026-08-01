import { NextResponse } from "next/server";
import { openai, parseJsonContent } from "@/lib/openai";
import { agentLog } from "@/lib/log";

const MIN_MARGIN_RATE = 0.5;
const MAX_MARGIN_RATE = 0.8;
const MARGIN_RETRY_THRESHOLD = 0.65;

// Escalating sourcing tiers the agent works through when margin falls
// short - mirrors how a real sourcing person would actually search:
// domestic standard market first, then domestic discount/deadstock,
// then overseas direct-import as a last resort.
const SOURCING_TIERS = [
  {
    id: "domestic-standard",
    label: "국내 시중 표준 원단",
    searchHint: "동대문 등 한국 원단 도매시장에서 유통되는 대표적인 표준 원단 시세",
    candidateHint: "동대문 등 한국 원단 도매시장에서 구할 수 있는 대표적인 표준 원단",
  },
  {
    id: "domestic-discount",
    label: "국내 할인/특가 원단",
    searchHint: "국내에서 이월·재고·특가로 유통되는 할인 원단 시세",
    candidateHint: "국내에서 이월/재고/땡처리로 유통되는 할인·특가 원단 (표준 시중가보다 저렴한 것)",
  },
  {
    id: "overseas-direct",
    label: "해외 직구 원단",
    searchHint: "알리바바 등 해외 사이트에서 직구로 구매 가능한 원단 시세 (배송비·관세 포함)",
    candidateHint:
      "알리바바 등 해외 사이트에서 직구로 구매 가능한 원단 (배송비·관세·MOQ까지 고려한 실질 단가)",
  },
] as const;

const MAX_RETRIES = SOURCING_TIERS.length;

async function researchMarket(
  concept: Record<string, unknown>,
  materials: string[],
  tier?: (typeof SOURCING_TIERS)[number],
) {
  const scope = tier
    ? `${tier.searchHint}를 중심으로 조사해줘.`
    : `일반적인 도매 원가 시세와 통상 소매 마진율을 조사해줘.`;
  const response = await openai.responses.create({
    model: "gpt-4o",
    tools: [{ type: "web_search_preview" }],
    input: `다음 원단/부자재에 대해 "${concept.name}" 같은 포지셔닝의 패션 제품군 기준으로 ${scope} 원단/부자재: ${materials.join(", ")}. 구체적인 가격대(원/야드 등)와 마진율(%) 범위를 최대한 근거와 함께 요약해줘.`,
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
          "너는 의류 제작 원가 산출 전문가야. 아래 실시간 시장 조사 결과를 근거로 삼아 제작 원가와 마진율을 JSON으로 산출해줘. 필드: materialCost, laborCost, overheadCost (모두 KRW 숫자), marginRate (마진율 = (판매가-원가)/판매가 정의상 절대 1을 넘을 수 없는 0~1 사이 소수. 조사된 통상 마진율 범위에서 선택하되 0.3~0.8 사이로 답해. 예: 마진 65%면 0.65. '원가의 몇 배로 파는지'를 뜻하는 마크업 배수와 절대 혼동하지 마), breakdown(string[]) - 조사 결과의 구체적 수치를 인용해서 산출 근거 설명, marginRate와 반드시 같은 숫자를 언급해야 함. totalCost나 판매가는 계산하지 마 (별도로 계산함). breakdown은 컨셉 설명과 같은 언어로 작성해.",
      },
      {
        role: "user",
        content: `컨셉: ${JSON.stringify(concept)}\n원단/부자재: ${materials.join(", ")}\n\n시장 조사 결과:\n${research}`,
      },
    ],
  });

  return parseJsonContent(completion.choices[0].message.content);
}

type MaterialCandidate = { material: string; note: string };

async function compareMaterialAlternatives(
  primaryMaterial: string,
  research: string,
  tier: (typeof SOURCING_TIERS)[number],
) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `너는 원단 소싱 전문가야. 마진율이 목표치보다 낮아서 더 저렴한 대체 원단이 필요해. ${tier.candidateHint}에서만 찾아줘 (다른 소싱 경로는 이번 단계에서 고려하지 마). 아래 시장 조사 결과를 참고해서, 핵심 기능(방수/보온 등)은 유지하면서 원가가 더 낮은 대체 원단 후보를 2~3개 제안해줘. JSON으로: candidates(배열, 각 항목: material(string, 영문 소재명), note(string, 원가/장단점 설명, 한국어)), selected(string, candidates 중 최종 추천 원단명 — candidates에 있는 값과 정확히 일치해야 함), reason(string, 왜 이걸 선택했는지 한국어).`,
      },
      {
        role: "user",
        content: `기존 원단: ${primaryMaterial}\n\n시장 조사 결과:\n${research}`,
      },
    ],
  });

  return parseJsonContent(completion.choices[0].message.content);
}

type CostIteration = {
  iteration: number;
  tierLabel: string | null;
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
  try {
    const { concept } = await req.json();
    let materials: string[] =
      Array.isArray(concept.materials) && concept.materials.length
        ? concept.materials
        : [concept.mood ?? "general apparel fabric"];

    const history: CostIteration[] = [];
    let reason: string | null = null;
    let candidates: MaterialCandidate[] | null = null;
    let tierLabel: string | null = null;

    for (let i = 0; i <= MAX_RETRIES; i++) {
      const currentTier = i === 0 ? undefined : SOURCING_TIERS[i - 1];

      agentLog(
        "cost",
        `[${i}회차${currentTier ? ` · ${currentTier.label}` : ""}] 시장 조사 시작 — 원단: ${materials.join(", ")}`,
        "responses.create + web_search_preview · gpt-4o",
      );
      const research = await researchMarket(concept, materials, currentTier);

      agentLog("cost", `[${i}회차] 원가 추정 요청`, "chat.completions · gpt-4o");
      const raw = await estimateCost(concept, materials, research);

      const materialCost = Number(raw.materialCost) || 0;
      const laborCost = Number(raw.laborCost) || 0;
      const overheadCost = Number(raw.overheadCost) || 0;
      const totalCost = materialCost + laborCost + overheadCost;

      const rawMarginRate = Number(raw.marginRate) || 0.65;
      const marginRate = Math.min(Math.max(rawMarginRate, MIN_MARGIN_RATE), MAX_MARGIN_RATE);
      const sellCost = Math.round(totalCost / (1 - marginRate));

      const breakdown: string[] = Array.isArray(raw.breakdown) ? raw.breakdown : [];
      if (Math.abs(rawMarginRate - marginRate) > 0.01) {
        agentLog(
          "cost",
          `⚠ AI가 제안한 마진율(${Math.round(rawMarginRate * 100)}%)이 비정상 범위라 ${Math.round(marginRate * 100)}%로 보정`,
        );
        breakdown.push(
          `(자동 보정) AI가 처음 제안한 마진율은 ${Math.round(rawMarginRate * 100)}%였지만, 마진율은 정의상 100%를 넘을 수 없어 ${Math.round(marginRate * 100)}%로 조정했습니다.`,
        );
      }

      agentLog(
        "cost",
        `[${i}회차] 원가=${totalCost.toLocaleString()}원, 마진=${Math.round(marginRate * 100)}%, 판매가=${sellCost.toLocaleString()}원`,
      );

      history.push({
        iteration: i,
        tierLabel,
        materials,
        materialCost,
        laborCost,
        overheadCost,
        totalCost,
        marginRate,
        sellCost,
        breakdown,
        reason,
        candidates,
      });

      if (marginRate >= MARGIN_RETRY_THRESHOLD) {
        agentLog("cost", `✓ 마진 기준(${Math.round(MARGIN_RETRY_THRESHOLD * 100)}%) 충족 → 재평가 종료`);
        break;
      }
      if (i === MAX_RETRIES) {
        agentLog(
          "cost",
          `⚠ 마진 기준 미달이지만 모든 소싱 단계(${SOURCING_TIERS.map((t) => t.label).join(" → ")})를 다 탐색함 → 종료`,
        );
        break;
      }

      const nextTier = SOURCING_TIERS[i];
      agentLog(
        "cost",
        `⚠ 마진 ${Math.round(marginRate * 100)}% < 기준 ${Math.round(MARGIN_RETRY_THRESHOLD * 100)}% → 다음 단계 "${nextTier.label}"에서 대체 원단 탐색`,
        "chat.completions · gpt-4o",
      );
      const alt = await compareMaterialAlternatives(materials[0], research, nextTier);
      if (!Array.isArray(alt.candidates) || !alt.candidates.length || !alt.selected) {
        agentLog("cost", `✗ "${nextTier.label}"에서 대체 원단 탐색 실패 → 재평가 종료`);
        break;
      }

      candidates = alt.candidates;
      reason = typeof alt.reason === "string" ? alt.reason : null;
      tierLabel = nextTier.label;
      materials = [alt.selected, ...materials.slice(1)];
      agentLog(
        "cost",
        `"${nextTier.label}"에서 후보 ${alt.candidates.length}개 비교 → "${alt.selected}" 선택 (${reason})`,
      );
    }

    agentLog("cost", `총 ${history.length}회 평가 완료`);

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
      substitutionTier: last.tierLabel,
      candidates: last.candidates,
      history,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "원가 산출 중 알 수 없는 오류";
    agentLog("cost", `✗ 요청 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
