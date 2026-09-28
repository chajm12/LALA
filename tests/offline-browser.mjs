// Serve compiled browser assets directly into Playwright; no HTTP server is started.
// API mock routes must be registered after this catch-all so they take precedence.
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const defaultBuildDirectory = fileURLToPath(new URL(process.env.LALA_ISOLATED_BUILD === "1" ? "../../.next-quality/" : "../../.next/", import.meta.url));
const contentTypes = {
  ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** Reject encoded traversal, separators, hidden files and unsupported source extensions. */
export function staticAssetPath(pathname, staticDirectory) {
  if (!pathname.startsWith("/_next/static/") || pathname.length > 1000 || /%2f|%5c/i.test(pathname)) return null;
  let suffix;
  try { suffix = decodeURIComponent(pathname.slice("/_next/static/".length)); } catch { return null; }
  const parts = suffix.split("/");
  if (parts.some(part => !part || part.startsWith(".") || !/^[\w.@()[\]-]+$/.test(part))) return null;
  const file = path.resolve(staticDirectory, ...parts);
  return inside(path.resolve(staticDirectory), file) && contentTypes[path.extname(file)] ? file : null;
}

export async function installBrowserAssetRoutes(context, baseUrl, unexpected, options = {}) {
  const offline = options.offline ?? process.env.LALA_OFFLINE_BROWSER === "1";
  const buildDirectory = path.resolve(options.buildDirectory ?? defaultBuildDirectory);
  const staticDirectory = path.join(buildDirectory, "static");
  let document;
  if (offline) {
    // Fail early rather than silently falling back to an existing local server.
    document = await readFile(path.join(buildDirectory, "server", "app", "index.html"));
  }
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    const reject = async () => { unexpected.push(url.href); await route.abort(); };
    if (url.origin !== baseUrl || !["GET", "HEAD"].includes(request.method()) || url.pathname.startsWith("/api/")) return reject();
    if (!offline) return route.continue();
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: document });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
    const file = staticAssetPath(url.pathname, staticDirectory);
    if (!file) return reject();
    try {
      // A symlink/junction inside the asset tree cannot expose another directory.
      const [realRoot, realFile] = await Promise.all([realpath(staticDirectory), realpath(file)]);
      if (!inside(realRoot, realFile)) return reject();
      return await route.fulfill({ status: 200, contentType: contentTypes[path.extname(file)], body: await readFile(realFile) });
    } catch { return reject(); }
  });
  return { mode: offline ? "COMPILED_ASSETS_NO_SERVER" : "EXISTING_LOOPBACK_SERVER" };
}
