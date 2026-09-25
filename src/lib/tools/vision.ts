import { chatJson, VISION_MODEL } from "@/lib/nim";

export type Critique = { matches: boolean; mismatches: string[] };

/**
 * 룩북 이미지 검증 도구 — VLM NIM.
 * 색상/모델 성별·체형/핵심 아이템의 명백한 불일치만 잡는다 (원단은 사진으로 판별 불가).
 */
export async function critiqueLookbook(imageDataUrl: string, concept: Record<string, unknown>): Promise<Critique> {
  const result = await chatJson<Partial<Critique>>(VISION_MODEL, [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `이 룩북 이미지가 아래 스펙과 일치하는지 검사해줘.
colorPalette: ${JSON.stringify(concept.colorPalette)}
outfitItems: ${JSON.stringify(concept.outfitItems)}
mood: ${concept.mood}
targetCustomer (모델의 성별/체형 인상이 반드시 일치해야 함): ${concept.targetCustomer} / ${concept.bodyProfile ?? ""}

규칙:
- 원단 성분은 사진으로 확인 불가하므로 지적하지 않는다.
- 색상, 모델 성별/체형, 핵심 아이템(아우터/하의/신발 종류)의 명백한 불일치만 mismatches 에 넣는다.
- 반드시 JSON 만 출력: {"matches": boolean, "mismatches": string[]} (한국어)`,
        },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ], { temperature: 0.1, maxTokens: 1024 });
  return {
    matches: Boolean(result.matches),
    mismatches: Array.isArray(result.mismatches) ? result.mismatches.map(String) : [],
  };
}
