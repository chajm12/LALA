/* eslint-disable @typescript-eslint/no-require-imports */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
require('./register-ts.cjs');
const { callInternalJson } = require('../src/lib/internal-route-client.ts');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const request = (signal) => new Request('http://offline.test/api/agent', { signal });

test('shopping deadline ends a stalled connection and aborts upstream', async () => {
  let signal;
  global.fetch = (_, options) => { signal = options.signal; return new Promise(() => {}); };
  await assert.rejects(callInternalJson(request(), '/api/shopping', {}, { timeoutMs: 20, timeoutMessage: '상품 검색 시간 초과' }), /상품 검색 시간 초과/);
  assert.equal(signal.aborted, true);
});

test('shopping deadline also bounds a stalled JSON body', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
  await assert.rejects(callInternalJson(request(), '/api/shopping', {}, { timeoutMs: 20 }), /시간이 초과/);
});

test('client cancellation propagates to the internal request', async () => {
  const parent = new AbortController();
  let signal;
  global.fetch = (_, options) => { signal = options.signal; return new Promise(() => {}); };
  const result = callInternalJson(request(parent.signal), '/api/shopping', {});
  parent.abort();
  await assert.rejects(result, /취소/);
  assert.equal(signal.aborted, true);
});

test('an already cancelled request makes no network call', async () => {
  const parent = new AbortController(); parent.abort();
  global.fetch = () => { throw Error('Unexpected network'); };
  await assert.rejects(callInternalJson(request(parent.signal), '/api/shopping', {}), /취소/);
});

test('valid JSON response is returned and completed call detaches abort listener', async () => {
  const parent = new AbortController();
  let signal;
  global.fetch = async (_, options) => { signal = options.signal; return Response.json({ links: [] }); };
  assert.deepEqual(await callInternalJson(request(parent.signal), '/api/shopping', {}, { timeoutMs: 100 }), { links: [] });
  parent.abort(); assert.equal(signal.aborted, false);
});

test('an HTML error is reported without parsing or leaking its body', async () => {
  global.fetch = async () => new Response('<!DOCTYPE html><html>private error detail</html>', { status: 500 });
  await assert.rejects(callInternalJson(request(), '/api/shopping', {}), error => /HTTP 500/.test(error.message) && !/private/.test(error.message));
});
