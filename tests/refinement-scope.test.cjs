/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockModule } = require('./register-ts.cjs');
const { enforceRefinementScope } = require('../src/lib/refinement-scope.ts');
const { ensureGarmentSpecs, garmentSpecText } = require('../src/lib/garment-specs.ts');
const original = {
  id: 'look-1', targetCustomer: '남성', name: '오버핏 코디',
  outfitItems: ['상의: 네이비 오버사이즈 무지 긴팔 맨투맨', '하의: 차콜 와이드 슬랙스', '신발: 그레이 뉴발란스 530', '아우터: 네이비 경량 패딩'],
  garmentSpecs: [
    { category: '상의', item: '오버사이즈 맨투맨', color: '네이비', fit: '오버핏', sleeve: '긴팔', pattern: '무지', material: '코튼' },
    { category: '하의', item: '와이드 슬랙스', color: '차콜', fit: '와이드' },
    { category: '신발', item: '뉴발란스 530', brand: '뉴발란스', model: '530', color: '그레이' },
    { category: '아우터', item: '경량 패딩', color: '네이비', sleeve: '긴팔', pattern: '무지', fit: '릴랙스' },
  ],
};
const proposal = {
  ...original, targetCustomer: '여성', name: '상관없는 새 룩',
  outfitItems: ['상의: 올리브 프린트 반팔 니트', '하의: 블랙 트랙 팬츠', '신발: 화이트 컨버스', '아우터: 차콜 경량 패딩'],
  garmentSpecs: [{ category: '상의', item: '프린트 니트', color: '올리브', pattern: '프린팅', sleeve: '반팔' }, { category: '아우터', item: '경량 패딩', color: '차콜' }],
};
const categoryItem = (concept, category) => concept.outfitItems.find((item) => item.startsWith(category + ':'));

