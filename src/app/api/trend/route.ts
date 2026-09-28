import { NextResponse } from "next/server";
import { agentLog } from "@/lib/log";
import { extractLocationHint } from "@/lib/location";
import { getNvidiaClient, NVIDIA_FAST_MODEL } from "@/lib/nvidia";
import { OPENAI_SERVICE_TIER, OPENAI_TREND_MODEL, openai } from "@/lib/openai";
import { getTodayInKorea, lookupOpenMeteoWeather } from "@/lib/weather";

function addDays(date: string, amount: number) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

const WEEKDAY_INDEX: Record<string, number> = {
  일: 0,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
};

function extractDateHint(keyword: string) {
  const today = getTodayInKorea();
  const absolute = keyword.match(/(20\d{2})[./년-]\s*(\d{1,2})[./월-]\s*(\d{1,2})일?/);
  if (absolute) {
    const [, year, month, day] = absolute;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const monthDay = keyword.match(/(\d{1,2})월\s*(\d{1,2})일?/);
  if (monthDay) {
    const [, month, day] = monthDay;
    const sameYear = `${today.slice(0, 4)}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return sameYear < today ? `${Number(today.slice(0, 4)) + 1}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : sameYear;
  }
  const slashDate = keyword.match(/(?:^|\s)(\d{1,2})[./](\d{1,2})(?:\s|$)/);
  if (slashDate) {
    const [, month, day] = slashDate;
    const sameYear = `${today.slice(0, 4)}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return sameYear < today ? `${Number(today.slice(0, 4)) + 1}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : sameYear;
  }
  const weeksLater = keyword.match(/(\d+)\s*주\s*(?:뒤|후)/);
  if (weeksLater) {
    const weeks = Number(weeksLater[1]);
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const nextSaturday = (6 - weekday + 7) % 7;
    return addDays(today, /주말/.test(keyword) ? nextSaturday + weeks * 7 : weeks * 7);
  }
  if (/다음\s*주(?:\s*말|\s*주말)/.test(keyword)) {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    return addDays(today, (6 - weekday + 7) % 7 + 7);
  }
  if (/이번\s*주(?:\s*말|\s*주말)/.test(keyword)) {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    return addDays(today, (6 - weekday + 7) % 7);
  }
  const weekdayMatch = keyword.match(/(이번\s*주|다음\s*주)?\s*(일|월|화|수|목|금|토)(?:요일)/);
  if (weekdayMatch) {
    const prefix = weekdayMatch[1] ?? "";
    const target = WEEKDAY_INDEX[weekdayMatch[2]];
    const current = new Date(`${today}T00:00:00Z`).getUTCDay();
    let distance = (target - current + 7) % 7;
    if (/다음/.test(prefix)) distance = distance === 0 ? 7 : distance + 7;
    return addDays(today, distance);
  }
  if (/모레/.test(keyword)) return addDays(today, 2);
  if (/내일/.test(keyword)) return addDays(today, 1);
  if (/오늘/.test(keyword)) return today;
  return undefined;
}

function seasonHint(date: string | undefined) {
  const month = date ? Number(date.slice(5, 7)) : Number(getTodayInKorea().slice(5, 7));
  if ([3, 4, 5].includes(month)) return "봄";
  if ([6, 7, 8].includes(month)) return "여름";
  if ([9, 10, 11].includes(month)) return "가을";
  return "겨울";
}

const PLACE_SIGNATURES: Array<{ pattern: RegExp; context: string }> = [
  { pattern: /을지로/, context: "서울 중구의 인쇄·제조 골목과 오래된 간판, 바와 LP 문화가 공존하는 레트로 도심 상권" },
  { pattern: /성수/, context: "공장 지대의 거친 질감과 브랜드 쇼룸·카페·편집숍이 섞인 현대적인 캐주얼 상권" },
  { pattern: /홍대|연남/, context: "음악·공연·서브컬처와 스트리트 숍이 밀집한 개성 강한 젊은 상권" },
  { pattern: /한남|이태원/, context: "갤러리·바·편집숍과 글로벌 문화가 섞인 세련된 야간·문화 상권" },
  { pattern: /청담|압구정|도산/, context: "럭셔리 부티크·살롱·레스토랑이 밀집한 정제된 패션 상권" },
  { pattern: /강남|삼성|잠실/, context: "오피스·쇼핑·대형 상업시설이 혼합된 정돈된 도심 생활권" },
  { pattern: /해운대|광안리|부산/, context: "해안 산책·관광·야간 식음 문화가 결합된 부산의 개방적인 도시·리조트 생활권" },
  { pattern: /제주|애월|서귀포/, context: "바람과 자연 풍경, 카페·여행 동선이 중심인 제주 로컬·리조트 생활권" },
  { pattern: /전주|경주|안동/, context: "역사 경관과 지역 문화, 보행 중심 여행 동선이 결합된 전통·현대 혼합 지역" },
];

function buildPlaceContext(location: string | undefined, keyword: string) {
  const label = location?.trim();
  if (!label) return "입력 장소: 미지정\n지역을 추정하지 않습니다. 사용자가 말한 약속 종류와 활동성만 스타일에 반영합니다.";
  const signature = PLACE_SIGNATURES.find((item) => item.pattern.test(label))?.context;
  if (signature) {
    return "입력 장소: " + label + "\n지역 분위기: " + signature + "\n스타일 적용: 장소명을 서울 전체로 뭉뚱그리지 말고, 이 생활권의 조도·보행량·상권 성격·문화적 인상을 착장의 무드, 소재, 디테일, 격식에 연결합니다.";
  }
  return "입력 장소: " + label + "\n지역 분위기: \"" + label + "\"이라는 사용자의 실제 목적지와 약속 종류(" + keyword + ")를 중심으로 생활권·상권·시간대의 분위기를 해석합니다. 좌표가 확인되지 않으면 날씨를 추정하지 않습니다.";
}

async function researchFashionContext(keyword: string, season: string, placeContext: string) {
  try {
    agentLog(
      "trend",
      "현재 시즌 패션 레퍼런스 웹 리서치 시작",
      "web_search_preview · " + OPENAI_TREND_MODEL + " · " + OPENAI_SERVICE_TIER,
    );
    const response = await openai.responses.create({
      model: OPENAI_TREND_MODEL,
      service_tier: OPENAI_SERVICE_TIER,
      tools: [{ type: "web_search_preview" }],
      input:
        "너는 패션 디렉터의 리서치 어시스턴트야. 오늘 날짜는 " + getTodayInKorea() + "이고 대상 시즌은 " + season + "이야.\n" +
        "사용자 요청: " + keyword + "\n장소 컨텍스트:\n" + placeContext + "\n\n" +
        "Vogue Korea/Vogue, GQ, i-D, Hypebeast, Highsnobiety, Seoul Fashion Week, 국내 편집숍·패션 플랫폼(무신사·29CM·W컨셉 등)의 최신 기사와 룩북을 웹검색해 현재 착장에 적용할 수 있는 레퍼런스를 요약해.\n" +
        "브랜드 상품을 그대로 복사하거나 존재하지 않는 상품을 만들지 말고, 실행 가능한 스타일 신호만 한국어로 정리해:\n" +
        "1. 이번 시즌의 실루엣·비율 2~3개\n2. 소재·표면감·패턴·색 조합 2~3개\n" +
        "3. 참고할 브랜드/편집숍/매거진의 미학을 이름이 아니라 스타일 언어로 2~3개\n" +
        "4. 사용자 요청의 장소·상황에 적용할 때 버릴 과장 요소와 남길 요소\n" +
        "각 항목은 짧고 구체적으로 쓰고, 근거가 없는 유행을 단정하지 마. 최대 900자, 출처명은 괄호로만 표시해.",
    }, { signal: AbortSignal.timeout(18_000) });
    const text = response.output_text?.trim();
    if (text) {
      agentLog("trend", "현재 시즌 패션 레퍼런스 웹 리서치 완료");
      return "[참조 신호만 사용 · 착장 복제 금지]\n" + text;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    agentLog("trend", "패션 웹 리서치 실패: " + message, "strict fashion reference");
    throw new Error(`현재 시즌 패션 레퍼런스를 확인하지 못했습니다. ${message}`);
  }
  throw new Error("현재 시즌 패션 레퍼런스가 비어 있습니다.");
}

async function researchPlaceContext(location: string | undefined, keyword: string, baseContext: string) {
  if (!location || PLACE_SIGNATURES.some((item) => item.pattern.test(location))) return baseContext;
  try {
    agentLog("trend", "입력 지역의 생활권·상권 분위기 웹 리서치 시작", "web_search_preview · " + OPENAI_TREND_MODEL);
    const response = await openai.responses.create({
      model: OPENAI_TREND_MODEL,
      service_tier: OPENAI_SERVICE_TIER,
      tools: [{ type: "web_search_preview" }],
      input:
        "대한민국의 장소 \"" + location + "\"을 정확한 사용자 목적지로 조사해. 사용자 요청은 \"" + keyword + "\"야.\n" +
        "공식 관광·지역 매체·신뢰할 만한 로컬 매거진과 최근 장소 소개를 검색해, 이 장소의 생활권·상권·거리 인상을 한국어 한 문장으로만 요약해.\n" +
        "확실하지 않은 내용은 단정하지 말고, 장소명을 서울이나 광역시 전체로 바꾸지 마. 패션에 적용할 수 있는 격식·활동성 단서를 같은 문장 안에 짧게 덧붙여. 사용자에게 표시될 수 있으므로 출처명, URL, 마크다운 링크, 괄호 인용은 답변에 포함하지 마.",
    }, { signal: AbortSignal.timeout(12_000) });
    const text = response.output_text?.trim();
    if (text) {
      agentLog("trend", "입력 지역의 생활권·상권 분위기 웹 리서치 완료");
      return "입력 장소: " + location + "\n지역 분위기: " + text + "\n스타일 적용: 이 지역의 실제 상권·거리·시간대 인상을 장소 무드로 사용하고, 날씨 좌표의 보완 지역과 혼동하지 않습니다.";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    agentLog("trend", "지역 분위기 리서치 실패: " + message, "strict place context");
    throw new Error(`입력 장소의 분위기를 확인하지 못했습니다. ${message}`);
  }
  throw new Error("입력 장소의 분위기 리서치 결과가 비어 있습니다.");
}

function formatWeatherContext(value: unknown) {
  if (!value || typeof value !== "object") return "날씨 데이터 없음; 계절감만 사용합니다.";
  const weather = value as Record<string, unknown>;
  const location = weather.location && typeof weather.location === "object"
    ? (weather.location as Record<string, unknown>)
    : {};
  const forecast = weather.forecast && typeof weather.forecast === "object"
    ? (weather.forecast as Record<string, unknown>)
    : {};
  const locationLabel = location.resolution === "parent_region"
    ? `${String(location.query ?? "요청 지역")} · ${String(location.name ?? "상위 지역")} 기준`
    : String(location.name ?? location.query ?? "미지정");
  const weatherCode = forecast.weatherCode == null ? NaN : Number(forecast.weatherCode);
  const weatherLabel = Number.isFinite(weatherCode)
    ? weatherCode === 0 ? "맑음"
      : weatherCode <= 3 ? "구름 많음"
        : weatherCode <= 48 ? "안개"
          : weatherCode <= 67 ? "비"
            : weatherCode <= 86 ? "눈"
              : "소나기·뇌우"
    : "미상";
  return [
    `날짜: ${String(weather.date ?? "미상")}`,
    `계절: ${String(weather.season ?? "미상")}`,
    `지역: ${locationLabel} (${location.resolved === false ? "좌표 미확인" : "좌표 확인"})`,
    `예보 가능: ${weather.forecastAvailable ? "예" : "아니오"}`,
    `하늘 상태: ${weatherLabel}`,
    `기온: 최고 ${String(forecast.temperatureMax ?? "미상")}°C / 최저 ${String(forecast.temperatureMin ?? "미상")}°C`,
    `강수량: ${String(forecast.precipitationMm ?? "미상")}mm · 바람: ${String(forecast.windSpeedMax ?? "미상")}m/s`,
    `판단: ${String(weather.guidance ?? "확인된 정보 범위에서 계절감만 반영합니다.")}`,
  ].join("\n");
}

export async function POST(req: Request) {
  try {
    const { keyword } = await req.json();
    const client = getNvidiaClient();
    const userKeyword = typeof keyword === "string" ? keyword : "";
    const weatherArgs = {
      location: extractLocationHint(userKeyword),
      date: extractDateHint(userKeyword),
    };
    const placeContext = buildPlaceContext(weatherArgs.location, userKeyword);

    agentLog(
      "trend",
      `"${userKeyword}" 로컬 입력 해석 및 날씨 Tool 호출 시작`,
      `Local parser · ${NVIDIA_FAST_MODEL} · Open-Meteo Tool`,
    );

    // Weather I/O and the weather-independent styling analysis start together.
    const weatherPromise = (async () => {
      agentLog(
        "weather",
        "Open-Meteo 조회: " + (weatherArgs.location || "장소 미지정 · 좌표 조회 생략") + " · " + (weatherArgs.date || "오늘"),
        "Open-Meteo Geocoding + Forecast",
      );
      return lookupOpenMeteoWeather(weatherArgs);
    })();
    const fashionPromise = researchFashionContext(
      userKeyword,
      seasonHint(weatherArgs.date),
      placeContext,
    );
    const placeResearchPromise = researchPlaceContext(weatherArgs.location, userKeyword, placeContext);
    const trendPromise = client.chat.completions.create({
      model: NVIDIA_FAST_MODEL,
      messages: [
        {
          role: "system",
          content: "너는 한국어로 답하는 빠른 퍼스널 스타일링 컨텍스트 분석 Tool이야. 실제 기온·강수 수치를 추정하지 말고 날짜·장소·상황·성별·체형·트렌드만 짧고 구체적으로 분석해. 사용자가 입력한 동네·상권 이름을 서울 전체나 다른 지역으로 바꾸지 마.",
        },
        {
          role: "user",
          content:
            "사용자 요청:\n" + userKeyword + "\n\n" +
            "오늘의 한국 날짜: " + getTodayInKorea() + "\n\n" +
            "장소 컨텍스트:\n" + placeContext + "\n\n" +
            "한국어로 다음 항목을 짧고 구체적으로 작성해:\n" +
            "1. 입력 해석: 날짜, 계절/시기, 지역, 성별, 키, 몸무게, 약속/상황, 추가 요구사항\n" +
            "2. 장소와 약속 종류의 무드 및 포멀리티\n" +
            "3. 현재 패션 트렌드를 반영한 스타일 방향\n" +
            "4. 체형과 무드에 맞는 핏 방향\n" +
            "5. 착장 후보 생성 시 피해야 할 구체적인 실패 가능성\n\n" +
            "성별이 없으면 남성 코디로 분석해. 장소는 입력 명칭을 보존하고, 좌표가 날씨용으로만 보완된 경우에도 장소의 상권·문화·시간대 무드를 별도로 설명해.",
        },
      ],
      temperature: 0.35,
      max_tokens: 1000,
      chat_template_kwargs: { enable_thinking: false },
    } as never, { signal: AbortSignal.timeout(45_000) }).then((response) => {
      const value = response.choices[0]?.message?.content?.trim() ?? "";
      if (!value) throw new Error("빠른 컨텍스트 분석 응답이 비어 있습니다.");
      return value;
    });

    const [weather, trendBase, fashionReference, refinedPlaceContext] = await Promise.all([
      weatherPromise,
      trendPromise,
      fashionPromise,
      placeResearchPromise,
    ]);
    const trend = trendBase + "\n\n[장소 컨텍스트]\n" + refinedPlaceContext + "\n\n[현재 시즌 패션 레퍼런스]\n" + fashionReference + "\n\n[Open-Meteo 날씨 Tool 결과]\n" + formatWeatherContext(weather);

    agentLog("trend", "NVIDIA·패션 리서치 분석 완료 (" + trend.length + "자)");
    return NextResponse.json({ trend, weather, placeContext: refinedPlaceContext, fashionReference });
  } catch (e) {
    const message = e instanceof Error ? e.message : "트렌드 조사 중 알 수 없는 오류";
    agentLog("trend", "✗ 요청 실패: " + message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
