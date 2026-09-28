/* eslint-disable @typescript-eslint/no-require-imports -- Node offline test harness */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
require('./register-ts.cjs');
const { extractLocationHint, weatherParentRegion } = require('../src/lib/location.ts');
const { lookupOpenMeteoWeather, getTodayInKorea } = require('../src/lib/weather.ts');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test('extracts 성수 from the reported conversational request, not its body-measurement ending', () => {
  assert.equal(extractLocationHint('내일 성수에 약속을 가기로 했어. 뉴발란스나 컨버스를 신는 캐주얼룩으로 추천해줄래? 나는 남자이고, 188cm/85kg이야.'), '성수');
});

test('preserves neighborhood, station, and administrative location names', () => {
  for (const [input, expected] of [
    ['성수동 카페 데이트', '성수동'], ['삼성역에서 결혼식이 있어', '삼성역'],
    ['내일 을지로에 가요', '을지로'], ['다음 주 부산 해운대에서 산책', '부산 해운대'],
    ['서울특별시 성동구 성수동1가에서 약속', '서울특별시 성동구 성수동1가'],
    ['내일 양평군에서 여행', '양평군'], ['늘푸른역 근처 카페', '늘푸른역'],
  ]) assert.equal(extractLocationHint(input), expected, input);
});

test('does not invent a destination from conversational or clothing words', () => {
  for (const input of [
    '나는 남자이고 188cm/85kg이야.', '캐주얼룩으로 추천해줘', '내일 약속에 갈 옷 추천',
    '편한 옷 추천해줘', '이동이 많아요', '운동 카페 데이트', '여름에는 반팔로 입어요',
  ]) assert.equal(extractLocationHint(input), undefined, input);
});

test('only known geography permits a parent region fallback', () => {
  assert.equal(weatherParentRegion('성수역'), 'Seoul');
  assert.equal(weatherParentRegion('해운대'), 'Busan');
  assert.equal(weatherParentRegion('알수없는마을'), undefined);
  assert.equal(weatherParentRegion('이야.'), undefined);
});

test('missing place does not request or silently supply Seoul weather', async () => {
  global.fetch = async () => { throw new Error('must not fetch'); };
  const weather = await lookupOpenMeteoWeather({ date: getTodayInKorea() });
  assert.equal(weather.forecastAvailable, false);
  assert.equal(weather.location.resolved, false);
  assert.equal(weather.location.query, '미지정');
});

test('unknown Korean place never falls back to Seoul or a foreign geocoding match', async () => {
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    return Response.json({ results: [{ name: 'Ia', country: '그리스', country_code: 'GR', latitude: 36, longitude: 25 }] });
  };
  const weather = await lookupOpenMeteoWeather({ location: '알수없는마을', date: getTodayInKorea() });
  assert.equal(weather.forecastAvailable, false);
  assert.equal(weather.location.resolved, false);
  assert.ok(urls.every((url) => !url.includes('Seoul') && !url.includes('/forecast')));
});

test('known Seoul neighborhood fallback preserves original query and explicitly labels parent-region forecast', async () => {
  global.fetch = async (url) => {
    const value = new URL(url);
    if (value.hostname.startsWith('geocoding')) {
      return Response.json({ results: value.searchParams.get('name') === 'Seoul'
        ? [{ name: '서울', country_code: 'KR', admin1: '서울특별시', latitude: 37.56, longitude: 126.97, timezone: 'Asia/Seoul' }]
        : [{ name: '성수', country_code: 'KR', admin1: '전라북도', latitude: 35.6, longitude: 127.2 }] });
    }
    return Response.json({ daily: { temperature_2m_min: [13.4], temperature_2m_max: [24.3] } });
  };
  const weather = await lookupOpenMeteoWeather({ location: '성수', date: getTodayInKorea() });
  assert.equal(weather.forecastAvailable, true);
  assert.equal(weather.location.query, '성수');
  assert.equal(weather.location.name, '서울');
  assert.equal(weather.location.resolution, 'parent_region');
  assert.match(weather.guidance, /서울 기준/);
});

test('empty forecast response is not marked verified or available', async () => {
  global.fetch = async (url) => String(url).includes('geocoding')
    ? Response.json({ results: [{ name: '서울', country_code: 'KR', admin1: '서울특별시', latitude: 37.56, longitude: 126.97 }] })
    : Response.json({ daily: {} });
  const weather = await lookupOpenMeteoWeather({ location: '서울', date: getTodayInKorea() });
  assert.equal(weather.forecastAvailable, false);
});
