/**
 * Dice's server half, as a Hono app.
 *
 * Dice is a static Flutter web build that plays entirely in the browser: it
 * reads and writes nothing in Starkeep. The server half is therefore the two
 * routes every Starkeep app must carry, plus a file server for the bundle in
 * `web/`.
 *
 * Routes are app-relative, as `docs/authoring-an-app.md` asks. The one place
 * that needs the mount prefix is the bundle's `<base href>`, which a browser
 * resolves itself, so it is filled in from `appBasePath()` when `index.html`
 * is served (empty locally, `/apps/dice` under the cloud adapter).
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createDataProxyHandler, createRuntimeConfigHandler, sessionAuth } from "@starkeep/app-client";
import { appBasePath } from "@starkeep/app-client/hono";

/** The app id, fixed to match `starkeep.manifest.json`. */
export const APP_ID = "dice";

/** The Flutter web build, served as files. */
export const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".frag": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".evt": "application/octet-stream",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export const app = new Hono();

// Required by the platform: tells a browser build whether it is paired with a
// cloud data server or the local one. Dice never asks, but the route is part
// of the contract.
const runtimeConfig = createRuntimeConfigHandler();
app.get("/starkeep-runtime-config", () => runtimeConfig());

// Required by the platform: the signing proxy, the browser's only route to the
// data plane. Dice declares no grants and never calls it, so the most it can
// reach is nothing; `sessionAuth()` is still the answer the docs recommend,
// and it keeps the proxy closed to anonymous callers if Dice is ever
// installed in the cloud.
const proxy = createDataProxyHandler({ appId: APP_ID, endUserAuth: sessionAuth() });
app.all("/api/local-data/*", (c) => {
  const path = c.req.path.slice("/api/local-data/".length).split("/").filter(Boolean);
  return proxy(c.req.raw, { params: Promise.resolve({ path }) });
});

/** `index.html` with the mount prefix written into Flutter's `<base href>`. */
async function shell() {
  const html = await readFile(join(WEB_DIR, "index.html"), "utf8");
  const base = `${appBasePath()}/`;
  return new Response(html.replace(/<base href="[^"]*">/, `<base href="${base}">`), {
    headers: { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" },
  });
}

app.get("/", () => shell());
app.get("/index.html", () => shell());

// Everything else under GET is a file from the bundle, or a 404. No SPA
// fallback: Dice routes with the URL fragment (`#/...`), so every real
// navigation lands on `/`.
app.get("*", async (c) => {
  const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
  const file = resolve(WEB_DIR, rel);
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + sep)) {
    return c.json({ error: "Not found" }, 404);
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return c.json({ error: `Dice has no file at ${c.req.path}` }, 404);
  return new Response(await readFile(file), {
    headers: {
      "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      // Flutter's output is not content-hashed, so nothing is cached forever.
      "Cache-Control": "no-cache",
    },
  });
});
