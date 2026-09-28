/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-ts.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  conceptFingerprint, createShoppingRequestRegistry, patchMatchingVariant,
  restoredShoppingState, withShoppingDeadline,
} = require('../src/lib/shopping-client.ts');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fixture = () => Array.from({ length: 5 }, (_, index) => ({
  concept: { id: 'look-' + index, outfitItems: ['상의: 티셔츠 ' + index] },
  imageUrl: 'image-' + index, shoppingLoading: false, shoppingLinks: [],
}));

test('five responses out of order preserve all products, images, and latest history', async () => {
  const registry = createShoppingRequestRegistry();
  let current = fixture(), history = fixture();
  const originalImages = current.map(item => item.imageUrl);
  const requests = current.map((variant, index) => {
    const fingerprint = conceptFingerprint(variant.concept);
    const token = registry.begin('run-a:' + index, fingerprint);
    const response = deferred();
    const patch = update => {
      current = patchMatchingVariant(current, fingerprint, update);
      history = patchMatchingVariant(history, fingerprint, update);
    };
    patch({ shoppingLoading: true });
    const completion = withShoppingDeadline(() => response.promise, token.controller, 1000)
      .then(value => { if (registry.isCurrent(token)) patch({ shoppingLinks: [value] }); })
      .finally(() => { if (registry.isCurrent(token)) { patch({ shoppingLoading: false }); registry.finish(token); } });
    return { response, completion };
  });
  for (const index of [4, 0, 3, 1, 2]) {
    requests[index].response.resolve('product-' + index);
    await requests[index].completion;
    assert.equal(current[index].shoppingLoading, false);
  }
  assert.deepEqual(current.map(item => item.shoppingLinks[0]), ['product-0', 'product-1', 'product-2', 'product-3', 'product-4']);
  assert.deepEqual(current, history);
  assert.deepEqual(current.map(item => item.imageUrl), originalImages);
});

test('synchronous duplicate clicks create just one request until it completes', () => {
  const registry = createShoppingRequestRegistry();
  const first = registry.begin('run-a:look-1', 'revision-1');
  assert.ok(first);
  assert.equal(registry.begin('run-a:look-1', 'revision-1'), null);
  registry.finish(first);
  assert.ok(registry.begin('run-a:look-1', 'revision-1'));
});

test('one hanging transport settles by deadline without holding other cards or erasing found products', async () => {
  const registry = createShoppingRequestRegistry();
  let variants = fixture();
  variants[2].shoppingLinks = ['previous-product'];
  const tasks = variants.map(async (variant, index) => {
    const fingerprint = conceptFingerprint(variant.concept);
    const token = registry.begin('run:' + index, fingerprint);
    variants = patchMatchingVariant(variants, fingerprint, { shoppingLoading: true });
    try {
      const product = await withShoppingDeadline(() => index === 2 ? new Promise(() => {}) : Promise.resolve('new-product-' + index), token.controller, 20);
      variants = patchMatchingVariant(variants, fingerprint, { shoppingLinks: [product] });
    } catch (error) {
      variants = patchMatchingVariant(variants, fingerprint, { shoppingError: error.message });
    } finally {
      variants = patchMatchingVariant(variants, fingerprint, { shoppingLoading: false });
      registry.finish(token);
    }
  });
  await Promise.all(tasks);
  assert.ok(variants.every(item => item.shoppingLoading === false));
  assert.deepEqual(variants[2].shoppingLinks, ['previous-product']);
  assert.match(variants[2].shoppingError, /시간이 초과/);
  for (const index of [0, 1, 3, 4]) assert.deepEqual(variants[index].shoppingLinks, ['new-product-' + index]);
});

test('refining one card invalidates its old request and leaves others running', async () => {
  const registry = createShoppingRequestRegistry();
  let current = fixture();
  const before = conceptFingerprint(current[0].concept);
  const old = registry.begin('run:0', before), unaffected = registry.begin('run:1', conceptFingerprint(current[1].concept));
  const waiting = withShoppingDeadline(() => new Promise(() => {}), old.controller, 1000);
  registry.cancel('run:0');
  current[0] = { ...current[0], concept: { id: 'look-0', outfitItems: ['상의: 검정 셔츠'] } };
  current = patchMatchingVariant(current, before, { shoppingLinks: ['stale product'] });
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(registry.isCurrent(old), false);
  assert.equal(registry.isCurrent(unaffected), true);
  assert.deepEqual(current[0].shoppingLinks, []);
});

