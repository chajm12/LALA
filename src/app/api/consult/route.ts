import { NextResponse } from "next/server";
import { CORE_GARMENT_POLICY, sanitizeCoreText } from "@/lib/garments";
import { getNvidiaClient, NVIDIA_FAST_MODEL } from "@/lib/nvidia";
import { agentLog } from "@/lib/log";
import { parseJsonObjectFromText } from "@/lib/openai";
import {
  buildDirectConsultationReply,
  isGenericConsultationReply,
  type DirectConsultationInput,
} from "@/lib/consultation-replies";

type ConsultationStage = "place" | "fit" | "material";

function optionsForStage(stage: ConsultationStage, keyword: string, trend: string) {
  if (stage === "place") {
    return ["추천해줘", ...(/결혼|장례|회의|면접|오피스|비즈니스/.test(keyword)
      ? ["조금 더 편안하게", "격식을 유지해줘"]
      : ["조금 더 차분하게", "조금 더 개성 있게"])]
      .filter((item, index, items) => items.indexOf(item) === index);
  }
  if (stage === "fit") {
    return ["추천해줘", ...(/오버|여유|편안/.test(`${keyword} ${trend}`)
      ? ["상체만 여유 있게", "하의는 곧게 정리해줘"]
      : ["상체를 더 여유 있게", "실루엣을 더 단정하게"])]
      .filter((item, index, items) => items.indexOf(item) === index);
  }

  const context = `${keyword} ${trend}`;
  if (/비|강수|우산|습기|방수/.test(context)) {
    return ["추천해줘", "기능성 소재를 더해줘", "기능성보다 자연스러운 소재로"];
  }
  if (/여름|더워|폭염|한낮/.test(context)) {
    return ["추천해줘", "통기성 있는 소재로", "조금 더 구조적인 소재로"];
  }
  if (/겨울|추워|한파|보온/.test(context)) {
    return ["추천해줘", "보온 레이어를 더해줘", "가볍고 얇게 조정해줘"];
  }
  return ["추천해줘", "질감과 패턴을 더해줘", "소재를 더 가볍게"];
}

function asText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function compactContext(value: string, limit: number) {
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.45);
  const tail = limit - head;
  return `${value.slice(0, head)}\n…중간 분석 생략…\n${value.slice(-tail)}`;
}

function stageInstruction(stage: ConsultationStage) {
  if (stage === "place") {
    return "장소와 약속의 분위기, 이동량, 시간대를 해석하고 그에 맞는 스타일 무드와 격식 수준을 추천해. 사용자가 정하지 않은 부분은 가장 자연스러운 방향을 먼저 제안하고, 결과를 크게 바꿀 때만 짧게 확인해.";
  }
  if (stage === "fit") {
    return "키·몸무게·성별은 현실적인 아바타 비율과 기장감에만 반영하고, 장소 무드와 사용자 피드백을 바탕으로 상의·하의·아우터의 핏과 비율을 구체적으로 추천해. 사용자가 핏을 정하지 않았다면 체형과 장소에 어울리는 기본안을 먼저 제시해.";
  }
  return "날씨·계절·장소 무드에 맞는 소재, 표면감, 패턴, 레이어링을 추천해. 사용자가 소재를 정하지 않았다면 가장 어울리는 조합을 먼저 제시하고, 기능성과 패션성을 한쪽으로 과하게 몰지 마.";
}

function missingInformation(stage: ConsultationStage, keyword: string, feedback: string[]) {
  // Fit and material preferences are optional: absence is permission to recommend,
  // not a reason to ask the same question in another wording.
  const context = `${keyword} ${feedback.join(" ")}`;
  if (stage === "place" && !/결혼|장례|회의|면접|데이트|여행|카페|공연|식당|출근|약속|친구|일상|캐주얼/.test(context)) {
    return "격식 있는 행사인지 일상복인지가 실제 선택을 바꿀 때만 약속의 성격을 한 번 확인";
  }
  return "추가 질문 없이 현재 조건에 맞는 구체적인 조합 추천";
}

