import { conceptSimilarity } from "@/lib/similarity";

export type VerifierConcept = {
  id: string;
  colorPalette: string[];
  materials: string[];
  outfitItems: string[];
  mood: string;
  fitStrategy: string;
};

export type WeatherSnapshot = {
  season?: string;
  forecastAvailable?: boolean;
  forecast?: {
    temperatureMax?: number | null;
    temperatureMin?: number | null;
    precipitationMm?: number | null;
    weatherCode?: number | null;
    windSpeedMax?: number | null;
  };
};

export type VerifierResult = {
  score: number;
  issues: string[];
  evidence: string[];
};

export type ObjectiveScores = {
  weather: VerifierResult;
  color: VerifierResult;
  diversity: VerifierResult;
};

const COLOR_FAMILIES: Array<[string, RegExp]> = [
  ["black", /블랙|검정|검은|차콜|black|charcoal/i],
  ["white", /화이트|흰색|아이보리|크림|white|ivory|cream/i],
  ["gray", /그레이|회색|grey|gray/i],
  ["navy", /네이비|navy/i],
  ["blue", /블루|파랑|청색|blue|denim|데님/i],
  ["brown", /브라운|갈색|카멜|토프|brown|camel|taupe/i],
  ["beige", /베이지|샌드|beige|sand/i],
  ["green", /그린|초록|카키|올리브|green|olive|khaki/i],
  ["red", /레드|빨강|버건디|와인|red|burgundy|wine/i],
  ["pink", /핑크|분홍|pink/i],
  ["yellow", /옐로|노랑|머스타드|yellow|mustard/i],
  ["purple", /퍼플|보라|purple/i],
];

