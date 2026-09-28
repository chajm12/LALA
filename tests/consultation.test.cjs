/* eslint-disable @typescript-eslint/no-require-imports -- Node test harness uses CommonJS dependency stubs. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockModule } = require('./register-ts.cjs');
const { buildDirectConsultationReply, isGenericConsultationReply } = require('../src/lib/consultation-replies.ts');

let modelCall = async () => { throw new Error('Request was aborted.'); };
mockModule('../src/lib/nvidia.ts', {
  NVIDIA_FAST_MODEL: 'offline-test-model',
  getNvidiaClient: () => ({ chat: { completions: { create: (...args) => modelCall(...args) } } }),
});
mockModule('../src/lib/openai.ts', { parseJsonObjectFromText: value => JSON.parse(value) });
mockModule('../src/lib/log.ts', { agentLog() {} });
const { POST } = require('../src/app/api/consult/route.ts');
const request = body => new Request('http://localhost/api/consult', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const base = { keyword: '성수에서 뉴발란스나 컨버스를 신는 캐주얼룩', stage: 'material', feedback: ['이동이 많아요'] };

test('walking feedback names the actual items rather than promising to reflect it', () => {
  const text = buildDirectConsultationReply(base);
  assert.match(text, /뉴발란스 스니커즈/);
  assert.match(text, /팬츠/);
  assert.match(text, /얇은 겉옷/);
  assert.doesNotMatch(text, /바꿨어|추가했|검증했|100%/);
});

test('adding outerwear preserves a white inner and chooses one delegated option', () => {
  const text = buildDirectConsultationReply({
    keyword: '흰색 무지 티셔츠와 청바지',
    feedback: ['검정색 데님 자켓이나 카멜색 트렌치 코트 중 적절하게 추천해줘'],
    stage: 'material',
  });
  assert.match(text, /흰 티셔츠는 그대로/);
  assert.match(text, /검정색 데님 재킷/);
  assert.doesNotMatch(text, /검정.*티셔츠|구체적으로|어느|\?/);
});

test('no-outer request remains no-outer after mobility feedback', () => {
  const text = buildDirectConsultationReply({
    ...base, keyword: base.keyword + ', 아우터 없이',
  });
  assert.match(text, /겉옷 없이/);
  assert.doesNotMatch(text, /겉옷을 더/);
});

test('negative shoe-brand preference is retained in the local proposal', () => {
  const text = buildDirectConsultationReply({
    ...base, keyword: '뉴발란스 말고 컨버스로 캐주얼룩',
  });
  assert.match(text, /컨버스 스니커즈/);
  assert.doesNotMatch(text, /뉴발란스 스니커즈/);
});

test('unknown specific preference is preserved rather than silently replaced', () => {
  const text = buildDirectConsultationReply({
    ...base, feedback: ['보라색 색감이 포인트였으면 해'],
  });
  assert.match(text, /보라색 색감/);
  assert.doesNotMatch(text, /추가했|바꿨어/);
});

test('a generic planning promise is detected but a concrete recommendation is kept', () => {
  assert.equal(isGenericConsultationReply('말씀해주신 방향을 반영해 서로 다른 룩을 준비할게요.'), true);
  assert.equal(isGenericConsultationReply('여유 있는 팬츠와 얇은 재킷으로 추천해요.'), false);
});

test('model abort returns a useful 200 fallback, without a repeated clarification', async () => {
  modelCall = async () => { throw new Error('Request was aborted.'); };
  const response = await POST(request(base));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.degraded, true);
  assert.equal(result.responseSource, 'local_recommendation');
  assert.equal(result.allowQuickApply, true);
  assert.deepEqual(result.options, []);
  assert.match(result.message, /스니커즈.*팬츠/);
  assert.doesNotMatch(result.message, /다시.*시도|구체적으로/);
});

test('invalid model JSON also offers a labeled local recommendation', async () => {
  modelCall = async () => ({ choices: [{ message: { content: '<html>upstream failure</html>' } }] });
  const response = await POST(request(base));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.degraded, true);
  assert.match(result.notice, /기본 조합/);
});

test('generic model reply is replaced and its needless question is dropped', async () => {
  modelCall = async () => ({ choices: [{ message: { content: JSON.stringify({
    reply: '말씀해주신 방향을 반영해 서로 다른 룩을 준비할게요.',
    question: '원하는 소재를 구체적으로 알려주세요.',
  }) } }] });
  const result = await (await POST(request(base))).json();
  assert.match(result.message, /뉴발란스 스니커즈/);
  assert.equal(result.allowQuickApply, true);
  assert.equal(result.responseSource, 'local_recommendation');
  assert.doesNotMatch(result.message, /구체적으로/);
});

test('delegated recommendation keeps the model choice without asking the user to choose again', async () => {
  modelCall = async () => ({ choices: [{ message: { content: JSON.stringify({
    reply: '흰 티 위에 검정 데님 재킷을 더하는 조합을 추천해요.',
    question: '데님과 트렌치 중 어느 쪽이 좋으세요?',
  }) } }] });
  const result = await (await POST(request({
    ...base, feedback: ['데님 자켓이나 트렌치 코트 중 네가 판단해서 추천해줘'],
  }))).json();
  assert.equal(result.responseSource, 'model');
  assert.equal(result.allowQuickApply, true);
  assert.doesNotMatch(result.message, /어느|\?/);
});

test('invalid input remains a 400 and never becomes a fabricated recommendation', async () => {
  let called = false;
  modelCall = async () => { called = true; throw new Error('must not call'); };
  const response = await POST(request({ keyword: '', stage: 'material' }));
  assert.equal(response.status, 400);
  assert.equal(called, false);
});


test('excluded denim is not chosen over the requested camel trench', () => {
  const text = buildDirectConsultationReply({
    keyword: '흰색 무지 티셔츠와 청바지', stage: 'material',
    feedback: ['데님 자켓 말고 카멜 트렌치 코트를 추천해줘'],
  });
  assert.match(text, /흰 티셔츠는 그대로/);
  assert.match(text, /카멜색 트렌치코트/);
  assert.doesNotMatch(text, /데님 재킷을 더/);
});

test('a new explicit black request can replace an earlier black exclusion', () => {
  const text = buildDirectConsultationReply({
    keyword: '검정색은 제외하고 흰 티를 유지해줘', stage: 'material',
    feedback: ['생각이 바뀌었어. 검정색 데님 자켓 추가해줘'],
  });
  assert.match(text, /검정색 데님 재킷/);
  assert.doesNotMatch(text, /셔츠형 겉옷/);
});

test('excluded wide fit does not replace the requested slim fit', () => {
  const text = buildDirectConsultationReply({
    ...base, feedback: ['와이드 팬츠 말고 슬림 핏으로 해줘'],
  });
  assert.match(text, /슬림 핏/);
  assert.doesNotMatch(text, /와이드 팬츠로 추천/);
});

test('mobility proposal follows the newest explicit fit, not an earlier fit', () => {
  const text = buildDirectConsultationReply({
    ...base, keyword: '와이드 팬츠와 컨버스',
    feedback: ['생각이 바뀌었어. 슬림 핏으로 해줘', '이동이 많아요'],
  });
  assert.match(text, /슬림 팬츠/);
  assert.doesNotMatch(text, /와이드 팬츠/);
});

test('latest explicit shoe preference can replace a prior exclusion', () => {
  const text = buildDirectConsultationReply({
    ...base, keyword: '뉴발란스는 제외하고 컨버스로',
    feedback: ['이번에는 뉴발란스로 해줘', '이동이 많아요'],
  });
  assert.match(text, /뉴발란스 스니커즈/);
});

test('negative pattern preference does not add a pattern', () => {
  const text = buildDirectConsultationReply({
    ...base, feedback: ['패턴 없이 해줘'],
  });
  assert.doesNotMatch(text, /패턴이나 질감으로 포인트/);
  assert.match(text, /패턴 없이/);
});


test('previous accessory preference is superseded by core garment scope', () => {
  const text = buildDirectConsultationReply({ ...base, feedback: ['보라색 양말과 가방을 추가해줘'] });
  assert.match(text, /상의·하의·신발/);
  assert.doesNotMatch(text, /양말|가방/);
});
