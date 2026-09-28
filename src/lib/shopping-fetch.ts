import { isShoppingHost, canonicalProductUrl } from "./shopping-products";

const IMAGE_HOSTS = ["msscdn.net", "musinsa.com", "29cm.co.kr", "kream.co.kr", "pstatic.net", "a-bly.com", "a-bly.net", "converse.co.kr", "newbalance.co.kr", "uniqlo.com", "image.uniqlo.com", "nike.com", "nikestatic.com", "adidas.com", "adidas.co.kr", "assets.adidas.com", "ssfshop.com", "wconcept.co.kr", "wconceptcdn.com", "eqlstore.com"];
export function isProductImageUrl(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && IMAGE_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)); } catch { return false; }
}
export function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(signal.reason ?? new Error("요청 취소")); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("요청 취소"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
let active = 0;
const queue: (() => void)[] = [];
const cooldown = new Map<string, number>();
export function unavailableShoppingHosts(): string[] { return [...cooldown].filter(([,until]) => until > Date.now()).map(([host]) => host); }
const nextStart = new Map<string, number>();
const cached = new Map<string, {until: number; text?: string; image?: string}>();
const pending = new Map<string, Promise<{text?: string; image?: string} | null>>();
async function slot(signal: AbortSignal) {
  if (active >= 3) await new Promise<void>((resolve, reject) => {
    const start = () => { signal.removeEventListener("abort", cancel); resolve(); };
    const cancel = () => { const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1); reject(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", cancel, {once:true}); queue.push(start);
  });
  else active += 1;
  return () => { const next = queue.shift(); if (next) next(); else active -= 1; };
}
async function pause(ms: number, signal: AbortSignal) {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, {once:true});
  });
}
function hostGroup(url: string) { const hostname = new URL(url).hostname; return hostname.endsWith("musinsa.com") ? "musinsa.com" : hostname; }
async function fetchDocument(initial: string, image: boolean): Promise<{text?: string; image?: string} | null> {
  const release = await slot(AbortSignal.timeout(40_000));
  const signal = AbortSignal.timeout(8_000);
  try {
    let url = initial;
    for (let hop = 0; hop < 4; hop += 1) {
      if (!(image ? isProductImageUrl(url) : canonicalProductUrl(url))) return null;
      const host = hostGroup(url);
      if ((cooldown.get(host) ?? 0) > Date.now()) return null;
      const start = Math.max(Date.now(), nextStart.get(host) ?? 0);
      nextStart.set(host, start + 250);
      await pause(start - Date.now(), signal);
      if ((cooldown.get(host) ?? 0) > Date.now()) return null;
      const response = await bounded(fetch(url, {redirect:"manual", signal, headers:{"User-Agent":"Mozilla/5.0", Accept:image ? "image/jpeg,image/png,image/webp" : "text/html,application/xhtml+xml"}}), signal);
      if (response.status === 429) {
        const retry = response.headers.get("retry-after") ?? "";
        const seconds = Number(retry);
        const wait = retry && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
        cooldown.set(host, Date.now() + Math.max(5_000, Math.min(Number.isFinite(wait) ? wait : 15_000, 120_000)));
        void response.body?.cancel().catch(() => {}); return null;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location"); void response.body?.cancel().catch(() => {});
        if (!location) return null;
        url = new URL(location, url).toString(); continue;
      }
      const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!response.ok || !(image ? /^image\/(?:jpeg|png|webp)$/.test(mime) : /text\/html|application\/xhtml\+xml/.test(mime))) { void response.body?.cancel().catch(() => {}); return null; }
      const reader = response.body?.getReader(); if (!reader) return null;
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const {done, value} = await bounded(reader.read(), signal); if (done) break;
          const limit = image ? 3_000_000 : 2_000_000;
          if (size + value.byteLength > limit) { if (image) return null; chunks.push(value.slice(0, limit - size)); break; }
          size += value.byteLength; chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      const buffer = Buffer.concat(chunks);
      return image ? {image:`data:${mime};base64,${buffer.toString("base64")}`} : {text:buffer.toString("utf8")};
    }
    return null;
  } catch { return null; } finally { release(); }
}
export async function fetchShoppingDocument(url: string, image: boolean, parent: AbortSignal) {
  if (!(image ? isProductImageUrl(url) : isShoppingHost(url))) return null;
  const key = (image ? "image:" : "page:") + url;
  const hit = cached.get(key); if (hit && hit.until > Date.now()) return hit;
  let task = pending.get(key);
  if (!task) {
    task = fetchDocument(url, image).then(value => {
      if (value) cached.set(key, {...value, until:Date.now()+300_000});
      if (cached.size > 120) cached.delete(cached.keys().next().value!);
      return value;
    }).catch(() => null).finally(() => pending.delete(key));
    pending.set(key, task);
  }
  return bounded(task, parent);
}
