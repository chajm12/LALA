const SEOUL_DEFAULT = "Seoul, South Korea";
const WEATHER_TIMEOUT_MS = 8_000;

type WeatherLookupArgs = {
  location?: string;
  date?: string;
};

export function getTodayInKorea() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeDate(value: unknown) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return getTodayInKorea();
}

function seasonForDate(date: string) {
  const month = Number(date.slice(5, 7));
  if ([3, 4, 5].includes(month)) return "봄";
  if ([6, 7, 8].includes(month)) return "여름";
  if ([9, 10, 11].includes(month)) return "가을";
  return "겨울";
}

function dateDistanceFromToday(date: string) {
  const target = Date.parse(`${date}T00:00:00Z`);
  const today = Date.parse(`${getTodayInKorea()}T00:00:00Z`);
  return Math.round((target - today) / 86_400_000);
}

function locationCandidates(raw: string) {
  const normalized = raw.trim() || SEOUL_DEFAULT;
  const simplified = normalized
    .replace(/(카페|식당|결혼식장|회의실|공원|해변|역)\s*$/g, "")
    .trim();
  const koreanSeoulContext = /[가-힣]/.test(simplified) && !/대한민국|한국|서울/.test(simplified)
    ? [`${simplified}, Seoul, South Korea`, `${simplified}, South Korea`]
    : [];
  return [...new Set([normalized, ...koreanSeoulContext, simplified].filter(Boolean))];
}

async function geocode(location: string) {
  for (const candidate of locationCandidates(location)) {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", candidate);
    url.searchParams.set("count", "10");
    url.searchParams.set("language", "ko");
    url.searchParams.set("format", "json");

    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS),
      });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    const data = (await response.json()) as {
      results?: Array<{
        name?: string;
        country?: string;
        admin1?: string;
        latitude?: number;
        longitude?: number;
        timezone?: string;
      }>;
    };
    const result = data.results?.find((item) => item.country === "대한민국") ?? data.results?.[0];
    if (result?.latitude !== undefined && result.longitude !== undefined) {
      return {
        query: candidate,
        name: result.name ?? candidate,
        country: result.country ?? "",
        region: result.admin1 ?? "",
        latitude: result.latitude,
        longitude: result.longitude,
        timezone: result.timezone ?? "auto",
      };
    }
  }

  return null;
}

export async function lookupOpenMeteoWeather(args: WeatherLookupArgs) {
  const date = normalizeDate(args.date);
  const requestedLocation = args.location?.trim() || SEOUL_DEFAULT;
  const directLocation = await geocode(requestedLocation);
  const useKoreanParentRegion = Boolean(args.location && /[가-힣]/.test(args.location));
  const parentRegion = !directLocation && useKoreanParentRegion
    ? await geocode(SEOUL_DEFAULT)
    : null;
  const location = directLocation ?? parentRegion;
  const daysFromToday = dateDistanceFromToday(date);
  const season = seasonForDate(date);

  if (!location) {
    return {
      source: "Open-Meteo Geocoding",
      date,
      season,
      location: {
        query: requestedLocation,
        resolved: false,
      },
      forecastAvailable: false,
      guidance: `장소 좌표를 Open-Meteo Geocoding으로 확인하지 못해 ${season} 계절감만 반영합니다.`,
    };
  }

  if (daysFromToday < 0 || daysFromToday > 16) {
    return {
      source: "Open-Meteo Geocoding",
      date,
      season,
      location: directLocation
        ? location
        : { ...location, query: requestedLocation, resolution: "parent_region" },
      forecastAvailable: false,
      guidance: `${date}는 단기 예보 범위를 벗어나므로 ${season} 계절감과 지역 기후만 반영합니다.`,
    };
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max",
  );
  url.searchParams.set("timezone", location.timezone || "auto");
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);

  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS),
    });
  } catch {
    return {
      source: "Open-Meteo Geocoding",
      date,
      season,
      location,
      forecastAvailable: false,
      guidance: `${date}의 날씨 요청이 지연되어 ${season} 계절감만 반영합니다.`,
    };
  }
  if (!response.ok) {
    return {
      source: "Open-Meteo Geocoding",
      date,
      season,
      location,
      forecastAvailable: false,
      guidance: `${date}의 단기 예보를 가져오지 못해 ${season} 계절감을 중심으로 반영합니다.`,
    };
  }

  const data = (await response.json()) as {
    daily?: {
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_sum?: number[];
      weather_code?: number[];
      wind_speed_10m_max?: number[];
    };
  };
  const daily = data.daily;
  const forecast = {
    temperatureMax: daily?.temperature_2m_max?.[0] ?? null,
    temperatureMin: daily?.temperature_2m_min?.[0] ?? null,
    precipitationMm: daily?.precipitation_sum?.[0] ?? null,
    weatherCode: daily?.weather_code?.[0] ?? null,
    windSpeedMax: daily?.wind_speed_10m_max?.[0] ?? null,
  };

  return {
    source: "Open-Meteo Forecast + Geocoding",
    date,
    season,
    location: directLocation
      ? location
      : { ...location, query: requestedLocation, resolution: "parent_region" },
    forecastAvailable: true,
    forecast,
    guidance: directLocation
      ? `${date}의 실제 단기 예보와 ${season} 계절감을 함께 반영합니다.`
      : `${requestedLocation}의 세부 좌표를 찾지 못해 Open-Meteo의 서울 기준 날씨와 ${season} 계절감을 반영합니다.`,
  };
}
