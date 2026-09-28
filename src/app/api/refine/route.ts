import { NextResponse } from "next/server";
import { getNvidiaClient, NVIDIA_PLAN_MODEL } from "@/lib/nvidia";
import { parseJsonObjectFromText } from "@/lib/openai";
import { agentLog } from "@/lib/log";

type Concept = Record<string, unknown>;

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function keepConceptShape(value: unknown, original: Concept): Concept {
  const candidate = value && typeof value === "object" ? value as Concept : {};
  return {
    ...original,
    ...candidate,
    id: original.id,
    targetCustomer: candidate.targetCustomer ?? original.targetCustomer ?? "남성",
    colorPalette: asArray(candidate.colorPalette ?? original.colorPalette),
    materials: asArray(candidate.materials ?? original.materials),
    outfitItems: asArray(candidate.outfitItems ?? original.outfitItems),
  };
}

function replaceCategory(items: string[], pattern: RegExp, replacement: string) {
  const index = items.findIndex((item) => pattern.test(item));
  if (index === -1) return [...items, replacement];
  return items.map((item, itemIndex) => itemIndex === index ? replacement : item);
}

function firstMatch(text: string, values: string[]) {
  return values.find((value) => text.includes(value)) ?? "";
}

function enforceExplicitRequest(concept: Concept, feedback: string) {
  const text = feedback.toLowerCase();
  let outfitItems = asArray(concept.outfitItems);
  let materials = asArray(concept.materials);
  let colorPalette = asArray(concept.colorPalette);
  const changed: string[] = [];
  const colorWords = ["블랙", "검정", "화이트", "흰색", "아이보리", "크림", "베이지", "브라운", "차콜", "네이비", "블루", "그린", "버건디", "실버"];
  const color = firstMatch(text, colorWords);
  const fit = firstMatch(text, ["오버사이즈", "세미오버", "오버", "릴랙스", "와이드", "스트레이트", "테이퍼드", "슬림", "짧은", "크롭", "롱", "긴"]);
  const colorNear = (pattern: RegExp, fallback: string) => {
    const segment = text.split(/[,.;]|그리고/).find((part) => pattern.test(part)) ?? "";
    return firstMatch(segment, colorWords) || fallback;
  };

  if (/(하의|팬츠|바지|스커트|치마).*(데님|청바지)|(데님|청바지).*(하의|팬츠|바지)/.test(text)) {
    const bottomFit = fit || "스트레이트";
    const bottomColor = colorNear(/하의|팬츠|바지|데님|청바지|스커트|치마/, "인디고");
    outfitItems = replaceCategory(outfitItems, /하의|팬츠|바지|데님|슬랙스|스커트|치마|쇼츠/, `하의: ${bottomColor} ${bottomFit} 데님 팬츠`);
    materials = [...new Set([...materials, "데님"])];
    colorPalette = [...new Set([bottomColor, ...colorPalette])];
    changed.push("하의는 데님으로 고정");
  }

  const outerType = firstMatch(text, ["바람막이", "블루종", "재킷", "자켓", "코트", "카디건", "셔츠 재킷", "베스트"]);
  if (outerType && /아우터|재킷|자켓|블루종|코트|카디건|셔츠 재킷|베스트|바람막이/.test(text)) {
    const outerLength = /짧|크롭/.test(text) ? "크롭" : /롱|긴/.test(text) ? "롱" : "세미";
    const outerColor = colorNear(/아우터|재킷|자켓|블루종|코트|카디건|셔츠 재킷|베스트|바람막이/, "차콜");
    outfitItems = replaceCategory(outfitItems, /아우터|재킷|자켓|블루종|코트|카디건|셔츠 재킷|베스트|셸|파카/, `아우터: ${outerColor} ${outerLength} ${outerType}`);
    changed.push(`아우터는 ${outerColor} ${outerLength} ${outerType}로 조정`);
  }

  const topType = firstMatch(text, ["니트 폴로", "폴로", "후드티", "맨투맨", "터틀넥", "티셔츠", "셔츠", "니트", "후드"]);
  if (topType && /상의|이너|티셔츠|셔츠|니트|폴로|후드|맨투맨|터틀넥/.test(text) && !outerType) {
    const topColor = colorNear(/상의|이너|티셔츠|셔츠|니트|폴로|후드|맨투맨|터틀넥/, "오프화이트");
    outfitItems = replaceCategory(outfitItems, /이너|상의|티셔츠|셔츠|니트|폴로|후드|맨투맨|터틀넥/, `이너: ${topColor} ${fit || "레귤러"} ${topType}`);
    changed.push(`이너는 ${topColor} ${topType}로 조정`);
  }

  const shoeType = firstMatch(text, ["스니커즈", "로퍼", "더비", "부츠", "샌들", "러너"]);
  if (shoeType && /신발|슈즈|스니커즈|로퍼|더비|부츠|샌들|러너/.test(text)) {
    const shoeColor = colorNear(/신발|슈즈|스니커즈|로퍼|더비|부츠|샌들|러너/, "블랙");
    outfitItems = replaceCategory(outfitItems, /신발|슈즈|스니커즈|로퍼|더비|부츠|샌들|러너/, `신발: ${shoeColor} ${shoeType}`);
    changed.push(`신발은 ${shoeColor} ${shoeType}로 조정`);
  }

  if (color && changed.length === 0) {
    colorPalette = [...new Set([color, ...colorPalette])];
    changed.push(`주요 색상은 ${color}로 조정`);
  }

  return {
    ...concept,
    outfitItems,
    materials,
    colorPalette,
    refinementRequest: feedback,
    stylingReason: `${asText(concept.stylingReason)} 사용자 최신 요청을 우선 반영했습니다: ${feedback}`.trim(),
    explicitChanges: changed,
  };
}

