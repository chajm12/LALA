// Run after LALA_ISOLATED_BUILD=1 npm run build. Uses compiled assets, never a server.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { installBrowserAssetRoutes } from './offline-browser.mjs';
const require = createRequire(import.meta.url);
const { mockModule } = require('./register-ts.cjs');
const { createBackupCandidates } = require('../src/lib/plan-recovery.ts');
const { buildDirectConsultationReply } = require('../src/lib/consultation-replies.ts');
let calls = 0;
mockModule('@/lib/openai', { parseJsonObjectFromText: JSON.parse });
mockModule('@/lib/nvidia', { NVIDIA_PLAN_MODEL: 'offline-test', getNvidiaClient: () => ({ chat: { completions: { create: async () => {
  if (++calls > 1) throw Error('Request was aborted.');
  return { choices: [{ message: { content: JSON.stringify({ concepts: createBackupCandidates('뉴발란스나 컨버스 캐주얼', null) }) }, finish_reason: 'stop' }] };
} } } }) });
mockModule('@/lib/log', { agentLog: () => {} });
const plan = require('../src/app/api/plan/route.ts').POST;
const keyword = '내일 성수에 약속이 있어. 뉴발란스나 컨버스로 캐주얼룩 추천해줘';
const weather = { date: '2026-09-29', season: '가을', location: { query: '성수', name: '서울', resolution: 'parent_region' }, forecastAvailable: true, forecast: { temperatureMin: 13.4, temperatureMax: 24.3, precipitationMm: 0, weatherCode: 2 } };
const trend = '일교차가 있어 얇은 겉옷을 입고 벗는 조합';
const result = await (await plan(new Request('http://offline.test/api/plan', { method: 'POST', body: JSON.stringify({ keyword, weather, trend, intent: {} }) }))).json();
assert.equal(result.evaluationStage, 'initial'); assert.equal(result.finalConcepts.length, 2);
const moduleUrl = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright';
const { chromium } = await import(moduleUrl);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1cAAAAASUVORK5CYII=';
const garmentSpecs = [
  { category: '상의', item: '버건디 긴팔 니트', color: '버건디', pattern: '무지', sleeve: '긴팔', material: '니트' },
  { category: '하의', item: '검정 스트레이트 데님 팬츠', color: '블랙', pattern: '무지', material: '데님', fit: '스트레이트' },
  { category: '신발', item: '회색 뉴발란스 574 스니커즈', color: '그레이', brand: '뉴발란스', model: '574' },
];
const imageGarmentSpecs = garmentSpecs.map(spec => spec.category === '하의' ? { ...spec, color: '차콜' } : spec);
const enrichedConcept = concept => ({ ...concept, description: '생성 이미지와 연결된 구체적인 품목별 명세',
  outfitItems: garmentSpecs.map(spec => spec.category + ': ' + spec.item), garmentSpecs,
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const unexpected = [], errors = [], actions = [];
  const base = 'http://offline.test';
  await installBrowserAssetRoutes(context, base, unexpected, { offline: true, buildDirectory: path.resolve('.next-quality') });
  await context.route('**/api/agent', async route => {
    const body = route.request().postDataJSON(); actions.push(body);
    let data;
    if (body.action === 'prepare') data = { trend, weather, intent: { occasion: '친구 약속', location: '성수', fitDirection: [], materialDirection: [], mustHave: [], avoid: [] } };
    else if (body.action === 'consult') data = { message: buildDirectConsultationReply({ keyword, feedback: body.feedback, stage: body.stage }), options: [], allowQuickApply: true };
    else if (body.action === 'plan') data = result;
    else if (body.action === 'lookbook') data = { imageUrl, concept: enrichedConcept(body.concept), imageGarmentSpecs, verified: false, mismatches: [], error: null };
    else if (body.action === 'shopping') data = { warning: '신발 상품은 아직 찾지 못했어요.', missingItems: ['신발'], status: 'partial', links: [
      { kind: 'product', category: '상의', item: '버건디 긴팔 니트', title: '버건디 긴팔 니트', source: '무신사', url: 'https://www.musinsa.com/products/12345',
        reason: '판매처에서 확인한 개별 상품', visualStatus: 'unverified', verificationNotice: '상품 정보는 확인했지만 사진 비교는 완료하지 못했어요.', visualDifferences: ['소매 길이는 판매처 표기만 확인했어요.'] },
      { kind: 'product', category: '하의', item: '검정 스트레이트 데님 팬츠', title: '검정 스트레이트 데님 팬츠', source: '무신사', url: 'https://www.musinsa.com/products/12346',
        reason: '사진의 바지 종류와 주요 형태를 비교했어요.', visualStatus: 'verified', visualDifferences: [] },
    ] };
    else throw Error('Unexpected action: '+body.action);
    await route.fulfill({ status: 200, json: data });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByPlaceholder('예: 날짜·장소·약속·원하는 분위기를 자유롭게 입력').fill(keyword);
  await page.getByRole('button', { name: '생성', exact: true }).click();
  await page.getByRole('button', { name: '이동이 많아요', exact: true }).click();
  await page.getByText('이동이 많으니 뉴발란스 스니커즈', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: /5개 후보 (생성하기|보기)$/ }).click();
  await page.getByRole('heading', { name: '5개 후보에서 룩북으로 볼 안을 골라주세요' }).waitFor();
  assert.ok(actions.find(item => item.action === 'plan').consultationProposal.includes('스니커즈'));
  assert.equal(await page.locator('button[aria-pressed]').count(), 5);
  await page.getByRole('button', { name: '선택한 2개 룩북 보기', exact: true }).click();
  await page.getByText('스타일 시안 · 이미지 비교 미완료', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('img', { name: /룩북$/ }).count(), 2);
  assert.equal(await page.getByText('결과를 보여드릴게요', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '비슷한 상품 찾기', exact: true }).first().click();
  await page.getByText('상품 후보 · 버건디 긴팔 니트', { exact: true }).waitFor();
  const shoppingAction = actions.find(item => item.action === 'shopping');
  assert.equal(shoppingAction.imageUrl, imageUrl);
  assert.deepEqual(shoppingAction.imageGarmentSpecs, imageGarmentSpecs);
  assert.deepEqual(shoppingAction.concept.garmentSpecs, garmentSpecs);
  assert.equal(shoppingAction.concept.description, enrichedConcept({}).description);
  const metadataCandidate = page.getByRole('link', { name: /상품 후보 · 버건디 긴팔 니트/ });
  assert.equal(await metadataCandidate.getByText('상품 후보 · 사진 비교 미완료', { exact: true }).count(), 1);
  assert.equal(await metadataCandidate.getByText('룩북·상품 사진의 주요 특징 비교 완료', { exact: true }).count(), 0);
  await metadataCandidate.getByText('소매 길이는 판매처 표기만 확인했어요.', { exact: true }).waitFor();
  const visualCandidate = page.getByRole('link', { name: /상품 후보 · 검정 스트레이트 데님 팬츠/ });
  await visualCandidate.getByText('룩북·상품 사진의 주요 특징 비교 완료', { exact: true }).waitFor();
  assert.equal(await metadataCandidate.getAttribute('href'), 'https://www.musinsa.com/products/12345');
  await page.getByText('아직 찾지 못한 품목: 신발', { exact: true }).waitFor();
  await mkdir('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/recovery-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '.tmp/recovery-mobile.png', fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('PASS: aborted repair -> 5 candidates -> 2 unverified lookbooks -> exact image and observed/design specs passed to shopping, separate metadata/visual verification labels with partial status; desktop/mobile; no server or live API');
} finally { await browser.close(); }
