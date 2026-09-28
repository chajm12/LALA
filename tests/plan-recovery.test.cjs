/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockModule } = require('./register-ts.cjs');
const { recoverPlanning, createBackupCandidates, explicitConstraintIssues, requestedShoeBrands } = require('../src/lib/plan-recovery.ts');

global.fetch = async () => { throw new Error('Network forbidden in offline tests'); };

const steps = (overrides = {}) => ({
  generate: async () => [{ id: 'original' }], fallback: () => [{ id: 'backup' }],
  validate: (items) => { if (!items.length) throw Error('empty'); },
  evaluate: (items) => items.map(({ id }) => ({ id, score: 75 })),
  repair: async () => [{ id: 'repaired' }], needsDiversity: () => false,
  ...overrides,
});

test('aborted repair preserves successful candidates and their original evaluation', async () => {
  let calls = 0;
  const result = await recoverPlanning(steps({ repair: async () => { calls++; throw new Error('Request was aborted.'); }, needsDiversity: () => true }));
  assert.equal(result.evaluationStage, 'initial');
  assert.equal(result.candidateSource, 'model');
  assert.deepEqual(result.candidates, result.originalCandidates);
  assert.deepEqual(result.evaluations, result.round1);
  assert.equal(calls, 1, 'must not start another expensive repair after timeout');
  assert.ok(result.warnings.some((warning) => warning.includes('1차 후보')));
});

test('invalid repair preserves initial batch without claiming re-evaluation', async () => {
  const result = await recoverPlanning(steps({ repair: async () => [] }));
  assert.equal(result.evaluationStage, 'initial');
  assert.equal(result.candidates[0].id, 'original');
});

test('diversity repair failure preserves the already repaired batch', async () => {
  const result = await recoverPlanning(steps({ needsDiversity: () => true, repair: async (_, __, diversity) => {
    if (diversity) throw Error('aborted'); return [{ id: 'repaired' }];
  } }));
  assert.equal(result.candidates[0].id, 'repaired');
  assert.equal(result.evaluationStage, 'repaired');
  assert.ok(result.warnings.some((warning) => warning.includes('차이를 더 넓히는')));
});

test('generation outage returns labelled local fallback without retrying remote repair', async () => {
  const result = await recoverPlanning(steps({ generate: async () => { throw Error('503'); }, repair: async () => { assert.fail('no remote repair after generation outage'); } }));
  assert.equal(result.candidateSource, 'local_fallback');
  assert.equal(result.evaluationStage, 'fallback');
  assert.equal(result.candidates[0].id, 'backup');
});

test('fallback preserves requested shoe brand alternatives and color exclusions', () => {
  const request = '뉴발란스나 컨버스로 캐주얼룩, 검정색은 제외해줘. 이동이 많아요';
  const candidates = createBackupCandidates(request, { forecastAvailable: true, forecast: { temperatureMin: 13.4, temperatureMax: 24.3 } });
  assert.equal(candidates.length, 5);
  assert.ok(candidates.every((candidate) => explicitConstraintIssues(request, candidate.outfitItems).length === 0));
  assert.ok(candidates.some((candidate) => candidate.outfitItems.some((item) => item.includes('뉴발란스'))));
  assert.ok(candidates.some((candidate) => candidate.outfitItems.some((item) => item.includes('컨버스'))));
  assert.ok(candidates.some((candidate) => candidate.outfitItems.some((item) => item.startsWith('아우터:'))));
  assert.ok(candidates.every((candidate) => !candidate.outfitItems.join(' ').includes('블랙')));
  assert.ok(candidates.every((candidate) => candidate.materials[0].includes('확인 필요')));
});

test('shoe brand rejection is not read as a request and does not exclude a following preference', () => {
  assert.deepEqual(requestedShoeBrands('뉴발란스는 제외해줘. 컨버스를 추천해줘'), ['컨버스']);
  assert.deepEqual(explicitConstraintIssues('블랙 제외, 화이트는 좋아', ['상의: 화이트 티셔츠']), []);
});

test('unfulfillable basic color exclusions are not silently ignored', () => {
  assert.throws(() => createBackupCandidates('블랙 제외. 화이트 제외. 네이비 제외. 베이지 제외. 그레이 제외. 브라운 제외. 카키 제외.', null), /색상/);
});

let completions;
mockModule('@/lib/nvidia', { NVIDIA_PLAN_MODEL: 'test-model', getNvidiaClient: () => ({ chat: { completions: { create: (...args) => completions(...args) } } }) });
mockModule('@/lib/openai', { parseJsonObjectFromText: (text) => JSON.parse(text) });
mockModule('@/lib/log', { agentLog: () => {} });
const { POST } = require('../src/app/api/plan/route.ts');
const request = () => new Request('http://localhost/api/plan', { method: 'POST', body: JSON.stringify({ keyword: '성수 캐주얼룩, 뉴발란스나 컨버스. 이동이 많아요', trend: '성수의 캐주얼 스타일. 얇은 겉옷을 입고 벗는 구성을 권합니다.', intent: { occasion: '친구와 약속' }, weather: { forecastAvailable: true, forecast: { temperatureMin: 13.4, temperatureMax: 24.3 } } }) });
const answer = (concepts) => ({ choices: [{ message: { content: JSON.stringify({ concepts }) }, finish_reason: 'stop' }] });