async function refineConcept(concept: Concept, feedback: string, trend: string) {
  const response = await getNvidiaClient().chat.completions.create(
    {
      model: NVIDIA_PLAN_MODEL,
      temperature: 0.25,
      max_tokens: 1800,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "너는 DDP PARK SAJANG의 룩 수정 에이전트야. 모든 출력은 한국어 JSON만 작성해. " +
            "사용자가 명시한 수정 요청을 최우선으로 반영하되, 사용자가 언급하지 않은 아이템·색·핏·소재는 그대로 유지해. " +
            "레이어링, 상의·하의·신발 교체처럼 한 번에 여러 요소를 바꾸는 요청도 정확한 착용 아이템 목록으로 정리해. " +
            "단순히 '더 예쁘게' 같은 요청은 현재 장소·날씨·무드와 기존 코디를 유지하면서 가장 작은 변경으로 해석해. " +
            "반드시 {\"concept\": Concept, \"reply\": string, \"changed\": string[]} 형태로 반환해.",
        },
        {
          role: "user",
          content:
            `기존 코디:\n${JSON.stringify(concept, null, 2)}\n\n` +
            `사용자 수정 요청:\n${feedback}\n\n` +
            `날씨·장소·스타일 컨텍스트:\n${trend.slice(0, 7000)}\n\n` +
            "기존 코디에서 유지할 부분과 바꿀 부분을 구분해 새 concept를 작성해.",
        },
      ],
    } as never,
    { signal: AbortSignal.timeout(30_000) },
  );
  const parsed = parseJsonObjectFromText(response.choices[0]?.message?.content);
  const nextConcept = keepConceptShape(parsed.concept, concept);
  return {
    concept: nextConcept,
    reply: asText(parsed.reply) || "요청한 부분을 반영해 기존 코디의 균형은 유지했어요.",
    changed: asArray(parsed.changed),
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const concept = body.concept && typeof body.concept === "object" ? body.concept as Concept : null;
    const feedback = asText(body.feedback);
    if (!concept || !feedback) {
      return NextResponse.json({ error: "수정할 룩과 수정 요청을 함께 보내주세요." }, { status: 400 });
    }

    agentLog("concept", `룩 수정 요청 해석: ${feedback}`, `NVIDIA NIM · ${NVIDIA_PLAN_MODEL}`);
    let refined: { concept: Concept; reply: string; changed: string[] };
    try {
      refined = await refineConcept(concept, feedback, asText(body.trend));
    } catch (error) {
      agentLog("concept", `모델 수정 응답 실패, 명시 요청 기반 로컬 수정으로 전환합니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
      refined = {
        concept,
        reply: "명시하신 아이템 변경을 우선 반영해 룩을 다시 만들게요.",
        changed: [],
      };
    }
    const enforcedConcept = enforceExplicitRequest(refined.concept, feedback);
    const changed = [...new Set([...refined.changed, ...asArray(enforcedConcept.explicitChanges)])];
    const refinementReply = changed.length
      ? `요청하신 ${changed.join(", ")}을 반영해 다시 만들고 있어요.`
      : refined.reply;
    const lookbookResponse = await fetch(new URL("/api/lookbook", req.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: enforcedConcept,
        evaluation: body.evaluation,
        trend: body.trend,
        weather: body.weather,
      }),
      cache: "no-store",
    });
    const lookbook = await lookbookResponse.json() as Record<string, unknown>;
    if (!lookbookResponse.ok) throw new Error(String(lookbook.error ?? "수정된 룩북 이미지 생성에 실패했어요."));

    return NextResponse.json({
      ...lookbook,
      concept: enforcedConcept,
      refinementReply,
      changed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "룩 수정에 실패했어요.";
    agentLog("concept", `✗ 룩 수정 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
