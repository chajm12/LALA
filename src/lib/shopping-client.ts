// Per-card request ownership. No React or server dependencies.
import { coreGarmentCategory } from "./garments";
export type ShoppingRequest = {
  key: string;
  fingerprint: string;
  controller: AbortController;
};

export function createShoppingRequestRegistry() {
  const active = new Map<string, ShoppingRequest>();
  return {
    begin(key: string, fingerprint: string): ShoppingRequest | null {
      if (active.has(key)) return null;
      const request = { key, fingerprint, controller: new AbortController() };
      active.set(key, request);
      return request;
    },
    isCurrent(request: ShoppingRequest) { return active.get(request.key) === request; },
    finish(request: ShoppingRequest) {
      if (active.get(request.key) === request) active.delete(request.key);
    },
    cancel(key: string) {
      const request = active.get(key);
      active.delete(key);
      request?.controller.abort();
    },
    cancelAll() {
      const requests = [...active.values()];
      active.clear();
      for (const request of requests) request.controller.abort();
    },
  };
}

export function conceptFingerprint(concept: object): string {
  return JSON.stringify(concept);
}

// Applied separately to the current UI and current history, never to a snapshot
// captured before an awaited request. Revision matching also protects undo/refine.
export function patchMatchingVariant<T extends { concept: object }>(
  variants: T[], fingerprint: string, patch: Partial<T> | ((variant: T) => Partial<T>),
): T[] {
  return variants.map((variant) => conceptFingerprint(variant.concept) === fingerprint
    ? { ...variant, ...(typeof patch === "function" ? patch(variant) : patch) } : variant);
}

export function restoredShoppingState<T extends { shoppingLoading: boolean }>(variants: T[]): T[] {
  return variants.map((variant) => ({ ...variant, shoppingLoading: false }));
}

// Abort alone cannot stop a broken fetch mock, body reader, or SDK promise.
// Race the entire operation (including JSON parsing) against a wall-clock limit.
export async function withShoppingDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  controller: AbortController,
  timeoutMs = 130_000,
): Promise<T> {
  if (controller.signal.aborted) throw new DOMException("요청을 취소했습니다.", "AbortError");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancelled: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectCancelled = () => reject(new DOMException("요청을 취소했습니다.", "AbortError"));
    controller.signal.addEventListener("abort", rejectCancelled, { once: true });
    timer = setTimeout(() => {
      reject(new Error("상품 검색 시간이 초과됐어요. 찾은 상품은 유지했습니다. 다시 찾기를 눌러 재시도해 주세요."));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener("abort", rejectCancelled);
  }
}

export function mergeShoppingProducts<T extends { category?: string; item: string; visualStatus?: string; url?: string }>(
  previous: T[], incoming: T[], missingItems: string[], searchedCategories: string[] = [], rejectedProductUrls: string[] = [],
): { shoppingLinks: T[]; shoppingMissingItems: string[] } {
  const categoryOf = (product: T) => coreGarmentCategory((product.category ?? "") + ": " + product.item);
  const byCategory = new Map<string, T>();
  // A completed new search invalidates older unverified candidates in those categories.
  // Provider outages omit searchedCategories and preserve all prior results.
  const retained = previous.filter(product => !rejectedProductUrls.includes(product.url ?? "") && (product.visualStatus === "verified" || !searchedCategories.includes(categoryOf(product) ?? "")));
  for (const product of [...retained, ...incoming]) {
    const category = categoryOf(product);
    if (category) byCategory.set(category, product);
  }
  return {
    shoppingLinks: [...byCategory.values()],
    shoppingMissingItems: missingItems.filter(item => {
      const category = coreGarmentCategory(item);
      return !category || !byCategory.has(category);
    }),
  };
}
