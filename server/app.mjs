/**
 * Dice's server half, as a Hono app.
 *
 * Dice is a static Flutter web build that plays entirely in the browser: it
 * reads and writes nothing in Starkeep. The server half is therefore the
 * routes every Starkeep app must carry, a sign-in page for the cloud surface,
 * and a file server for the bundle in `web/`.
 *
 * Routes are app-relative, as `docs/authoring-an-app.md` asks. The one place
 * that needs the mount prefix is the bundle's `<base href>`, which a browser
 * resolves itself, so it is filled in from `appBasePath()` when `index.html`
 * is served (empty locally, `/apps/dice` under the cloud adapter).
 *
 * Locally there is no sign-in: the person at the keyboard owns the machine.
 * In the cloud (`STARKEEP_APP_CLIENT_MODE=cloud`) the gateway's session
 * authorizer gates every path the manifest does not list as public, and the
 * root answers a sign-in page to anyone without a session.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createDataProxyHandler, createRuntimeConfigHandler, sessionAuth } from "@starkeep/app-client";
import { createSessionRoutes, mintIdToken, signInAddress } from "@starkeep/app-client/auth";
import { appBasePath, honoOriginGate } from "@starkeep/app-client/hono";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { signInPage } from "./sign-in.mjs";

/** The app id, fixed to match `starkeep.manifest.json`. */
export const APP_ID = manifest.id;

/** The Flutter web build, served as files, when nothing else is named. */
export const DEFAULT_WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");

/** What the manifest declares reachable without a session, read not copied. */
const STATIC_HANDLER = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
export const PUBLIC_PATHS = STATIC_HANDLER?.publicPaths ?? [];

const SIGN_IN_PATH = "/sign-in";

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
  ".gz": "application/gzip",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function isCloud() {
  return process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
}

function acceptsGzip(acceptEncoding) {
  return /(^|,)\s*(gzip|\*)\s*(;|,|$)/i.test(acceptEncoding ?? "");
}

/**
 * Build the app. `webDir` is where the Flutter build lives: the checkout's
 * `web/` locally, and `web/` beside the bundled entry in the cloud zip.
 */
export function createApp({ webDir = DEFAULT_WEB_DIR } = {}) {
  const WEB_DIR = (webDir instanceof URL ? fileURLToPath(webDir) : resolve(webDir)).replace(
    /[/\\]+$/,
    "",
  );
  const app = new Hono();

  // Deny-by-default over the manifest's own public paths. Inert locally; in
  // the cloud the gateway's session authorizer refuses first, and this stays
  // as the gate an app served outside the gateway would still have.
  app.use("*", honoOriginGate({ publicPaths: PUBLIC_PATHS, signInPath: SIGN_IN_PATH }));

  // Required by the platform: tells a browser build whether it is paired with
  // a cloud data server or the local one. Dice never asks, but the route is
  // part of the contract, and the sign-in flow reads the pool ids from it.
  const runtimeConfig = createRuntimeConfigHandler();
  app.get("/starkeep-runtime-config", () => runtimeConfig());

  // The platform's session routes: `/api/session` (probe), `/refresh`,
  // `/sign-out`, `/token`. Public at the gateway so a browser whose hour-long
  // token lapsed can mint a new one from its month-long session cookie.
  const sessionRoutes = createSessionRoutes({ appId: APP_ID });
  const session = (c) => {
    const action = c.req.path.slice("/api/session".length).split("/").filter(Boolean);
    const ctx = { params: Promise.resolve({ action }) };
    if (c.req.method === "POST") return sessionRoutes.POST(c.req.raw, ctx);
    if (c.req.method === "GET") return sessionRoutes.GET(c.req.raw, ctx);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  };
  app.all("/api/session", session);
  app.all("/api/session/*", session);

  // Required by the platform: the signing proxy, the browser's only route to
  // the data plane. Dice declares no grants and never calls it, so the most it
  // can reach is nothing; `sessionAuth()` keeps it closed to anonymous callers
  // on the cloud surface all the same.
  const proxy = createDataProxyHandler({ appId: APP_ID, endUserAuth: sessionAuth() });
  app.all("/api/local-data/*", (c) => {
    const path = c.req.path.slice("/api/local-data/".length).split("/").filter(Boolean);
    return proxy(c.req.raw, { params: Promise.resolve({ path }) });
  });

  /** The app root as a browser sees it, with the trailing slash sign-in returns to. */
  const home = () => `${appBasePath()}/`;

  /** `index.html` with the mount prefix written into Flutter's `<base href>`. */
  async function shell(setCookies = []) {
    const html = await readFile(resolve(WEB_DIR, "index.html"), "utf8");
    const headers = new Headers({ "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
    for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
    return new Response(html.replace(/<base href="[^"]*">/, `<base href="${home()}">`), { headers });
  }

  /**
   * Who is asking, in the cloud. `mintIdToken` verifies the token cookie and,
   * when it has lapsed, mints a fresh one from the session cookie and hands
   * back the `Set-Cookie` to echo. Null is nobody: no cookies, or spent ones.
   */
  async function visitor(req) {
    try {
      return await mintIdToken(req, APP_ID);
    } catch {
      return null;
    }
  }

  // The root. Locally it is the game. In the cloud it is the game for a
  // signed-in person and the sign-in page for anyone else, so the one path the
  // platform's redirect sends a bookmark to always answers something useful.
  const root = async (c) => {
    if (!isCloud()) return shell();
    const who = await visitor(c.req.raw);
    if (!who) return signInPage(signInAddress(APP_ID, home()));
    return shell(who.setCookie ? [who.setCookie] : []);
  };
  app.get("/", root);
  app.get("/index.html", root);

  // Where the platform's edge sends a document load that carries no token. A
  // person whose token merely lapsed is sent home with a fresh one; everyone
  // else gets the page with the button.
  app.get(SIGN_IN_PATH, async (c) => {
    const who = isCloud() ? await visitor(c.req.raw) : null;
    if (!isCloud() || who) {
      const headers = new Headers({ Location: home(), "Cache-Control": "no-store" });
      if (who?.setCookie) headers.append("Set-Cookie", who.setCookie);
      return new Response(null, { status: 302, headers });
    }
    return signInPage(signInAddress(APP_ID, home()));
  });

  // Everything else under GET is a file from the bundle, or a 404. No SPA
  // fallback: Dice routes with the URL fragment (`#/...`), so every real
  // navigation lands on `/`.
  //
  // A file may ship with a pre-compressed `.gz` sibling (the cloud bundle
  // writes one for each large binary, because a Lambda answer is capped at
  // 6 MB and CanvasKit is bigger than that uncompressed). When the browser
  // accepts gzip, the sibling is sent as is with `Content-Encoding`.
  app.get("*", async (c) => {
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
    const file = resolve(WEB_DIR, rel);
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + sep)) {
      return c.json({ error: "Not found" }, 404);
    }
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    // Flutter's output is not content-hashed, so nothing is cached forever.
    const headers = { "Content-Type": type, "Cache-Control": "no-cache" };

    if (acceptsGzip(c.req.header("accept-encoding"))) {
      const gz = await stat(`${file}.gz`).catch(() => null);
      if (gz?.isFile()) {
        return new Response(await readFile(`${file}.gz`), {
          headers: { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" },
        });
      }
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return c.json({ error: `Dice has no file at ${c.req.path}` }, 404);
    return new Response(await readFile(file), { headers });
  });

  return app;
}

/** The local surface's app, serving the checkout's `web/`. */
export const app = createApp();