test('reset / restore cancels all old requests even if a new run reuses the same look IDs', async () => {
  const registry = createShoppingRequestRegistry();
  const old = registry.begin('run-a:look-0', 'same');
  const waiting = withShoppingDeadline(() => new Promise(() => {}), old.controller);
  registry.cancelAll();
  const fresh = registry.begin('run-a:look-0', 'same');
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(registry.isCurrent(old), false);
  assert.equal(registry.isCurrent(fresh), true);
  registry.finish(old);
  assert.equal(registry.isCurrent(fresh), true);
});

test('restored history does not revive orphaned loading flags or mutate saved snapshots', () => {
  const saved = fixture().map(item => ({ ...item, shoppingLoading: true }));
  const restored = restoredShoppingState(saved);
  assert.ok(restored.every(item => !item.shoppingLoading));
  assert.ok(saved.every(item => item.shoppingLoading));
  assert.deepEqual(restored.map(item => item.imageUrl), saved.map(item => item.imageUrl));
});

test('deadline includes body parsing, and manual cancel settles an abort-ignoring promise', async () => {
  const first = new AbortController();
  await assert.rejects(withShoppingDeadline(async () => {
    await Promise.resolve({ ok: true });
    return new Promise(() => {});
  }, first, 15), /시간이 초과/);
  assert.equal(first.signal.aborted, true);
  const second = new AbortController();
  const task = withShoppingDeadline(() => new Promise(() => {}), second, 1000);
  second.abort();
  await assert.rejects(task, { name: 'AbortError' });
});

test('retry merges newly found shoes with existing products and clears fulfilled missing categories', () => {
  const { mergeShoppingProducts } = require('../src/lib/shopping-client.ts');
  const previous = [{ category: '상의', item: '흰 티셔츠', url: 'top-old' }, { category: '하의', item: '팬츠', url: 'pants-old' }];
  const incoming = [{ category: '신발', item: '컨버스 스니커즈', url: 'shoes-new' }];
  const merged = mergeShoppingProducts(previous, incoming, ['상의: 흰 티셔츠', '하의: 팬츠', '아우터: 데님 재킷']);
  assert.deepEqual(merged.shoppingLinks.map(item => item.url), ['top-old', 'pants-old', 'shoes-new']);
  assert.deepEqual(merged.shoppingMissingItems, ['아우터: 데님 재킷']);
  const replaced = mergeShoppingProducts(merged.shoppingLinks, [{ category: '상의', item: '흰 티셔츠', url: 'top-new' }], []);
  assert.deepEqual(replaced.shoppingLinks.map(item => item.url), ['top-new', 'pants-old', 'shoes-new']);
});

test('completed visual retry drops old unverified products; provider outage preserves them',()=>{
 const {mergeShoppingProducts}=require('../src/lib/shopping-client.ts');
 const old=[{category:'하의',item:'카고 팬츠',url:'wrong-camo'},{category:'신발',item:'컨버스 스니커즈',url:'verified-shoe',visualStatus:'verified'}];
 const completed=mergeShoppingProducts(old,[],['하의: 무지 카고 팬츠','신발: 컨버스 스니커즈'],['하의','신발']);
 assert.deepEqual(completed.shoppingLinks.map(item=>item.url),['verified-shoe']); assert.deepEqual(completed.shoppingMissingItems,['하의: 무지 카고 팬츠']);
 assert.deepEqual(mergeShoppingProducts(old,[],['하의: 카고 팬츠'],[]).shoppingLinks,old);
});

test('an explicit new photo mismatch removes an older verified product too',()=>{
 const {mergeShoppingProducts}=require('../src/lib/shopping-client.ts');
 const old=[{category:'하의',item:'카고 팬츠',url:'old-mismatch',visualStatus:'verified'}];
 const result=mergeShoppingProducts(old,[],['하의: 카키 카고 팬츠'],['하의'],['old-mismatch']);
 assert.deepEqual(result.shoppingLinks,[]); assert.deepEqual(result.shoppingMissingItems,['하의: 카키 카고 팬츠']);
});
