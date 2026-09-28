/* eslint-disable @typescript-eslint/no-require-imports */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mockModule } = require('./register-ts.cjs');
let search, image, vision;
mockModule('@/lib/openai', {
  OPENAI_SERVICE_TIER: 'priority', OPENAI_SHOPPING_MODEL: 'test', IMAGE_MODEL: 'test',
  openai: { responses: { create: (...args) => search(...args) }, images: { generate: (...args) => image(...args) } },
  parseJsonObjectFromText: (text) => JSON.parse(text),
});
const visual = require('../src/lib/shopping-visual.ts');
mockModule('@/lib/shopping-visual', { ...visual, inspectLookbookGarments: (...args) => vision(...args) });
mockModule('@/lib/log', { agentLog: () => {} });
const shopping = require('../src/app/api/shopping/route.ts').POST;
const lookbook = require('../src/app/api/lookbook/route.ts').POST;
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const concept = { name: '데일리', description: '가벼운 캐주얼', mood: '캐주얼', colorPalette: ['화이트', '인디고'], materials: [], outfitItems: ['상의: 흰 티셔츠', '하의: 인디고 팬츠', '신발: 뉴발란스 스니커즈'] };
const request = (body) => new Request('http://offline.test/api', { method: 'POST', body: JSON.stringify(body) });
function forbidFetch() { global.fetch = () => { throw Error('Unexpected external network'); }; }

test('shopping provider timeout returns missing items and never invents search products', async () => {
  forbidFetch(); let calls=0;
  search = async (_, options) => { calls++; assert.equal(options.maxRetries, 0); throw Error('Request was aborted.'); };
  const response = await shopping(request({ keyword: '캐주얼', concept }));
  const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.status, 'partial');
  assert.deepEqual(data.links,[]); assert.equal(data.missingItems.length,3); assert.equal(calls,2);
});

test('shopping retries missing garments, returns one retrieved product per item, excludes accessories', async () => {
  let calls=0; const prompts=[];
  search = async (input) => {
    calls++; prompts.push(input.input);
    return { output_text: JSON.stringify({ links: calls === 1 ? [{ requirementIndex:0, url:'https://www.musinsa.com/products/88001' },{ requirementIndex:0, url:'https://www.musinsa.com/products/88002' }] : [{ requirementIndex:0, url: input.input.includes('0: 하의:') ? 'https://product.29cm.co.kr/catalog/88003' : 'https://www.musinsa.com/products/88004' }] }) };
  };
  global.fetch = async (url) => {
    const name=String(url).includes('88003')?'인디고 데님 팬츠':String(url).includes('88004')?'뉴발란스 574 스니커즈':'화이트 코튼 티셔츠';
    return new Response(`<meta property="og:title" content="${name}"><script type="application/ld+json">${JSON.stringify({'@type':'Product',name, offers:{ availability:'https://schema.org/InStock' }})}</script><footer>품절 상품 재입고 알림</footer>`,{headers:{'content-type':'text/html'}});
  };
  const data = await (await shopping(request({ concept:{...concept,outfitItems:[...concept.outfitItems,'액세서리: 블랙 가방']} }))).json();
  assert.equal(data.status,'complete'); assert.equal(data.links.length,3); assert.equal(data.missingItems.length,0); assert.equal(calls,3);
  assert.ok(data.links.every(link=>link.kind==='product')); assert.equal(new Set(data.links.map(link=>link.category)).size,3);
  assert.ok(!prompts[1].includes('0: 상의:')); assert.ok(prompts[1].includes('0: 하의:')); assert.ok(prompts[2].includes('0: 신발:')); assert.ok(!prompts[2].includes('1: '));
  assert.ok(!data.links.some(link=>/가방/.test(link.item)));
});

test('malformed shopping JSON returns unresolved item names rather than search pages', async () => {
  forbidFetch(); search = async () => ({ output_text: '{broken}' });
  const data = await (await shopping(request({ concept:{...concept,colorPalette:['검증용 고유 팔레트']} }))).json();
  assert.equal(data.status,'partial'); assert.deepEqual(data.links,[]); assert.equal(data.missingItems.length,3);
});

test('search page or redirected private target is not a product', async () => {
  const searched = { ...concept, colorPalette:['별도검증'],outfitItems:['신발: 컨버스 스니커즈'] };
  search=async()=>({output_text:JSON.stringify({links:[{requirementIndex:0,url:'https://www.musinsa.com/search/goods?keyword=컨버스'},{requirementIndex:0,url:'https://www.musinsa.com/products/88009'}]})});
  let calls=0;
  global.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});};
  const data=await(await shopping(request({concept:searched}))).json();
  assert.deepEqual(data.links,[]); assert.equal(data.missingItems.length,1); assert.equal(calls,1);
});
test('image remains visible on vision timeout', async () => {
  forbidFetch(); image = async () => ({ data: [{ b64_json: 'fixture' }] }); vision = async () => { throw Error('timeout'); };
  const data = await (await lookbook(request({ concept }))).json();
  assert.ok(data.imageUrl); assert.equal(data.verified, false); assert.equal(data.error, null);
});
test('observed wrong color and sleeve are never marked verified', async () => {
  forbidFetch(); image = async () => ({ data: [{ b64_json: 'fixture' }] });
  vision = async (_, specs) => ({ status: 'verified', specs: specs.map(spec => spec.category === '상의' ? {...spec, color:'블랙', sleeve:'민소매', pattern:'그래픽'} : spec) });
  const data = await (await lookbook(request({ concept }))).json();
  assert.ok(data.imageUrl); assert.equal(data.verified, false); assert.ok(data.mismatches.some(value => value.includes('블랙'))); assert.ok(data.mismatches.some(value => value.includes('민소매')));
});
test('empty image response is a finished error, never an endless loading state', async () => {
  forbidFetch(); image = async () => ({ data: [] });
  const data = await (await lookbook(request({ concept }))).json();
  assert.equal(data.imageUrl, null); assert.match(data.error, /이미지가 없습니다/);
});
test('all explicit image checks passing may be marked verified', async () => {
  forbidFetch(); image = async () => ({ data: [{ b64_json: 'fixture' }] });
  vision = async (_, specs) => ({ status: 'verified', specs });
  const data = await (await lookbook(request({ concept }))).json(); assert.equal(data.verified, true);
  assert.equal(data.concept.garmentSpecs.length,3); assert.deepEqual(data.imageGarmentSpecs,data.concept.garmentSpecs);
  assert.equal(data.concept.garmentSpecs[0].color,'화이트'); assert.ok(data.concept.outfitItems[0].includes('반팔'));
});