test('reported color collision changes exactly one item and only its color despite full model rewrite', () => {
  const result = enforceRefinementScope(original, proposal, '아우터와 상의 색깔이 겹쳐서 별로인 것 같아. 둘 중에 하나를 바꿔줄래?');
  assert.deepEqual(result.changedCategories, ['상의']);
  assert.match(categoryItem(result.concept, '상의'), /올리브.*오버사이즈 무지 긴팔 맨투맨/);
  for (const category of ['아우터', '하의', '신발']) {
    assert.equal(categoryItem(result.concept, category), categoryItem(original, category));
    assert.deepEqual(result.concept.garmentSpecs.find((item) => item.category === category), original.garmentSpecs.find((item) => item.category === category));
  }
  const top = result.concept.garmentSpecs.find((item) => item.category === '상의');
  assert.equal(top.pattern, '무지'); assert.equal(top.sleeve, '긴팔'); assert.equal(top.fit, '오버핏'); assert.equal(top.material, '코튼');
  assert.equal(result.concept.targetCustomer, '남성'); assert.equal(result.concept.name, original.name);
  assert.doesNotMatch(result.refinementReply, /아우터:|트랙|컨버스|프린트/);
  assert.equal(result.changed.length, 1);
});
test('explicit top-only request rejects all unrelated category changes', () => {
  const result = enforceRefinementScope(original, proposal, '상의만 올리브 니트로 바꿔줘');
  assert.deepEqual(result.changedCategories, ['상의']);
  for (const category of ['하의', '신발', '아우터']) assert.equal(categoryItem(result.concept, category), categoryItem(original, category));
});
test('a selected category locks changes even if the model rewrites the full look', () => {
  const result = enforceRefinementScope(original, proposal, '다른 느낌으로 바꿔줘', '아우터');
  assert.deepEqual(result.changedCategories, ['아우터']);
  assert.equal(categoryItem(result.concept, '상의'), categoryItem(original, '상의'));
});
test('explicit outer removal retains inner, pants and shoes even if the model omits everything', () => {
  const result = enforceRefinementScope(original, { outfitItems: [] }, '아우터를 빼줘');
  assert.deepEqual(result.changedCategories, ['아우터']);
  assert.equal(result.concept.outfitItems.length, 3);
  assert.equal(result.concept.garmentSpecs.length, 3);
  assert.equal(categoryItem(result.concept, '상의'), categoryItem(original, '상의'));
  assert.match(result.refinementReply, /경량 패딩 제거/);
});
test('adding a black denim jacket preserves the original white inner and all its attributes', () => {
  const base = { outfitItems: ['상의: 화이트 무지 반팔 티셔츠', '하의: 인디고 데님 팬츠', '신발: 그레이 뉴발란스 574'] };
  const result = enforceRefinementScope(base, { outfitItems: ['상의: 블랙 무지 반팔 티셔츠', '하의: 블랙 트랙 팬츠', '아우터: 검정 데님 자켓'] }, '검정색 데님 자켓 추가');
  assert.deepEqual(result.changedCategories, ['아우터']);
  assert.equal(categoryItem(result.concept, '상의'), base.outfitItems[0]);
  assert.equal(categoryItem(result.concept, '하의'), base.outfitItems[1]);
  assert.equal(categoryItem(result.concept, '아우터'), '아우터: 블랙 데님 자켓');
});
test('explicit multiple-item request permits only the named items', () => {
  const result = enforceRefinementScope(original, proposal, '상의는 올리브 니트로, 하의는 블랙 트랙 팬츠로 바꿔줘');
  assert.deepEqual(result.changedCategories, ['상의', '하의']);
  assert.equal(categoryItem(result.concept, '신발'), categoryItem(original, '신발'));
  assert.equal(categoryItem(result.concept, '아우터'), categoryItem(original, '아우터'));
});
test('unrelated candidate change does not produce a false success summary', () => {
  const result = enforceRefinementScope(original, { ...original, outfitItems: [original.outfitItems[0], '하의: 블랙 트랙 팬츠', ...original.outfitItems.slice(2)] }, '신발만 로퍼로 바꿔줘');
  assert.equal(result.unchanged, true); assert.deepEqual(result.changed, []);
  assert.match(result.refinementReply, /기존 룩을 유지/);
  assert.equal(categoryItem(result.concept, '하의'), categoryItem(original, '하의'));
});
test('model failure still resolves a color collision with one local color edit', () => {
  const result = enforceRefinementScope(original, original, '상의와 아우터 색상이 같아. 둘 중 하나만 바꿔줘');
  assert.deepEqual(result.changedCategories, ['상의']);
  assert.match(categoryItem(result.concept, '상의'), /아이보리/);
  assert.equal(categoryItem(result.concept, '아우터'), original.outfitItems[3]);
});
let modelResult;
let forwarded;
mockModule('@/lib/nvidia', { NVIDIA_PLAN_MODEL: 'offline', getNvidiaClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(modelResult) } }] }) } } }) });
mockModule('@/lib/openai', { parseJsonObjectFromText: JSON.parse });
mockModule('@/lib/log', { agentLog: () => {} });
let cachedInspection;
let cacheReads = 0;
mockModule('@/lib/shopping-visual', {
  getCachedLookbookGarments: () => { cacheReads += 1; return cachedInspection; },
  inspectLookbookGarments: () => { throw new Error('Refinement must not make a fresh vision request'); },
});
const route = require('../src/app/api/refine/route.ts');
test('route forwards accepted changes and ignores fabricated changed/reply claims', async () => {
  modelResult = { concept: proposal, reply: '모두 바꿨어요', changed: ['아우터: 네이비 → 차콜', '상의: 네이비 → 올리브'] };
  const oldFetch = global.fetch;
  global.fetch = async (_, init) => { forwarded = JSON.parse(init.body); return Response.json({ imageUrl: 'data:updated', verified: false, concept: { ...forwarded.concept, enrichment: 'retained' } }); };
  try {
    const response = await route.POST(new Request('http://localhost/api/refine', { method: 'POST', body: JSON.stringify({ concept: original, feedback: '상의와 아우터 색깔이 겹쳐. 둘 중 하나만 바꿔줘' }) }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.changed.length, 1); assert.doesNotMatch(result.refinementReply, /아우터:|모두/);
    const outer = forwarded.concept.garmentSpecs.find((item) => item.category === '아우터');
    assert.equal(outer.color, '네이비');
    assert.equal(result.concept.enrichment, 'retained');
    assert.ok(forwarded.concept.outfitItems.every((item) => typeof item === 'string'));
  } finally { global.fetch = oldFetch; }
});
test('saved observed colors define the before-state for refinement', async () => {
  const observed = ensureGarmentSpecs(original).garmentSpecs.map((spec) => spec.category === '아우터' ? { ...spec, item: '경량 패딩', color: '네이비' } : spec);
  modelResult = { concept: proposal };
  const oldFetch = global.fetch;
  global.fetch = async (_, init) => { forwarded = JSON.parse(init.body); return Response.json({ imageUrl: 'data:updated' }); };
  try {
    const response = await route.POST(new Request('http://localhost/api/refine', { method: 'POST', body: JSON.stringify({ concept: { ...original, outfitItems: original.outfitItems.map((item) => item.replace('아우터: 네이비', '아우터: 블랙')) }, imageGarmentSpecs: observed, feedback: '상의와 아우터 색깔이 겹쳐. 둘 중 하나만 바꿔줘' }) }));
    assert.equal(response.status, 200);
    assert.match(garmentSpecText(forwarded.concept.garmentSpecs.find((spec) => spec.category === '아우터')), /네이비/);
  } finally { global.fetch = oldFetch; }
});
test('requesting an already present color does not change it to an arbitrary alternative', () => {
  const result = enforceRefinementScope(original, proposal, '상의 색상만 네이비로 바꿔줘');
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.changed, []);
});
test('a keep-only request cannot authorize an unrelated proposed change', () => {
  const result = enforceRefinementScope(original, proposal, '신발은 그대로 유지해');
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.changed, []);
});
test('server cached observations override client observations without a new image export and preserve brand/model', async () => {
  cachedInspection = { status: 'verified', specs: [
    { category: '아우터', item: '경량 패딩', color: '카키' },
    { category: '신발', item: '컨버스 올스타 스니커즈', color: '그레이', brand: '컨버스', model: '올스타' },
  ] };
  cacheReads = 0;
  modelResult = { concept: proposal };
  const oldFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'http://localhost/api/lookbook');
    forwarded = JSON.parse(init.body);
    assert.equal(forwarded.imageUrl, undefined);
    return Response.json({ imageUrl: 'data:updated' });
  };
  try {
    const response = await route.POST(new Request('http://localhost/api/refine', { method: 'POST', body: JSON.stringify({ concept: original, imageUrl: 'data:image/png;base64,aW1hZ2U=', imageGarmentSpecs: [{ category: '아우터', item: '경량 패딩', color: '카멜' }], feedback: '상의 색깔만 올리브로 바꿔줘' }) }));
    assert.equal(response.status, 200);
    assert.equal(cacheReads, 1);
    assert.equal(forwarded.concept.garmentSpecs.find((item) => item.category === '아우터').color, '카키');
    const shoe = forwarded.concept.garmentSpecs.find((item) => item.category === '신발');
    assert.equal(shoe.brand, '뉴발란스');
    assert.equal(shoe.model, '530');
    assert.doesNotMatch(shoe.item, /컨버스|올스타/);
  } finally { global.fetch = oldFetch; cachedInspection = undefined; }
});
test('cache miss retains saved observations and never requests a fresh vision call', async () => {
  cachedInspection = undefined;
  modelResult = { concept: proposal };
  const oldFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'http://localhost/api/lookbook');
    forwarded = JSON.parse(init.body); return Response.json({ imageUrl: 'data:updated' });
  };
  try {
    const response = await route.POST(new Request('http://localhost/api/refine', { method: 'POST', body: JSON.stringify({ concept: original, imageUrl: 'data:image/png;base64,aW1hZ2U=', imageGarmentSpecs: [{ category: '아우터', item: '경량 패딩', color: '브라운' }], feedback: '상의만 올리브색으로 바꿔줘' }) }));
    assert.equal(response.status, 200);
    assert.equal(forwarded.concept.garmentSpecs.find((item) => item.category === '아우터').color, '브라운');
  } finally { global.fetch = oldFetch; }
});
