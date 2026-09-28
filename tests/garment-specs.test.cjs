/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test');
const assert=require('node:assert/strict');
require('./register-ts.cjs');
const {readGarmentSpecs, ensureGarmentSpecs, compareGarmentSpecs}=require('../src/lib/garment-specs.ts');
test('legacy image attributes are never guessed from a global palette',()=>{
 const specs=readGarmentSpecs({colorPalette:['버건디','네이비'],outfitItems:['상의: 니트','하의: 팬츠']});
 assert.equal(specs[0].color,undefined); assert.equal(specs[0].sleeve,undefined); assert.equal(specs[1].pattern,undefined);
});
test('new generation locks each item and repeated normalization preserves it exactly',()=>{
 const concept={outfitItems:['상의: 버건디 무지 긴팔 니트','하의: 카키 카고 팬츠','신발: 그레이 뉴발란스 574 스니커즈','아우터: 네이비 경량 조끼'],colorPalette:['블랙']};
 const once=ensureGarmentSpecs(concept); const twice=ensureGarmentSpecs(once);
 assert.deepEqual(twice,once); assert.deepEqual(ensureGarmentSpecs(twice),once);
 assert.equal(once.garmentSpecs[0].color,'버건디'); assert.equal(once.garmentSpecs[1].pattern,'무지'); assert.equal(once.garmentSpecs[3].sleeve,'민소매');
 assert.equal(once.garmentSpecs[2].model,'574'); assert.equal(concept.outfitItems[1],'하의: 카키 카고 팬츠');
});
test('generation separates woven button shirt and denim from knit polo and sweatpants',()=>{
 const specs=ensureGarmentSpecs({outfitItems:['상의: 차콜 긴팔 루즈핏 셔츠','하의: 블랙 스트레이트 데님 팬츠','아우터: 카키 트렌치 코트']}).garmentSpecs;
 assert.equal(specs[0].closure,'버튼'); assert.equal(specs[0].material,'직물'); assert.equal(specs[1].material,'데님'); assert.equal(specs[2].color,'카키');
});
test('observed color pattern sleeve and missing outer block a matching claim',()=>{
 const expected=ensureGarmentSpecs({outfitItems:['상의: 버건디 긴팔 니트','하의: 카키 카고 팬츠','아우터: 네이비 조끼']}).garmentSpecs;
 const actual=[{...expected[0],color:'블랙',sleeve:'민소매',pattern:'그래픽'},{...expected[1],pattern:'카모플라쥬'}];
 const result=compareGarmentSpecs(expected,actual);
 assert.equal(result.matches,false); assert.equal(result.differences.length,5);
});
test('unseen hidden sleeves stay unverified while equal visible specifications pass',()=>{
 const expected=ensureGarmentSpecs({outfitItems:['상의: 화이트 긴팔 셔츠']}).garmentSpecs;
 assert.equal(compareGarmentSpecs(expected,expected).matches,true);
 assert.equal(compareGarmentSpecs(expected,[{...expected[0],sleeve:undefined}]).matches,false);
});

test('denim shirts and jackets never acquire trouser length',()=>{
 const specs=ensureGarmentSpecs({outfitItems:['상의: 차콜 데님 긴팔 셔츠','아우터: 검정 데님 자켓']}).garmentSpecs;
 assert.ok(specs.every(spec=>!spec.length));
});
test('same color never makes chinos match track pants, or woven shirt match knit polo',()=>{
 assert.equal(compareGarmentSpecs([{category:'하의',item:'치노 팬츠',color:'베이지',material:'코튼'}],[{category:'하의',item:'트랙 팬츠',color:'베이지',material:'스웨트'}]).matches,false);
 assert.equal(compareGarmentSpecs([{category:'상의',item:'버튼 셔츠',material:'직물'}],[{category:'상의',item:'니트 폴로 셔츠',material:'니트'}]).matches,false);
 assert.equal(compareGarmentSpecs([{category:'아우터',item:'집업 재킷',color:'네이비',closure:'집업'}],[{category:'아우터',item:'재킷',color:'남색',closure:'지퍼'}]).matches,true);
});
