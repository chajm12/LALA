/* eslint-disable @typescript-eslint/no-require-imports */
const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {mockModule}=require('./register-ts.cjs');
let respond;
mockModule('@/lib/openai',{openai:{responses:{create:(...args)=>respond(...args)}},OPENAI_SHOPPING_MODEL:'test',OPENAI_SERVICE_TIER:'priority',parseJsonObjectFromText:JSON.parse});
mockModule('@/lib/log',{agentLog:()=>{}});
const shopping=require('../src/app/api/shopping/route.ts').POST;
const originalFetch=global.fetch;
afterEach(()=>{global.fetch=originalFetch;});
const request=body=>new Request('http://offline.test/shopping',{method:'POST',body:JSON.stringify(body)});
const output=value=>({output_text:JSON.stringify(value)});
const page=(name,id)=>new Response(`<script type="application/ld+json">${JSON.stringify({'@type':'Product',name,url:`https://www.musinsa.com/products/${id}`,image:`https://image.msscdn.net/images/${id}.png`,offers:{availability:'https://schema.org/InStock'}})}</script>`,{headers:{'content-type':'text/html'}});

test('legacy image supplies per-item attributes and stale supplied observations cannot change them',async()=>{
  let web=0,compared=0;
  respond=async input=>{
    if(typeof input.input==='string'){
      web++;assert.match(input.input,/카키/);assert.match(input.input,/무지/);assert.ok(!input.input.includes('"color":"블랙"'));
      return output({links:[{requirementIndex:0,url:'https://www.musinsa.com/products/997001'},{requirementIndex:0,url:'https://www.musinsa.com/products/997002'}]});
    }
    const prompt=input.input[0].content[0].text;
    if(prompt.includes('실제 보이는 옷')) return output({specs:[{category:'하의',item:'카고 팬츠',color:'카키',pattern:'무지',length:'긴바지',material:'직물'}]});
    compared++;return output({comparisons:[{index:0,category:'하의',status:'match',visible:true,majorMismatch:false,differences:[]}]});
  };
  global.fetch=async url=>String(url).includes('msscdn.net')?new Response(Buffer.from('image'),{headers:{'content-type':'image/png'}}):page(String(url).includes('997001')?'카키 Dyed Camo 카고 팬츠':'카키 무지 코튼 카고 팬츠',String(url).includes('997001')?'997001':'997002');
  const body=await(await shopping(request({concept:{name:'legacy',outfitItems:['하의: 카고 팬츠'],colorPalette:['블랙']},imageUrl:'data:image/png;base64,aW1hZ2Ux',imageGarmentSpecs:[{category:'하의',item:'카고 팬츠',color:'블랙',pattern:'카모'}]}))).json();
  assert.equal(body.links.length,1);assert.equal(body.links[0].url,'https://www.musinsa.com/products/997002');assert.equal(body.links[0].visualStatus,'verified');assert.equal(web,1);assert.equal(compared,1);
});

test('photo mismatch is rejected and a real replacement is searched within the second batch',async()=>{
  let web=0,compare=0;
  respond=async input=>{
    if(typeof input.input==='string'){web++;return output({links:[{requirementIndex:0,url:`https://www.musinsa.com/products/${998000+web}`}]});}
    const prompt=input.input[0].content[0].text;
    if(prompt.includes('실제 보이는 옷'))return output({specs:[{category:'상의',item:'크루넥 니트',color:'버건디',pattern:'무지',sleeve:'긴팔'}]});
    compare++;return output({comparisons:[{index:0,category:'상의',status:compare===1?'mismatch':'match',visible:true,majorMismatch:compare===1,differences:compare===1?['사진은 민소매 프린트']:[]}]});
  };
  global.fetch=async url=>String(url).includes('msscdn.net')?new Response(Buffer.from('image'),{headers:{'content-type':'image/png'}}):page('버건디 크루넥 니트',String(url).includes('998001')?'998001':'998002');
  const body=await(await shopping(request({concept:{outfitItems:['상의: 니트']},imageUrl:'data:image/png;base64,aW1hZ2Uy'}))).json();
  assert.equal(body.links.length,1);assert.equal(body.links[0].url,'https://www.musinsa.com/products/998002');assert.equal(body.links[0].visualStatus,'verified');assert.equal(web,2);assert.equal(compare,2);assert.deepEqual(body.rejectedProductUrls,['https://www.musinsa.com/products/998001']);
});
