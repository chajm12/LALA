/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockModule } = require('./register-ts.cjs');
let call;
mockModule('@/lib/openai',{openai:{responses:{create:(...args)=>call(...args)}},OPENAI_SHOPPING_MODEL:'test',OPENAI_SERVICE_TIER:'priority',parseJsonObjectFromText:JSON.parse});
const {evidenceMatches}=require('../src/lib/shopping-products.ts');
const {applyVisualResults,inspectLookbookGarments,isLookbookDataImage,getCachedLookbookGarments}=require('../src/lib/shopping-visual.ts');
const {isProductImageUrl,fetchShoppingDocument}=require('../src/lib/shopping-fetch.ts');
const ev=(title)=>({title,description:'',brand:'',color:'',category:'',unavailable:false});
const requirement=(category,item,attrs={})=>({category,item,raw:`${category}: ${item}`,...attrs});

test('user visual mismatch regressions exclude camo, wrong sneaker color, printed vest, track trousers and halfzip polo',()=>{
  const cases=[
    [requirement('하의','카고 팬츠',{color:'카키',pattern:'무지'}),'디키즈 카고 팬츠 Dyed Camo'],
    [requirement('신발','뉴발란스 574',{color:'그레이',brand:'뉴발란스',model:'574'}),'뉴발란스 574 WHITE'],
    [requirement('상의','니트',{color:'버건디',pattern:'무지',sleeve:'긴팔'}),'웨이브 프린팅 니트 베스트 BLACK'],
    [requirement('하의','치노 팬츠',{color:'베이지'}),'블랙 트랙 와이드 팬츠'],
    [requirement('상의','셔츠',{color:'차콜',sleeve:'긴팔',closure:'버튼',material:'우븐'}),'차콜 하프집업 반팔 니트 폴로 셔츠'],
    [requirement('하의','스트레이트 데님 팬츠',{color:'블랙',material:'데님'}),'차콜 스트레이트 스웨트 팬츠'],
    [requirement('아우터','트렌치코트',{color:'카키'}),'카멜 트렌치코트'],
  ];
  for(const [wanted,title] of cases) assert.equal(evidenceMatches(wanted,ev(title)),false,title);
});
test('vest and solid cargo remain valid exact families; unknown attributes are left for visual verification',()=>{
  assert.ok(evidenceMatches(requirement('아우터','경량 베스트',{color:'네이비',sleeve:'민소매'}),ev('네이비 경량 패딩 조끼')));
  assert.ok(evidenceMatches(requirement('하의','카고 팬츠',{color:'카키',pattern:'무지'}),ev('카키 카고 팬츠')));
  assert.ok(evidenceMatches(requirement('신발','뉴발란스 574',{color:'그레이'}),ev('뉴발란스 574 SILVER')));
  assert.ok(evidenceMatches(requirement('상의','니트',{color:'버건디',sleeve:'긴팔'}),ev('와인 크루넥 니트')));
});
test('specific model numbers cannot drift even if brand and generic sneaker match',()=>{
  assert.equal(evidenceMatches(requirement('신발','뉴발란스 574',{brand:'뉴발란스',model:'574'}),ev('뉴발란스 530 그레이')),false);
});
const products=[{kind:'product',category:'상의',item:'긴팔 니트',title:'와인 니트',url:'https://www.musinsa.com/products/1',source:'musinsa.com',reason:''}];
test('image mismatches are removed and unknown/malformed comparisons never gain verification',()=>{
  assert.equal(applyVisualResults(products,[{index:0,category:'상의',status:'mismatch',majorMismatch:true,differences:['민소매']}]).length,0);
  for(const row of [{index:0,status:'match',visible:'true',majorMismatch:'false'},{index:0,category:'상의',status:'unknown'},{index:0,category:'하의',status:'match',visible:true,majorMismatch:false}]) assert.equal(applyVisualResults(products,[row])[0].visualStatus,'unverified');
  assert.equal(applyVisualResults(products,[{index:0,category:'상의',status:'match',visible:true,majorMismatch:false,differences:[]}])[0].visualStatus,'verified');
});
test('only explicit safe lookbook data images and known product CDNs are accepted',()=>{
  assert.ok(isLookbookDataImage('data:image/png;base64,YQ=='));
  for(const image of ['https://127.0.0.1/pic','data:image/svg+xml;base64,YQ==','data:image/png;base64,***']) assert.equal(isLookbookDataImage(image),false);
  assert.ok(isProductImageUrl('https://image.msscdn.net/images/goods_img/x.jpg'));
  for(const url of ['http://127.0.0.1/a.jpg','https://msscdn.net.evil.test/x.jpg','https://user:pass@image.msscdn.net/a.jpg','https://image.msscdn.net:8000/x.jpg']) assert.equal(isProductImageUrl(url),false);
});
test('actual image observation cached by image AND specification; old client metadata cannot impersonate a picture',async()=>{
  let count=0;
  call=async()=>{count++;return{output_text:JSON.stringify({specs:[{category:'상의',item:'니트',color:'버건디',sleeve:'긴팔',pattern:'무지'}]})};};
  const image='data:image/png;base64,Ym9ndXM=';const specs=[{category:'상의',item:'니트'}];
  const first=await inspectLookbookGarments(image,specs);await inspectLookbookGarments(image,specs);
  assert.equal(first.specs[0].color,'버건디');assert.equal(count,1); assert.equal(getCachedLookbookGarments(image,[{item:'니트',category:'상의'}]).specs[0].color,'버건디'); assert.equal(count,1);
  await inspectLookbookGarments(image,[{category:'상의',item:'셔츠'}]);assert.equal(count,2);
  await inspectLookbookGarments('data:image/png;base64,Ym9ndXMy',specs);assert.equal(count,3);
});
test('shared page pool deduplicates concurrent requests and bounds active fetches',async()=>{
  const original=global.fetch;let count=0,active=0,peak=0;
  global.fetch=async()=>{count++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,15));active--;return new Response('<html>product</html>',{headers:{'content-type':'text/html'}});};
  try {
    const signal=AbortSignal.timeout(5000);
    const hosts=["www.musinsa.com","www.29cm.co.kr","kream.co.kr","www.uniqlo.com","www.nike.com","www.adidas.com"];
    const values=await Promise.all(Array.from({length:12},(_,i)=>fetchShoppingDocument(`https://${hosts[Math.floor(i/2)]}/products/${700000+Math.floor(i/2)}`,false,signal)));
    assert.equal(count,6);assert.equal(peak,3);assert.ok(values.every(value=>value?.text));
  } finally {global.fetch=original;}
});
test('429 creates host cooldown and does not hammer the retailer with repeated requests',async()=>{
  const original=global.fetch;let count=0;
  global.fetch=async()=>{count++;return new Response('rate limit',{status:429,headers:{'retry-after':'10'}});};
  try {const signal=AbortSignal.timeout(5000);await fetchShoppingDocument('https://www.ssfshop.com/products/9600001',false,signal);await fetchShoppingDocument('https://www.ssfshop.com/products/9600002',false,signal);assert.equal(count,1);} finally {global.fetch=original;}
});

test('solid basic Printstar brand name is not mistaken for graphic print pattern',()=>{
  assert.ok(evidenceMatches(requirement('상의','티셔츠',{pattern:'무지',color:'화이트',sleeve:'반팔'}),ev('프린트스타(PRINTSTAR) 기본 무지 반팔 티셔츠 화이트')));
});

test('jersey knit textile on a tee is not a sweater garment-family requirement',()=>{
  assert.ok(evidenceMatches(requirement('상의','반팔 티셔츠',{color:'화이트',material:'knit',pattern:'무지',sleeve:'반팔'}),ev('화이트 코튼 기본 무지 반팔 티셔츠')));
  assert.equal(evidenceMatches(requirement('상의','크루넥 니트',{material:'니트',color:'화이트'}),ev('화이트 기본 무지 반팔 티셔츠')),false);
});
