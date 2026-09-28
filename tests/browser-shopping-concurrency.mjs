// Uses the isolated build through Playwright routes; no app server or live APIs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { installBrowserAssetRoutes } from './offline-browser.mjs';

const moduleUrl = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright';
const { chromium } = await import(moduleUrl);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
// Distinct offline image fixtures detect cross-card and pre-refinement image reuse.
const lookbookImage = (index, refined = false) => 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="36"><rect width="24" height="36" fill="' + (refined ? '#303030' : ['#eeeeee','#dddddd','#cccccc','#bbbbbb','#aaaaaa'][index]) + '"/><text x="1" y="15">' + index + (refined ? 'R' : 'G') + '</text></svg>'
).toString('base64');
const garmentSpecs = (refined = false) => [
  { category: '상의', item: refined ? '검정 셔츠' : '흰 티셔츠', color: refined ? '블랙' : '화이트', pattern: '무지', sleeve: refined ? '긴팔' : '반팔', material: '코튼' },
  { category: '하의', item: '그레이 팬츠', color: '그레이', pattern: '무지', length: '긴바지' },
  { category: '신발', item: '검정 컨버스 스니커즈', color: '블랙', brand: '컨버스', model: '척 70' },
];
// Observed image attributes deliberately differ from the design palette.
const imageSpecs = (refined = false) => garmentSpecs(refined).map(spec => spec.category === '상의'
  ? { ...spec, color: refined ? '차콜' : '아이보리' } : spec);
