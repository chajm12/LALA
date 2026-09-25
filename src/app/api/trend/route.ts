import { NextResponse } from "next/server";
import { chat, chatJson, JUDGE_MODEL, PLANNER_MODEL } from "@/lib/nim";
import { getWeather, type WeatherReport } from "@/lib/tools/weather";
import { catalogSummary } from "@/lib/tools/catalog";
import { agentLog, fallbackLogger, type TraceEvent } from "@/lib/log";
import type { ParsedRequest } from "@/lib/styling";

/**
 * 1단계: 입력 해석(JUDGE, 빠른 모델) → 날씨 도구 호출(Open-Meteo) → 스타일 방향 종합(PLANNER)
 * 모델 두 종 + 외부 도구 한 개. 프론트 계약(trend: string)은 유지하고 parsed/weather/trace 를 추가로 돌려준다.
 */

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

async function parseRequest(keyword: string, trace: TraceEvent[]): Promise<ParsedRequest> {
  const today = new Date().toISOString().slice(0, 10);
  agentLog("trend", "자연어 입력에서 날짜·장소·상황·체형 추출", `chat.completions · ${JUDGE_MODEL}`, trace);
  const raw = await chatJson<Partial<ParsedRequest> & { date?: string }>(JUDGE_MODEL, [
    {
      role: "system",
      content: `너는 스타일링 요청을 구조화하는 파서다. 오늘은 ${today} 이다. JSON 만 출력한다.`,
    },
    {
      role: "user",
      content: `요청: "${keyword}"

다음 JSON 으로 답해:
{
  "date": "yyyy-mm-dd (연도가 없으면 오늘 이후 가장 가까운 해당 날짜, 날짜 언급이 전혀 없으면 null)",
  "place": "장소명 (지오코딩 가능한 형태, 예: '성수동', '삼성역', '부산 해운대'; 없으면 '서울')",
  "occasion": "상황/약속 (예: 카페 데이트, 결혼식 하객, 면접)",
  "gender": "남성|여성 (언급 없으면 남성)",
  "heightCm": number|null,
  "weightKg": number|null,
  "constraints": ["추가 요구/제약 (예: 베이지 피하기, 너무 포멀하지 않게)"],
  "focusCategories": ["사용자가 특별히 추천을 요구한 품목 카테고리 (예: 신발)"]
}`,
    },
  ], { temperature: 0.1, maxTokens: 800, label: "입력 해석", onFallback: fallbackLogger("trend", trace) });

  const date = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : nextSaturday();
  return {
    date,
    dateInferred: !(typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)),
    place: String(raw.place || "서울"),
    occasion: String(raw.occasion || "일상 외출"),
    gender: raw.gender === "여성" ? "여성" : "남성",
    heightCm: typeof raw.heightCm === "number" ? raw.heightCm : null,
    weightKg: typeof raw.weightKg === "number" ? raw.weightKg : null,
    constraints: Array.isArray(raw.constraints) ? raw.constraints.map(String) : [],
    focusCategories: Array.isArray(raw.focusCategories) ? raw.focusCategories.map(String) : [],
  };
}

export async function POST(req: Request) {
  const trace: TraceEvent[] = [];
  try {
    const { keyword } = await req.json();

    const parsed = await parseRequest(keyword, trace);
    agentLog("trend", `해석 결과: ${parsed.date}${parsed.dateInferred ? "(추정)" : ""} · ${parsed.place} · ${parsed.occasion} · ${parsed.gender}`, undefined, trace);

    agentLog("weather", `Open-Meteo 로 ${parsed.place} ${parsed.date} 날씨 조회`, "tool:get_weather", trace);
    let weather: WeatherReport | null = null;
    try {
      weather = await getWeather(parsed.place, parsed.date);
      agentLog("weather", weather.summary, undefined, trace);
    } catch (e) {
      agentLog("weather", `✗ 날씨 조회 실패, 계절감으로 대체: ${e instanceof Error ? e.message : e}`, undefined, trace);
    }

    let catalog = "";
    try {
      const s = catalogSummary();
      catalog = `카탈로그 ${s.total}개 상품, 카테고리 분포: ${JSON.stringify(s.byCategory)}`;
      agentLog("catalog", `카탈로그 ${s.total}개 상품 로드 (${Object.entries(s.byCategory).map(([k, v]) => `${k} ${v}`).join(" · ")})`, "tool:catalog_summary", trace);
    } catch {
      agentLog("catalog", "카탈로그 인덱스 없음 (상품 검색 단계 생략됨)", undefined, trace);
    }

    agentLog("trend", "날씨·상황·체형을 종합해 스타일 방향 작성", `chat.completions · ${PLANNER_MODEL}`, trace);
    const trend = await chat(PLANNER_MODEL, [
      {
        role: "system",
        content: "너는 패션 MD 겸 스타일리스트다. 근거 없는 트렌드 단정은 피하고, 주어진 날씨 수치와 상황을 최우선 근거로 삼는다. 한국어로 답한다.",
      },
      {
        role: "user",
        content: `사용자 요청: "${keyword}"
구조화된 해석: ${JSON.stringify(parsed)}
날씨 도구 결과: ${weather ? JSON.stringify(weather) : "조회 실패 — 날짜의 계절감으로 판단"}
${catalog}

아래 두 섹션으로 정리해줘. 각 섹션은 6~10줄, 문장으로.

[날씨·장소 기반 분석]
- 기온/강수/습도 수치를 근거로 원단·실루엣·레이어링 방향
- 착장 후보 생성 시 날씨 관련 실패 가능성 (예: 강수확률 높은데 스웨이드, 기온 낮은데 얇은 원단)

[스타일·트렌드 분석]
- 상황(${parsed.occasion})의 포멀리티와 장소(${parsed.place}) 무드에 맞는 핵심 스타일 키워드 3~5개
- 체형(${parsed.heightCm ?? "?"}cm/${parsed.weightKg ?? "?"}kg)에 맞는 핏 방향
- 사용자 제약(${parsed.constraints.join(", ") || "없음"})을 지키기 위한 주의점
- 상황과 안 맞는 실패 가능성 (예: 결혼식에 캐주얼)`,
      },
    ], { temperature: 0.5, maxTokens: 2000, label: "스타일 분석", onFallback: fallbackLogger("trend", trace) });

    agentLog("trend", `분석 완료 (${trend.length}자)`, undefined, trace);
    return NextResponse.json({ trend, parsed, weather, trace });
  } catch (e) {
    const message = e instanceof Error ? e.message : "트렌드 조사 중 알 수 없는 오류";
    agentLog("trend", `✗ 요청 실패: ${message}`, undefined, trace);
    return NextResponse.json({ error: message, trace }, { status: 500 });
  }
}
