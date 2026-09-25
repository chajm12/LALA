/**
 * 날씨 도구 — Open-Meteo (무료, 키 불필요).
 * 1) 지오코딩으로 장소 → 위경도
 * 2) 16일 이내면 예보, 그 밖이면 작년 같은 날짜 ±3일 실측(기후 근사)
 */
export type WeatherReport = {
  place: string;
  resolvedPlace: string;
  date: string;
  source: "forecast" | "climatology";
  tempMaxC: number | null;
  tempMinC: number | null;
  precipitationMm: number | null;
  precipitationProbability: number | null;
  humidity: number | null;
  windMaxKmh: number | null;
  summary: string;
};

type GeoResult = { name: string; latitude: number; longitude: number; admin1?: string; country?: string };

async function geocode(place: string): Promise<GeoResult | null> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", place);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "ko");
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as { results?: GeoResult[] };
  return json.results?.[0] ?? null;
}

function avg(values: (number | null | undefined)[]) {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function daysBetween(a: Date, b: Date) {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function toIsoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function getWeather(place: string, isoDate: string): Promise<WeatherReport> {
  // 서울 지명은 "성수동 서울" 처럼 상위 지역을 덧붙이면 지오코딩 성공률이 올라간다.
  const geo =
    (await geocode(place)) ??
    (await geocode(`${place} 서울`)) ??
    (await geocode("Seoul"));
  if (!geo) throw new Error(`장소를 찾지 못했어요: ${place}`);

  const resolvedPlace = [geo.name, geo.admin1, geo.country].filter(Boolean).join(", ");
  const target = new Date(`${isoDate}T00:00:00Z`);
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const delta = daysBetween(today, target);

  const daily = "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,relative_humidity_2m_mean,wind_speed_10m_max";

  if (delta >= 0 && delta <= 15) {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(geo.latitude));
    url.searchParams.set("longitude", String(geo.longitude));
    url.searchParams.set("daily", daily);
    url.searchParams.set("timezone", "Asia/Seoul");
    url.searchParams.set("start_date", isoDate);
    url.searchParams.set("end_date", isoDate);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`예보 조회 실패 (${res.status})`);
    const json = (await res.json()) as { daily: Record<string, (number | null)[]> };
    const d = json.daily;
    const report: WeatherReport = {
      place,
      resolvedPlace,
      date: isoDate,
      source: "forecast",
      tempMaxC: d.temperature_2m_max?.[0] ?? null,
      tempMinC: d.temperature_2m_min?.[0] ?? null,
      precipitationMm: d.precipitation_sum?.[0] ?? null,
      precipitationProbability: d.precipitation_probability_max?.[0] ?? null,
      humidity: d.relative_humidity_2m_mean?.[0] ?? null,
      windMaxKmh: d.wind_speed_10m_max?.[0] ?? null,
      summary: "",
    };
    report.summary = describe(report);
    return report;
  }

  // 예보 범위 밖: 작년 같은 날짜 ±3일 실측 평균 (기후 근사)
  const lastYear = new Date(target);
  lastYear.setUTCFullYear(target.getUTCFullYear() - 1);
  const start = new Date(lastYear); start.setUTCDate(start.getUTCDate() - 3);
  const end = new Date(lastYear); end.setUTCDate(end.getUTCDate() + 3);
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude", String(geo.latitude));
  url.searchParams.set("longitude", String(geo.longitude));
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_mean,wind_speed_10m_max");
  url.searchParams.set("timezone", "Asia/Seoul");
  url.searchParams.set("start_date", toIsoDate(start));
  url.searchParams.set("end_date", toIsoDate(end));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`기후 조회 실패 (${res.status})`);
  const json = (await res.json()) as { daily: Record<string, (number | null)[]> };
  const d = json.daily;
  const precip = avg(d.precipitation_sum);
  const report: WeatherReport = {
    place,
    resolvedPlace,
    date: isoDate,
    source: "climatology",
    tempMaxC: avg(d.temperature_2m_max),
    tempMinC: avg(d.temperature_2m_min),
    precipitationMm: precip,
    precipitationProbability: precip === null ? null : Math.min(100, Math.round(precip * 12)),
    humidity: avg(d.relative_humidity_2m_mean),
    windMaxKmh: avg(d.wind_speed_10m_max),
    summary: "",
  };
  report.summary = describe(report);
  return report;
}

function describe(r: WeatherReport) {
  const parts: string[] = [];
  parts.push(`${r.resolvedPlace} ${r.date} (${r.source === "forecast" ? "예보" : "작년 동기 실측 기반 추정"})`);
  if (r.tempMaxC !== null && r.tempMinC !== null) parts.push(`기온 ${r.tempMinC.toFixed(0)}~${r.tempMaxC.toFixed(0)}°C`);
  if (r.precipitationProbability !== null) parts.push(`강수확률 ${r.precipitationProbability}%`);
  if (r.precipitationMm !== null) parts.push(`강수량 ${r.precipitationMm.toFixed(1)}mm`);
  if (r.humidity !== null) parts.push(`습도 ${r.humidity.toFixed(0)}%`);
  if (r.windMaxKmh !== null) parts.push(`최대풍속 ${r.windMaxKmh.toFixed(0)}km/h`);
  return parts.join(" · ");
}