const enrichedConcept = (concept, refined = false) => ({ ...concept,
  description: refined ? '수정된 셔츠와 기존 팬츠 조합' : '이미지 생성에 사용한 상세 의류 명세',
  outfitItems: garmentSpecs(refined).map(spec => spec.category + ': ' + spec.item), garmentSpecs: garmentSpecs(refined),
});
const keyword = '내일 성수 캐주얼룩 추천해줘';
const concepts = Array.from({ length: 5 }, (_, index) => ({
  id: 'look_' + index, name: '검증 룩 ' + index, description: '상의와 팬츠, 스니커즈 조합',
  mood: '캐주얼', targetCustomer: '남성', colorPalette: ['화이트', '그레이'],
  materials: ['코튼'], outfitItems: ['상의: 흰 티셔츠', '하의: 그레이 팬츠', '신발: 컨버스 스니커즈'],
}));
const evaluations = concepts.map((concept, index) => ({
  id: concept.id, name: concept.name, rank: index + 1, totalScore: 95 - index,
  failureReasons: [], revisionPlan: [], verifierIssues: [],
}));
const plan = {
  planStatus: 'complete', evaluationStage: 'repaired', candidateSource: 'model',
  originalCandidates: concepts, repairedCandidates: concepts, round1: evaluations, round2: evaluations,
  finalConcepts: concepts.slice(0, 2), repairSummary: [],
};
const product = (index, suffix = '') => ({
  kind: 'product', category: '신발', item: '컨버스 스니커즈', title: '상품-' + index + suffix,
  url: 'https://www.musinsa.com/products/' + (123450 + index), source: '무신사',
  reason: '판매처에서 종류와 브랜드를 확인한 상품', price: '89,000원',
  visualStatus: index % 2 === 0 ? 'verified' : 'unverified',
  verificationNotice: index % 2 === 0 ? '사진에서 신발 색상과 형태를 비교했어요.' : '상품 정보만 확인했고 사진 비교는 완료하지 못했어요.',
  visualDifferences: index % 2 === 0 ? [] : ['이미지의 소재 질감은 확인하지 못했어요.'],
});

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const unexpected = [], errors = [], pending = [], refinementActions = [];
  const base = 'http://offline.test';
  await installBrowserAssetRoutes(context, base, unexpected, { offline: true, buildDirectory: path.resolve('.next-quality') });
  await context.route('**/api/agent', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'shopping') {
      await new Promise(resolve => pending.push({ body, route, resolve }));
      return;
    }
    let data;
    if (body.action === 'prepare') data = {
      trend: '가을 캐주얼', intent: { occasion: '약속', location: '성수' },
      weather: { date: '2026-09-29', season: '가을', location: { query: '성수', name: '서울' }, forecastAvailable: true, forecast: { temperatureMin: 13.4, temperatureMax: 24.3 } },
    };
    else if (body.action === 'consult') data = { message: '걷기 편한 스니커즈와 여유 있는 팬츠를 추천해요.', options: [], allowQuickApply: true };
    else if (body.action === 'plan') data = plan;
    else if (body.action === 'lookbook') data = {
      imageUrl: lookbookImage(Number(body.concept.id.split('_')[1])), concept: enrichedConcept(body.concept),
      imageGarmentSpecs: imageSpecs(), verified: false, mismatches: [], error: null,
    };
    else if (body.action === 'refine') {
      refinementActions.push(body);
      data = body.feedback === '현재 룩 그대로 유지해줘'
        ? { unchanged: true, refinementReply: '현재 룩과 찾은 상품을 그대로 유지했어요.' }
        : {
        imageUrl: lookbookImage(Number(body.concept.id.split('_')[1]), true), verified: false, mismatches: [], error: null,
        concept: enrichedConcept(body.concept, true), imageGarmentSpecs: imageSpecs(true),
        refinementReply: '상의만 검정 셔츠로 바꿨어요.',
      };
    }
    else throw Error('Unexpected action ' + body.action);
    await route.fulfill({ status: 200, json: data });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByPlaceholder('예: 날짜·장소·약속·원하는 분위기를 자유롭게 입력').fill(keyword);
  await page.getByRole('button', { name: '생성', exact: true }).click();
  await page.getByRole('button', { name: '이동이 많아요', exact: true }).click();
  await page.getByRole('button', { name: /5개 후보 (생성하기|보기)$/ }).click();
  await page.getByRole('heading', { name: '5개 후보에서 룩북으로 볼 안을 골라주세요' }).waitFor();
  while (await page.locator('button[aria-pressed="false"]').count()) {
    await page.locator('button[aria-pressed="false"]').first().click();
  }
  await page.getByRole('button', { name: '선택한 5개 룩북 보기', exact: true }).click();
  await page.getByText('스타일 시안 · 이미지 비교 미완료', { exact: true }).first().waitFor();
  const cards = page.locator('article').filter({ has: page.getByRole('img', { name: /룩북$/ }) });
  assert.equal(await cards.count(), 5);
  const waitForPending = async count => {
    for (let attempt = 0; pending.length < count && attempt < 150; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(pending.length, count);
  };
  const fulfill = async (request, index, suffix = '') => {
    await request.route.fulfill({ status: 200, json: { links: [product(index, suffix)], missingItems: [], warning: null, status: 'complete' } }).catch(() => {});
    request.resolve();
  };
  const assertLookPayload = (body, index, refined = false) => {
    assert.equal(body.concept.id, 'look_' + index);
    assert.equal(body.imageUrl, lookbookImage(index, refined), 'send the displayed image, not an old/sibling image');
    assert.deepEqual(body.imageGarmentSpecs, imageSpecs(refined), 'retain image observations independently of the palette');
    assert.deepEqual(body.concept.garmentSpecs, garmentSpecs(refined), 'retain enriched generation specifications');
    assert.equal(body.concept.description, enrichedConcept({}, refined).description);
  };
  const startShopping = async index => {
    const count = pending.length;
    await cards.nth(index).getByRole('button', { name: /^(다시 찾기|비슷한 상품 찾기)$/ }).click();
    await waitForPending(count + 1);
    return pending[count];
  };
  for (let i = 0; i < 5; i++) await cards.nth(i).getByRole('button', { name: '비슷한 상품 찾기', exact: true }).click();
  await waitForPending(5);
  for (let i = 0; i < 5; i++) assertLookPayload(pending[i].body, i);
  assert.equal(await page.getByRole('button', { name: '검색 중...', exact: true }).count(), 5);
  for (const i of [4, 1, 3, 0, 2]) {
    await fulfill(pending[i], i);
    await cards.nth(i).getByRole('link', { name: new RegExp('상품-' + i) }).waitFor();
  }
  assert.equal(await page.getByRole('button', { name: '검색 중...', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '다시 찾기', exact: true }).count(), 5);
  for (let i = 0; i < 5; i++) assert.equal(await cards.nth(i).getByRole('link', { name: new RegExp('상품-' + i) }).count(), 1);

  // Metadata-only candidates must never claim that images were compared.
  for (let i = 0; i < 5; i++) {
    const card = cards.nth(i);
    assert.equal(await card.getByText('룩북·상품 사진의 주요 특징 비교 완료', { exact: true }).count(), i % 2 === 0 ? 1 : 0);
    assert.equal(await card.getByText('상품 후보 · 사진 비교 미완료', { exact: true }).count(), i % 2 === 0 ? 0 : 1);
    if (i % 2) await card.getByText('이미지의 소재 질감은 확인하지 못했어요.', { exact: true }).waitFor();
  }

  // Duplicate clicks before the next render cannot start a second request.
  await cards.nth(2).getByRole('button', { name: '다시 찾기', exact: true }).evaluate(button => { button.click(); button.click(); });
  await waitForPending(6);
  await cards.nth(2).getByRole('button', { name: '검색 취소', exact: true }).click();
  await fulfill(pending[5], 2, '-취소된결과');
  await cards.nth(2).getByRole('button', { name: '다시 찾기', exact: true }).waitFor();
  assert.equal(await page.getByText('상품 후보 · 상품-2-취소된결과', { exact: true }).count(), 0);

  // A hung response ends after the absolute deadline and retains the previous product.
  await page.clock.install();
  await cards.nth(2).getByRole('button', { name: '다시 찾기', exact: true }).click();
  await waitForPending(7);
  await page.clock.fastForward(129_900);
  assert.equal(await cards.nth(2).getByRole('button', { name: '검색 중...', exact: true }).count(), 1, 'the deadline is 130 seconds');
  await page.clock.fastForward(200);
  await page.getByText(/상품 검색 시간이 초과됐어요/).waitFor();
  await cards.nth(2).getByRole('button', { name: '다시 찾기', exact: true }).waitFor();
  assert.equal(await cards.nth(2).getByRole('link', { name: /상품-2/ }).count(), 1);
  await cards.nth(2).getByRole('button', { name: '다시 찾기', exact: true }).click();
  await waitForPending(8);
  await fulfill(pending[7], 2, '-재시도');
  await page.getByText('상품 후보 · 상품-2-재시도', { exact: true }).waitFor();

  // Refine cancels only the edited card; another card's concurrent result survives.
  await cards.nth(0).getByRole('button', { name: '다시 찾기', exact: true }).click();
  await cards.nth(1).getByRole('button', { name: '다시 찾기', exact: true }).click();
  await waitForPending(10);
  await page.getByPlaceholder('예: 아우터를 더 짧고 가벼운 재킷으로 바꿔줘').fill('상의만 검정 셔츠로');
  await page.getByRole('button', { name: '수정 반영', exact: true }).click();
  await page.getByText('상의만 검정 셔츠로 바꿨어요.', { exact: true }).first().waitFor();
  assertLookPayload(refinementActions.at(-1), 0);
  assert.equal(await cards.nth(0).getByRole('img', { name: /룩북$/ }).getAttribute('src'), lookbookImage(0, true));
  await fulfill(pending[8], 0, '-이전코디');
  await fulfill(pending[9], 1, '-유지');
  await page.getByText('상품 후보 · 상품-1-유지', { exact: true }).waitFor();
  assert.equal(await page.getByText('상품 후보 · 상품-0-이전코디', { exact: true }).count(), 0);
  assert.equal(await cards.nth(0).getByRole('link').count(), 0);
  const refinedRequest = await startShopping(0);
  assertLookPayload(refinedRequest.body, 0, true);
  await fulfill(refinedRequest, 0, '-수정후');
  await cards.nth(0).getByText('상품 후보 · 상품-0-수정후', { exact: true }).waitFor();
  await page.getByRole('button', { name: '↶ 되돌리기', exact: true }).click();
  await cards.nth(0).getByRole('link', { name: /상품-0/ }).waitFor();
  assert.equal(await cards.nth(0).getByText('상품 후보 · 상품-0-수정후', { exact: true }).count(), 0);
  assert.equal(await cards.nth(0).getByRole('img', { name: /룩북$/ }).getAttribute('src'), lookbookImage(0));
  const undoRequest = await startShopping(0);
  assertLookPayload(undoRequest.body, 0);
  await fulfill(undoRequest, 0, '-복원');
  await cards.nth(0).getByText('상품 후보 · 상품-0-복원', { exact: true }).waitFor();

  // A no-op refinement must preserve the image, products, specs and undo stack.
  assert.equal(await page.getByRole('button', { name: '↶ 되돌리기', exact: true }).isDisabled(), true);
  await page.getByPlaceholder('예: 아우터를 더 짧고 가벼운 재킷으로 바꿔줘').fill('현재 룩 그대로 유지해줘');
  await page.getByRole('button', { name: '수정 반영', exact: true }).click();
  await page.getByText('현재 룩과 찾은 상품을 그대로 유지했어요.', { exact: true }).waitFor();
  assertLookPayload(refinementActions.at(-1), 0);
  await cards.nth(0).getByText('상품 후보 · 상품-0-복원', { exact: true }).waitFor();
  assert.equal(await cards.nth(0).getByRole('img', { name: /룩북$/ }).getAttribute('src'), lookbookImage(0));
  assert.equal(await page.getByRole('button', { name: '↶ 되돌리기', exact: true }).isDisabled(), true);

  // Reset / history restore cannot revive pending spinners or accept an old result.
  const oldRunRequest = await startShopping(4);
  await page.getByRole('button', { name: '재검색', exact: true }).click();
  await page.getByRole('button', { name: /이전 기록 1/ }).click();
  await page.getByRole('button', { name: new RegExp(keyword) }).click();
  await page.getByRole('button', { name: '다시 찾기', exact: true }).first().waitFor();
  await fulfill(oldRunRequest, 4, '-이전실행');
  assert.equal(await page.getByRole('button', { name: '검색 중...', exact: true }).count(), 0);
  assert.equal(await page.getByText('상품 후보 · 상품-4-이전실행', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '다시 찾기', exact: true }).count(), 5);
  await page.getByText('상품 후보 · 상품-0-복원', { exact: true }).waitFor();
  await page.getByText('상품 후보 · 상품-1-유지', { exact: true }).waitFor();
  await page.getByText('상품 후보 · 상품-2-재시도', { exact: true }).waitFor();

  // History normalization must retain both image observations and design specs.
  for (let i = 0; i < 5; i++) {
    const restoredRequest = await startShopping(i);
    assertLookPayload(restoredRequest.body, i);
    await cards.nth(i).getByRole('button', { name: '검색 취소', exact: true }).click();
    restoredRequest.resolve();
    assert.equal(await cards.nth(i).getByRole('img', { name: /룩북$/ }).getAttribute('src'), lookbookImage(i));
    assert.equal(await cards.nth(i).getByText('룩북·상품 사진의 주요 특징 비교 완료', { exact: true }).count(), i % 2 === 0 ? 1 : 0);
  }

  await mkdir('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/shopping-concurrency-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '.tmp/shopping-concurrency-mobile.png', fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  for (const request of pending) request.resolve();
  console.log('PASS: 5 parallel out-of-order products, 130s deadline, duplicate/cancel/retry, actual image and separate observed/design specs through generation/refine/undo/history, no-op preserves products, honest visual status, desktop/mobile; no app server or live APIs');
} finally { await browser.close(); }
