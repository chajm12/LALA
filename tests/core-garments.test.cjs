/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockModule } = require('./register-ts.cjs');
const { normalizeCoreOutfitItems, sanitizeCoreConcept, coreGarmentCategory, sanitizeCoreText } = require('../src/lib/garments.ts');

const items = ['상의: 화이트 티셔츠', '하의: 카키 카고 팬츠', '신발: 컨버스 스니커즈', '아우터: 네이비 셔츠 재킷'];
test('all accessory categories are removed even when model labels them as clothing', () => {
  const extras = ['가방: 미니멀 가방', '악세사리: 얇은 벨트', '상의: 실버 목걸이', '모자: 블랙 볼캡', '신발: 흰 양말', '액세서리: 미니백', 'watch: silver', '상의: sunglasses'];
  assert.deepEqual(normalizeCoreOutfitItems([...items, ...extras]), items);
  for (const item of extras) assert.equal(coreGarmentCategory(item), null);
});
test('shirt/denim outerwear retains an independent inner top and bottom', () => {
  assert.deepEqual(normalizeCoreOutfitItems(['상의(이너): 흰 티셔츠', '하의: 인디고 청바지', '상의(아우터): 블랙 데님 자켓', '신발: 로퍼']),
    ['상의: 흰 티셔츠', '하의: 인디고 청바지', '아우터: 블랙 데님 자켓', '신발: 로퍼']);
  assert.equal(coreGarmentCategory('블랙 셔츠 재킷'), '아우터');
  assert.equal(coreGarmentCategory('데님 셔츠'), '상의');
});
test('one item per core category, accessory removal from comma and plus joined input', () => {
  assert.deepEqual(normalizeCoreOutfitItems(['상의: 흰 티셔츠 + 미니 가방, 하의: 카고 팬츠', '상의: 블랙 티셔츠', '신발: 컨버스 스니커즈', '아우터: 가디건']),
    ['상의: 흰 티셔츠', '하의: 카고 팬츠', '신발: 컨버스 스니커즈', '아우터: 가디건']);
});
test('legacy concept sanitization removes accessory descriptions without mutating identity or old image', () => {
  const original = { id: 'old', name: '가방 포인트', description: '체크 셔츠와 팬츠. 미니 가방을 더해요.', outfitItems: [...items, '가방: 크로스백'], refinementRequest: '검정 가방 추가', imageUrl: 'data:old', stylingReason: '벨트로 포인트', colorPalette: ['카키', '블랙'] };
  const result = sanitizeCoreConcept(original);
  assert.equal(result.id, 'old'); assert.equal(result.imageUrl, 'data:old');
  assert.equal(original.outfitItems.length, 5); assert.notEqual(result, original);
  assert.doesNotMatch(JSON.stringify(result), /가방|벨트|크로스백/);
  assert.equal(sanitizeCoreText('성수 내일 캐주얼. 벨트를 더해줘.'), '성수 내일 캐주얼.');
});
let generatedPrompt;
mockModule('@/lib/openai', { IMAGE_MODEL: 'test-image', openai: { images: { generate: async ({ prompt }) => { generatedPrompt = prompt; return { data: [{ b64_json: 'test' }] }; } } }, parseJsonObjectFromText: JSON.parse });
let completion;
mockModule('@/lib/nvidia', { NVIDIA_VISION_MODEL: 'test-vision', NVIDIA_PLAN_MODEL: 'test-plan', getNvidiaClient: () => ({ chat: { completions: { create: (...args) => completion(...args) } } }) });
mockModule('@/lib/log', { agentLog: () => {} });
mockModule('@/lib/shopping-visual', { getCachedLookbookGarments: () => undefined, inspectLookbookGarments: async () => ({ specs: [], status: 'unverified', note: 'offline' }) });
const lookbook = require('../src/app/api/lookbook/route.ts');
test('lookbook boundary strips a saved bag from specification and demands no accessories', async () => {
  completion = async () => { throw Error('vision unavailable'); };
  const response = await lookbook.POST(new Request('http://localhost/api/lookbook', { method: 'POST', body: JSON.stringify({ concept: { id: 'old', name: '체크 룩', description: '상품 BAG-MARKER 크로스백', outfitItems: [...items, '가방: BAG-MARKER 크로스백'], fitStrategy: 'BELT-MARKER 벨트로 포인트', refinementRequest: 'HAT-MARKER 모자 추가' }, trend: 'TREND-MARKER 가방 추천' }) }));
  assert.equal(response.status, 200);
  assert.doesNotMatch(generatedPrompt, /BAG-MARKER|BELT-MARKER|HAT-MARKER|TREND-MARKER/);
  assert.match(generatedPrompt, /No bags, belts, hats/);
  for (const item of items) assert.ok(generatedPrompt.includes(item.split(": ")[1]));
  const body = await response.json(); assert.equal(body.verified, false); assert.ok(body.imageUrl);
});
const refine = require('../src/app/api/refine/route.ts');
test('refinement strips accessory output before forwarding the lookbook request', async () => {
  completion = async () => ({ choices: [{ message: { content: JSON.stringify({ concept: { outfitItems: [...items, '액세서리: 블랙 가방'], description: '벨트 포인트' }, reply: '가방을 더했어요.', changed: ['가방 추가'] }) } }] });
  let forwarded;
  const oldFetch = global.fetch;
  global.fetch = async (_, init) => { forwarded = JSON.parse(init.body); return Response.json({ imageUrl: 'data:updated', verified: false }); };
  try {
    const response = await refine.POST(new Request('http://localhost/api/refine', { method: 'POST', body: JSON.stringify({ concept: { id: 'old', outfitItems: items }, feedback: '다른 건 유지하고 검정색 데님 자켓 추가', trend: '벨트 포인트 스타일' }) }));
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(forwarded), /가방|벨트/);
    assert.equal(forwarded.concept.garmentSpecs.find(spec => spec.category === '상의').item, '화이트 티셔츠');
    assert.ok(forwarded.concept.outfitItems.some((item) => item.startsWith('아우터:') && item.includes('데님 자켓')));
    assert.equal(forwarded.concept.outfitItems.length, 4);
  } finally { global.fetch = oldFetch; }
});


test('half-zip tops and court sneakers are not mistaken for accessories or coats', () => {
  assert.equal(coreGarmentCategory('상의: 반지퍼 니트'), '상의');
  assert.equal(coreGarmentCategory('신발: 나이키 코트 스니커즈'), '신발');
  assert.deepEqual(normalizeCoreOutfitItems([{ category: '상의', item: '반지퍼 니트' }, { category: '아우터', name: '검정 데님 자켓' }]), ['상의: 반지퍼 니트', '아우터: 검정 데님 자켓']);
});