test('route returns HTTP 200, five preserved candidates and two lookbook choices when repair aborts', async () => {
  let calls = 0;
  const fixture = createBackupCandidates('뉴발란스나 컨버스 캐주얼', null);
  completions = async () => { if (++calls > 1) throw Error('Request was aborted.'); return answer(fixture); };
  const response = await POST(request()); const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.planStatus, 'partial'); assert.equal(body.evaluationStage, 'initial');
  assert.equal(body.originalCandidates.length, 5); assert.equal(body.finalConcepts.length, 2);
  assert.deepEqual(body.originalCandidates, body.repairedCandidates);
  assert.equal(body.round2.filter((item) => item.decisionStatus === '선택').length, 2);
  assert.equal(calls, 2);
});

test('route falls back when generation API fails and still returns selectable lookbooks', async () => {
  completions = async () => { throw Error('503'); };
  const response = await POST(request()); const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.candidateSource, 'local_fallback'); assert.equal(body.evaluationStage, 'fallback');
  assert.equal(body.finalConcepts.length, 2);
});

test('successful repair returns no model-written scores and evaluates the actual repaired items locally', async () => {
  let calls = 0;
  completions = async (params) => {
    calls++;
    if (calls > 1) assert.equal(params.max_tokens, 2400);
    return answer(createBackupCandidates('뉴발란스나 컨버스 캐주얼', null));
  };
  const response = await POST(request()); const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.evaluationStage, 'repaired');
  assert.ok(body.round2.every((evaluation) => Number.isFinite(evaluation.totalScore)));
});

test('excluded accessories are never re-added by request normalization on fallback', async () => {
  completions = async () => { throw Error('503'); };
  const req = new Request('http://localhost/api/plan', { method: 'POST', body: JSON.stringify({ keyword: '뉴발란스 캐주얼, 가방과 모자는 제외', trend: '외출', intent: {} }) });
  const response = await POST(req); const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.finalConcepts.every((concept) => !/액세서리|가방|모자|볼캡/.test(concept.outfitItems.join(' '))));
});

test('accepted consultation proposal reaches model context without becoming a hard user condition', async () => {
  const prompts=[];
  completions = async (params) => { prompts.push(params.messages.map((message)=>message.content).join(' ')); return answer(createBackupCandidates('뉴발란스 캐주얼', null)); };
  const req = new Request('http://localhost/api/plan', { method: 'POST', body: JSON.stringify({ keyword: '뉴발란스 캐주얼', trend: '외출', intent: {}, consultationProposal: '가벼운 재킷에 티셔츠와 일자 팬츠를 맞출게요.' }) });
  const response = await POST(req); const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(prompts.every((prompt) => prompt.includes('가벼운 재킷에 티셔츠와 일자 팬츠')));
  assert.ok(prompts.every((prompt) => prompt.includes('임의로 새 필수 조건 추가 금지')));
});

test('model candidates and repair cannot recommend accessories even when history requested them', async () => {
  const candidates = createBackupCandidates('캐주얼룩 컨버스', null).map((candidate) => ({ ...candidate, outfitItems: [...candidate.outfitItems, '가방: 블랙 미니백', '액세서리: 얇은 벨트'], description: '기본 캐주얼. 가방과 벨트로 포인트.', stylingReason: '볼캡으로 포인트' }));
  completions = async () => answer(candidates);
  const response = await POST(new Request('http://localhost/api/plan', { method: 'POST', body: JSON.stringify({ keyword: '캐주얼룩. 이전 요청: 모자와 가방 추가', trend: '가을 캐주얼 스타일', intent: { occasion: '약속' } }) }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  for (const concept of [...body.originalCandidates, ...body.repairedCandidates, ...body.finalConcepts]) {
    assert.ok(concept.outfitItems.length >= 3 && concept.outfitItems.length <= 4);
    assert.doesNotMatch(JSON.stringify(concept), /가방|미니백|벨트|볼캡/);
    for (const category of ['상의', '하의', '신발']) assert.ok(concept.outfitItems.some((item) => item.startsWith(category + ':')));
  }
});

test('new per-item defaults cannot reintroduce an explicitly excluded color', async()=>{
 completions=async()=>answer(createBackupCandidates('캐주얼',null).map(concept=>({...concept,outfitItems:['상의: 티셔츠','하의: 카고 팬츠','신발: 뉴발란스 스니커즈']})));
 const response=await POST(new Request('http://localhost/api/plan',{method:'POST',body:JSON.stringify({keyword:'회색 그레이는 제외하고 뉴발란스 캐주얼룩',trend:'가벼운 일상',intent:{}})}));
 const body=await response.json(); assert.equal(response.status,200);
 for (const concept of body.finalConcepts) { assert.ok(concept.garmentSpecs.length>=3); assert.ok(concept.garmentSpecs.every(spec=>spec.color && !/회색|그레이/.test(spec.color))); }
});
