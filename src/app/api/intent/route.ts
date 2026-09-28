import { NextResponse } from "next/server";
import { agentLog } from "@/lib/log";
import { getNvidiaClient, NVIDIA_FAST_MODEL } from "@/lib/nvidia";
import { parseJsonObjectFromText } from "@/lib/openai";

type UserIntent = {
  occasion: string;
  location: string;
  venue: string;
  date: string;
  gender: string;
  heightCm: number | null;
  weightKg: number | null;
  mustHave: string[];
  avoid: string[];
  styleDirection: string[];
  fitDirection: string[];
  materialDirection: string[];
  unknowns: string[];
  summary: string;
  confidence: "높음" | "중간" | "낮음";
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function deriveInputDefaults(keyword: string): UserIntent {
  const profile = keyword.match(/(\d{3})\s*(?:cm|센티|키)?[,\s]+(\d{2,3})\s*(?:kg|킬로|몸무게)/i);
  const gender = /여성|여자|woman|female/i.test(keyword) ? "여성" : "남성";
  const venueMatch = keyword.match(/([가-힣A-Za-z0-9]+)\s*(카페|바|식당|공원|호텔|결혼식장|웨딩홀|공연장|방탈출)/i);
  const locationMatch = keyword.match(/[가-힣A-Za-z0-9]+(?:특별시|광역시|자치시|도|시|군|구|동|읍|면|역)/);
  const avoid = [...keyword.matchAll(/[^,.\n]*(?:싫어|피하고|피해|원하지|말고|제외|금지)[^,.\n]*/gi)]
    .map((match) => match[0].trim())
    .filter(Boolean)
    .slice(0, 5);
  const styleDirection = [...new Set(keyword.match(/캐주얼|포멀|세미포멀|스트릿|시티보이|미니멀|빈티지|고프코어|워크웨어|스마트캐주얼|편안|세련|단정|개성/g) ?? [])];
  const fitDirection = [...new Set(keyword.match(/오버핏|세미오버|릴랙스|슬림|와이드|스트레이트|테이퍼드|크롭|롱기장|짧은|긴/g) ?? [])];
  const materialDirection = [...new Set(keyword.match(/데님|면|코튼|리넨|린넨|울|니트|가죽|레더|나일론|메시|새틴|벨벳|체크|스트라이프/g) ?? [])];
  const mustHave = [...new Set([...materialDirection, ...styleDirection, ...fitDirection])].slice(0, 8);
  const unknowns = [
    !/결혼|장례|회의|면접|데이트|여행|카페|공연|식당|바|출근|약속|친구/.test(keyword) ? "약속의 성격" : "",
    !/실내|실외|이동|걷|차|대중교통/.test(keyword) ? "실내외 이동량" : "",
  ].filter(Boolean);
  return {
    occasion: (keyword.match(/결혼|장례|회의|면접|데이트|여행|출근|약속|친구|공연|식사|모임/) ?? [""])[0],
    location: locationMatch?.[0] ?? "",
    venue: venueMatch ? `${venueMatch[1]} ${venueMatch[2]}` : "",
    date: (keyword.match(/오늘|내일|모레|이번\s*주말|다음\s*주말|\d{1,2}월\s*\d{1,2}일|\d{1,2}[./]\d{1,2}/) ?? [""])[0],
    gender,
    heightCm: profile ? Number(profile[1]) : null,
    weightKg: profile ? Number(profile[2]) : null,
    mustHave,
    avoid,
    styleDirection,
    fitDirection,
    materialDirection,
    unknowns,
    summary: `${gender} 코디로 ${occasionText(keyword)}을 준비합니다. ${mustHave.length ? `직접 언급한 ${mustHave.join(", ")}을 우선 반영합니다.` : "추가 조건은 상담에서 확인합니다."}`,
    confidence: locationMatch && (keyword.match(/결혼|장례|회의|면접|데이트|여행|출근|약속|친구|공연|식사|모임/) ?? []).length ? "중간" : "낮음",
  };
}

function occasionText(keyword: string) {
  return (keyword.match(/결혼|장례|회의|면접|데이트|여행|출근|약속|친구|공연|식사|모임/) ?? ["일정"])[0];
}

function normalizeIntent(value: unknown, keyword: string): UserIntent {
  const inputDefaults = deriveInputDefaults(keyword);
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const confidence = ["높음", "중간", "낮음"].includes(text(item.confidence))
    ? text(item.confidence) as UserIntent["confidence"]
    : inputDefaults.confidence;
  return {
    occasion: text(item.occasion) || inputDefaults.occasion,
    location: text(item.location) || inputDefaults.location,
    venue: text(item.venue) || inputDefaults.venue,
    date: text(item.date) || inputDefaults.date,
    gender: text(item.gender) || inputDefaults.gender,
    heightCm: numberOrNull(item.heightCm) ?? inputDefaults.heightCm,
    weightKg: numberOrNull(item.weightKg) ?? inputDefaults.weightKg,
    mustHave: list(item.mustHave).length ? list(item.mustHave) : inputDefaults.mustHave,
    avoid: list(item.avoid).length ? list(item.avoid) : inputDefaults.avoid,
    styleDirection: list(item.styleDirection).length ? list(item.styleDirection) : inputDefaults.styleDirection,
    fitDirection: list(item.fitDirection).length ? list(item.fitDirection) : inputDefaults.fitDirection,
    materialDirection: list(item.materialDirection).length ? list(item.materialDirection) : inputDefaults.materialDirection,
    unknowns: list(item.unknowns).length ? list(item.unknowns) : inputDefaults.unknowns,
    summary: text(item.summary) || inputDefaults.summary,
    confidence,
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const keyword = text(body.keyword);
    if (!keyword) return NextResponse.json({ error: "사용자 요청이 필요합니다." }, { status: 400 });

    agentLog("intent", "사용자 요구사항 추출 Agent 시작", `NVIDIA NIM · ${NVIDIA_FAST_MODEL}`);
    try {
      const response = await getNvidiaClient().chat.completions.create(
        {
          model: NVIDIA_FAST_MODEL,
          temperature: 0.1,
          max_tokens: 900,
          chat_template_kwargs: { enable_thinking: false },
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "너는 패션 추천 시스템의 사용자 요구사항 추출 Agent야. 모든 값은 한국어 JSON으로 작성해. " +
                "사용자 입력을 해석하되 입력에 없는 내용을 사실처럼 만들지 마. 명시적 요구와 추정된 방향을 구분하고, 사용자가 직접 말한 소재·색·아이템·핏은 mustHave에 우선 기록해. " +
                "질문이 필요한 정보는 unknowns에 최대 2개만 기록해. 성별이 없으면 남성으로 기록해. " +
                "반드시 occasion, location, venue, date, gender, heightCm, weightKg, mustHave, avoid, styleDirection, fitDirection, materialDirection, unknowns, summary, confidence 필드를 포함해.",
            },
            { role: "user", content: `사용자 원문:\n${keyword}` },
          ],
        } as never,
        { signal: AbortSignal.timeout(45_000) },
      );
      const intent = normalizeIntent(parseJsonObjectFromText(response.choices[0]?.message?.content), keyword);
      agentLog("intent", "사용자 요구사항 추출 Agent 완료");
      return NextResponse.json({ intent, source: "NVIDIA NIM intent agent" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류";
      agentLog("intent", `요구사항 추출 실패: ${message}`, "strict intent agent");
      return NextResponse.json(
        { error: `사용자 요구사항을 정확히 해석하지 못했습니다. ${message}` },
        { status: 503 },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "사용자 요구사항 해석에 실패했습니다.";
    agentLog("intent", `✗ 요구사항 추출 실패: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