const NEUTRAL_COLORS = new Set(["black", "white", "gray", "navy", "brown", "beige"]);

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function outfitText(concept: VerifierConcept) {
  return [...concept.colorPalette, ...concept.materials, ...concept.outfitItems].join(" ");
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function colorFamilies(concept: VerifierConcept) {
  const text = outfitText(concept);
  return new Set(
    COLOR_FAMILIES.filter(([, pattern]) => pattern.test(text)).map(([family]) => family),
  );
}

export function scoreWeatherFit(
  concept: VerifierConcept,
  weather: WeatherSnapshot | null,
): VerifierResult {
  const text = outfitText(concept);
  const forecast = weather?.forecast;
  const max = typeof forecast?.temperatureMax === "number" ? forecast.temperatureMax : null;
  const min = typeof forecast?.temperatureMin === "number" ? forecast.temperatureMin : null;
  const average = max !== null && min !== null ? (max + min) / 2 : null;
  const precipitation = typeof forecast?.precipitationMm === "number" ? forecast.precipitationMm : 0;
  const wind = typeof forecast?.windSpeedMax === "number" ? forecast.windSpeedMax : 0;
  const season = weather?.season ?? "";
  const issues: string[] = [];
  const evidence: string[] = [];
  let score = 88;

  const warmLayer = hasAny(text, [/패딩|다운|코트|울|니트|플리스|보온|두꺼운|padding|down|coat|wool|knit|fleece/i]);
  const lightLayer = hasAny(text, [/재킷|자켓|블레이저|가디건|셔츠|후드|바람막이|jacket|blazer|cardigan|shirt|hoodie|windbreaker/i]);
  const coolItem = hasAny(text, [/반팔|반바지|민소매|샌들|린넨|t-shirt|shorts|sleeveless|sandals|linen/i]);
  const rainReady = hasAny(text, [/방수|레인|고어텍스|우산|방풍|waterproof|rain|gore-tex|umbrella|windproof/i]);

  if (average !== null) {
    evidence.push(`예상 평균기온 ${average.toFixed(1)}°C`);
    if (average <= 8 && !warmLayer) {
      score -= 30;
      issues.push("평균기온이 낮은데 코트·패딩·니트 같은 보온 레이어가 부족해요.");
    }
    if (average >= 24 && warmLayer && !coolItem) {
      score -= 24;
      issues.push("따뜻한 날씨에 두꺼운 보온 소재가 중심이라 더울 수 있어요.");
    }
    if (average >= 18 && average < 24 && !warmLayer && !lightLayer) {
      score -= 10;
      issues.push("아침·저녁 기온 변화에 대응할 가벼운 레이어가 부족해요.");
    }
  } else if (season === "겨울" && !warmLayer) {
    score -= 25;
    issues.push("겨울 계절감에 비해 보온 레이어가 부족해요.");
  } else if (season === "여름" && warmLayer && !coolItem) {
    score -= 18;
    issues.push("여름 계절감에 비해 소재와 레이어가 무거워요.");
  }

  if (precipitation >= 2) {
    evidence.push(`예상 강수량 ${precipitation.toFixed(1)}mm`);
    if (!rainReady) {
      score -= 24;
      issues.push("비 예보가 있는데 방수 아우터나 젖어도 관리하기 쉬운 신발이 없어요.");
    }
  }
  if (wind >= 8) {
    evidence.push(`최대풍속 ${wind.toFixed(1)}m/s`);
    if (!rainReady && !lightLayer) {
      score -= 12;
      issues.push("바람이 강한 날씨에 바람을 막을 레이어가 부족해요.");
    }
  }

  if (!issues.length) evidence.push("기온·강수·바람에 대한 큰 충돌이 없어요.");
  return { score: clampScore(score), issues, evidence };
}

export function scoreColorHarmony(concept: VerifierConcept): VerifierResult {
  const families = colorFamilies(concept);
  const saturated = [...families].filter((family) => !NEUTRAL_COLORS.has(family));
  const issues: string[] = [];
  const evidence = [`식별된 색상군 ${families.size}개`];
  let score = 90;

  if (families.size === 0) {
    score = 68;
    issues.push("색상 정보가 부족해 조합 안정성을 충분히 검증하기 어려워요.");
  } else if (families.size > 4) {
    score -= 22;
    issues.push("한 착장에 색상군이 너무 많아 핵심 색감이 흐려질 수 있어요.");
  }
  if (saturated.length >= 3) {
    score -= 18;
    issues.push("강한 색상이 세 가지 이상 겹쳐 색감의 우선순위가 불분명해요.");
  }
  if (families.has("red") && families.has("green") && families.size <= 3) {
    score -= 12;
    issues.push("레드와 그린의 대비가 커서 상황에 따라 크리스마스 계열로 보일 수 있어요.");
  }
  if (families.size <= 3 && saturated.length <= 1) {
    score += 4;
    evidence.push("중성색 중심에 포인트 색상이 제한적으로 배치됐어요.");
  }

  return { score: clampScore(score), issues, evidence };
}

export function scoreDiversity(concepts: VerifierConcept[]): Map<string, VerifierResult> {
  return new Map(
    concepts.map((concept, index) => {
      const others = concepts.filter((_, otherIndex) => otherIndex !== index);
      const similarities = others.map((other) => conceptSimilarity(concept, other));
      const average = similarities.length
        ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length
        : 0;
      const nearest = similarities.length ? Math.max(...similarities) : 0;
      const issues = nearest >= 0.6
        ? ["다른 후보와 아우터·색감·무드 조합이 너무 비슷해 선택 폭이 좁아요."]
        : average >= 0.35
          ? ["후보 평균 유사도가 높아 한 가지 스타일로 보일 수 있어요."]
          : [];
      return [concept.id, {
        score: clampScore((1 - average) * 100),
        issues,
        evidence: [`다른 후보와의 평균 유사도 ${(average * 100).toFixed(0)}%`, `최고 유사도 ${(nearest * 100).toFixed(0)}%`],
      }];
    }),
  );
}

export function runObjectiveVerifiers(
  concepts: VerifierConcept[],
  weather: WeatherSnapshot | null,
): Map<string, ObjectiveScores> {
  const diversity = scoreDiversity(concepts);
  return new Map(
    concepts.map((concept) => [concept.id, {
      weather: scoreWeatherFit(concept, weather),
      color: scoreColorHarmony(concept),
      diversity: diversity.get(concept.id) ?? { score: 70, issues: [], evidence: [] },
    }]),
  );
}