function cleanVisibleText(value: unknown) {
  if (typeof value !== "string") return "";
  const withoutThinkingTags = value.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const finalAnswer = withoutThinkingTags.match(/(?:최종 답변|final answer|answer)\s*[:：]\s*([\s\S]*)$/i)?.[1];
  const cleaned = (finalAnswer ?? withoutThinkingTags).trim();
  if (/^(here(?:'s| is)\s+)?a\s+thinking\s+process/i.test(cleaned)) return "";
  return cleaned;
}

function cleanQuestion(value: unknown) {
  const question = cleanVisibleText(value);
  if (!question || /^(없음|없습니다|해당 없음|질문 없음|필요 없음|n\/a)$/i.test(question)) return "";
  return question;
}

export async function POST(req: Request) {
  let fallbackInput: DirectConsultationInput | null = null;
  try {
    const body = await req.json();
    const keyword = asText(body?.keyword);
    const trend = compactContext(asText(body?.trend), 6_000);
    const placeContext = asText(body?.placeContext).slice(-4_000);
    const intent = body?.intent && typeof body.intent === "object"
      ? JSON.stringify(body.intent).slice(0, 5_000)
      : "사용자 요구사항 구조화 결과 없음";
    const feedback = Array.isArray(body?.feedback)
      ? body.feedback.map((item: unknown) => asText(item)).filter(Boolean).slice(-8)
      : [];
    const latestFeedback = feedback.at(-1) ?? "아직 없음";
    const confirmedFeedback = feedback.length > 1 ? feedback.slice(0, -1) : [];
    const stage = body?.stage as ConsultationStage;

    if (!keyword || !["place", "fit", "material"].includes(stage)) {
      return NextResponse.json({ error: "상담에 필요한 입력이 부족합니다." }, { status: 400 });
    }

    fallbackInput = { keyword, feedback, stage, trend };
    const missing = missingInformation(stage, keyword, feedback);
    const delegated = /추천해|알아서|판단해|골라|맡길/.test(latestFeedback);

    const response = await getNvidiaClient().chat.completions.create(
      {
        model: NVIDIA_FAST_MODEL,
        temperature: 0.2,
        max_tokens: 900,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "너는 DDP PARK SAJANG의 한국어 퍼스널 스타일링 상담 Tool이야. 응답은 반드시 JSON 객체로 바로 시작하고 JSON 객체 하나만 반환해: {\"reply\": \"실제 한국어 답변\", \"question\": \"실제 한국어 질문 또는 빈 문자열\"}. " +
              "JSON 예시의 타입 표기(string 등)를 그대로 출력하지 말고, 분석 과정·생각 과정·작성 메모도 출력하지 마. reply는 핵심 추천과 사용자 요구 반영을 1~2문장으로, question은 짧은 확인 질문 1문장으로 작성해. 전체 답변은 최대 2문장으로 끝내. " +
              CORE_GARMENT_POLICY + " " +
              "첫 문장에서 이번 사용자 요청에 바로 답해. '말씀하신 방향을 반영할게요', '상황에 맞게 추천할게요'로 끝내지 말고 어떤 옷을 어떻게 조합할지 말해. " +
              "예: 이동이 많아요 → '스니커즈와 여유 있는 팬츠로 맞추고, 벗어 들기 쉬운 얇은 겉옷을 더한 안도 추천해요.' 예: 흰 티에 검정 데님 자켓 추가 → '흰 티는 유지하고 검정 데님 재킷을 위에 더하는 조합을 추천해요.' " +
              "사용자가 여러 대안을 주고 판단을 맡기면 조건에 맞는 하나를 선택하고 이유를 한 번만 말해. 같은 요청을 더 구체적으로 다시 말하라고 요구하지 마. " +
              "이 답변은 아직 추천안이며 이미지나 상품을 이미 바꿨다고 말하지 마. '바꿨어요/추가했어요/검증했어요' 대신 '추천해요/맞출게요'를 사용해. 불확실성은 실제 필요한 항목에만 한 번 알리고, 일반적인 권유까지 '가능할 수 있습니다/고려해볼 수 있습니다'로 흐리지 마. " +
              "실제 코디 스타일리스트가 옆에서 말하듯 자연스럽고 따뜻한 존댓말을 사용해. 보고서, 시스템 안내, 프롬프트 설명, '컨텍스트', '후보 생성', '분석 결과' 같은 내부 용어는 사용하지 마. " +
              "출처, URL, 마크다운, 영어 항목명, 과장된 체형 판단, 장황한 수식어는 사용하지 마. " +
              "키·몸무게 숫자와 체형 평가를 불필요하게 반복하지 말고, 필요할 때는 비율과 핏의 장점으로만 표현해. 영어 표현이 섞이면 자연스러운 한국어로 바꿔. " +
              "입력의 장소명을 다른 도시나 서울 전체로 바꾸지 말고, 확실하지 않은 지역 정보는 단정하지 마. " +
              "사용자가 이번 답변에서 새로 말한 소재·색상·핏·기장·아이템만 짧게 인정하고 다음 후보에 어떻게 반영할지 말해. " +
              "날씨·상황과 충돌해도 사용자가 정한 아이템을 몰래 바꾸지 마. 요청을 유지하면서 겉옷을 벗어 들기 같은 구체적인 대응을 먼저 추천하고, 양립할 수 없는 필수 조건일 때만 한 번 질문해. 날씨가 미확인이라면 기온이나 강수를 만들어내지 마. " +
              "사용자가 두 방향 모두 보겠다고 하면 후보를 두 그룹으로 나누도록 명확히 기록해. " +
              "사용자가 이미 말한 날짜·장소·성별·키·몸무게·핏·소재를 다시 나열하지 마. 이번 단계의 이전 설명도 반복하지 마. 사용자가 '좋아'라고 하면 직전 제안을 승인한 것으로 이해하고 같은 설명을 반복하지 말고 다음 단계의 추천으로 넘어가. 사용자가 특정 조건을 말하지 않았다면 좋은 기본안을 먼저 제안하고, 결과를 크게 바꿀 때만 선택을 물어봐. 필요한 정보가 여러 개여도 이번에는 가장 중요한 하나만 물어봐. 현재 입력과 피드백으로 해당 단계가 이미 정해졌다면 question은 빈 문자열로 반환해. " +
              "material 단계에서 사용자의 답변이 핏이나 실루엣에 관한 내용이면 그 방향은 이미 확정된 것으로 처리하고 다시 설명하지 마. 소재·패턴·레이어링만 새로 제안해. " +
              "사용자가 '추천해줘' 또는 비슷한 표현으로 선택을 맡기면 질문으로 되돌리지 말고, 현재 단계에서 가장 적합한 방향과 그 이유를 먼저 제안해. 이때 추천한 소재·핏·레이어링은 이후 후보 생성에 반영할 수 있도록 구체적으로 말해.",
          },
          {
            role: "user",
            content:
              `사용자 요청:\n${keyword}\n\n` +
              `현재 상담 단계:\n${stageInstruction(stage)}\n\n` +
              `날씨·장소·트렌드 분석:\n${trend}\n\n` +
              `장소 컨텍스트:\n${placeContext || "입력 장소와 약속 종류를 중심으로 해석"}\n\n` +
              `사용자 요구사항 구조화 결과:\n${intent}\n\n` +
              `이미 확정된 사용자 피드백(반복 금지):\n${confirmedFeedback.length ? confirmedFeedback.map((item: string) => `- ${item}`).join("\n") : "- 없음"}\n\n` +
              `이번 사용자 답변:\n${latestFeedback}\n\n` +
              `이번 단계에서 우선 확인할 정보: ${missing}\n` +
              "이번 단계에서 새로 정해지는 스타일 방향만 자연스러운 한국어 대화로 짧게 답해. 사용자가 비워둔 조건이면 추천 하나와 이유 하나를 먼저 말하고, 정말 선택이 필요한 경우에만 질문을 마지막에 한 번 남겨. 이미 충분히 정해진 내용은 다시 묻지 마. 질문이 필요 없으면 question을 빈 문자열로 작성해.",
          },
        ],
      } as never,
      { signal: AbortSignal.timeout(25_000) },
    );
    const rawContent = response.choices[0]?.message?.content;
    const parsed = parseJsonObjectFromText(rawContent);
    const rawReply = sanitizeCoreText(cleanVisibleText(parsed.reply));
    const usedDirectReply = !rawReply || isGenericConsultationReply(rawReply);
    const reply = usedDirectReply ? buildDirectConsultationReply(fallbackInput) : rawReply;
    const question = delegated || usedDirectReply ? "" : sanitizeCoreText(cleanQuestion(parsed.question));
    const message = [reply, question].filter(Boolean).join(" ").trim();
    if (!message) throw new Error("상담 응답이 비어 있습니다.");
    agentLog("trend", `스타일 상담 Tool 완료: ${stage}`);
    return NextResponse.json({
      message,
      options: question ? optionsForStage(stage, keyword, trend) : [],
      allowQuickApply: !question,
      responseSource: usedDirectReply ? "local_recommendation" : "model",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "스타일 상담에 실패했습니다.";
    agentLog("trend", `스타일 상담 연결 지연: ${message}`, "consultation fallback");
    if (fallbackInput) {
      return NextResponse.json({
        message: buildDirectConsultationReply(fallbackInput),
        options: [],
        allowQuickApply: true,
        degraded: true,
        responseSource: "local_recommendation",
        notice: "상담 응답을 받지 못해 입력 조건으로 기본 조합을 제안합니다.",
      });
    }
    return NextResponse.json({ error: "상담 입력을 읽지 못했습니다." }, { status: 400 });
  }
}
