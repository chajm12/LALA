/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./register-ts.cjs');
const { isSpecificProductUrl, canonicalProductUrl, readProductEvidence, evidenceMatches } = require('../src/lib/shopping-products.ts');
const page = (product, extra = '') => `<html><meta property="og:title" content="${product.name}"><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', ...product })}</script>${extra}</html>`;

test('retailer detail links include 29cm catalog IDs while excluding lists and private or lookalike hosts', () => {
  for (const url of ['https://www.musinsa.com/products/1234','https://product.29cm.co.kr/catalog/1234','https://www.29cm.co.kr/products/1234','https://kream.co.kr/products/1234','https://m.a-bly.com/goods/1234']) assert.ok(isSpecificProductUrl(url), url);
  for (const url of ['https://www.musinsa.com/search/goods?keyword=컨버스','https://www.29cm.co.kr/catalog','https://www.musinsa.com/products','http://localhost/products/1','https://127.0.0.1/products/1','https://www.musinsa.com.evil.test/products/1','https://user:password@musinsa.com/products/1','https://musinsa.com:9000/products/1']) assert.equal(isSpecificProductUrl(url),false,url);
  assert.equal(canonicalProductUrl('https://www.musinsa.com/products/1234?utm_source=web#description'), 'https://www.musinsa.com/products/1234');
});
test('unrelated soldout option/footer does not exclude available main product', () => {
  const evidence = readProductEvidence(page({ name:'컨버스 척 70 블랙', brand:{ name:'Converse' }, offers:{ price:99000, priceCurrency:'KRW', availability:'https://schema.org/InStock' } }, '<p>품절 상품 보기 · 품절 사이즈 알림 · 추천 상품 Sold out</p>'));
  assert.equal(evidence.unavailable,false); assert.equal(evidence.price,'99,000원');
  assert.ok(evidenceMatches({category:'신발',item:'블랙 컨버스 스니커즈'},evidence));
});
test('actual main product availability excludes sold out without invented availability', () => {
  const evidence = readProductEvidence(page({name:'컨버스 척 70 블랙', offers:{availability:'https://schema.org/OutOfStock'}}));
  assert.equal(evidence.unavailable,true); assert.equal(evidenceMatches({category:'신발',item:'컨버스 스니커즈'}, evidence),false);
});
test('metadata is required, not generic shopping boilerplate', () => {
  assert.equal(readProductEvidence('<html>상품 정보 장바구니</html>'),null);
  assert.equal(readProductEvidence('<meta property="og:title" content="상품을 찾을 수 없습니다"><meta property="og:image" content="https://cdn.test/x.jpg">'),null);
});
test('seller metadata supplies title and image without invented price', () => {
  const evidence=readProductEvidence('<meta content="화이트 코튼 반팔 티셔츠" property="og:title"><meta property="og:image" content="https://cdn.test/shirt.jpg">');
  assert.equal(evidence.title,'화이트 코튼 반팔 티셔츠'); assert.equal(evidence.imageUrl,'https://cdn.test/shirt.jpg'); assert.equal(evidence.price,undefined);
  assert.ok(evidenceMatches({category:'상의',item:'흰 티셔츠'},evidence));
});
test('required brand and color use retrieved evidence, not matching model explanation', () => {
  const evidence=readProductEvidence(page({name:'나이키 화이트 스니커즈'}));
  assert.equal(evidenceMatches({category:'신발',item:'컨버스 스니커즈'},evidence),false);
  assert.equal(evidenceMatches({category:'신발',item:'블랙 나이키 스니커즈'},evidence),false);
  assert.ok(evidenceMatches({category:'신발',item:'화이트 나이키 스니커즈'},evidence));
});
test('wrong garment type cannot cover a different required item', () => {
  const evidence=readProductEvidence(page({name:'블랙 코튼 티셔츠'}));
  assert.equal(evidenceMatches({category:'신발',item:'블랙 스니커즈'},evidence),false);
});

test('a different concrete garment family cannot be accepted from a generic category match', () => {
  const sweater=readProductEvidence(page({name:'화이트 스웨터',description:'흰색 티셔츠와 함께 입기 좋아요'}));
  assert.equal(evidenceMatches({category:'상의',item:'화이트 티셔츠'},sweater),false);
  const jacket=readProductEvidence(page({name:'인디고 데님 재킷',description:'데님 팬츠에 매치하세요'}));
  assert.equal(evidenceMatches({category:'하의',item:'인디고 데님 팬츠'},jacket),false);
});
test('main product page ID must match requested URL and unrelated structured products cannot substitute it', () => {
  const html=page({name:'컨버스 척 70 블랙',url:'https://www.musinsa.com/products/77'});
  assert.equal(readProductEvidence(html,'https://www.musinsa.com/products/88'),null);
  assert.ok(readProductEvidence(html,'https://www.musinsa.com/products/77'));
});

test('joined Korean explicit brand still must match actual product brand', () => {
  const evidence=readProductEvidence(page({name:'나이키 블랙 스니커즈'}));
  assert.equal(evidenceMatches({category:'신발',item:'컨버스스니커즈'},evidence),false);
});
test('new sneaker model numbers may use retrieved Product category, never model guesses', () => {
  const evidence=readProductEvidence(page({name:'뉴발란스 1906 실버',category:'스니커즈'}));
  assert.ok(evidenceMatches({category:'신발',item:'뉴발란스 스니커즈'},evidence));
  const noType=readProductEvidence(page({name:'뉴발란스 1906 실버'}));
  assert.equal(evidenceMatches({category:'신발',item:'뉴발란스 스니커즈'},noType),false);
});
test('unrelated Product schema cannot replace a main product title or availability', () => {
  const evidence=readProductEvidence('<meta property="og:title" content="컨버스 블랙 스니커즈"><meta property="og:image" content="https://cdn.test/main.jpg"><script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'화이트 니트',offers:{availability:'https://schema.org/OutOfStock'}})+'</script>');
  assert.equal(evidence.title,'컨버스 블랙 스니커즈'); assert.equal(evidence.unavailable,false);
});

test('explicit women-only product is excluded for men while unknown or unisex is acceptable', () => {
  const women=readProductEvidence(page({name:'여성 화이트 반팔 티셔츠'}));
  assert.equal(evidenceMatches({category:'상의',item:'화이트 티셔츠',targetGender:'male'},women),false);
  const unisex=readProductEvidence(page({name:'남녀공용 화이트 반팔 티셔츠'}));
  assert.ok(evidenceMatches({category:'상의',item:'화이트 티셔츠',targetGender:'male'},unisex));
});

test('shirt family does not accept sweater or tee even when broad top category matches', () => {
  assert.equal(evidenceMatches({category:'상의',item:'화이트 체크 셔츠'},readProductEvidence(page({name:'화이트 니트 스웨터'}))),false);
  assert.equal(evidenceMatches({category:'상의',item:'화이트 체크 셔츠'},readProductEvidence(page({name:'화이트 티셔츠'}))),false);
  assert.ok(evidenceMatches({category:'상의',item:'화이트 체크 셔츠'},readProductEvidence(page({name:'화이트 옥스포드 셔츠'}))));
});
test('explicit alternative shoe brands allow either actual brand', () => {
  const evidence=readProductEvidence(page({name:'컨버스 척 70 블랙'}));
  assert.ok(evidenceMatches({category:'신발',item:'뉴발란스 또는 컨버스 스니커즈'},evidence));
});
