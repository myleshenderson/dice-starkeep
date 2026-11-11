/**
 * Dice's server half, as a Hono app.
 *
 * Dice is a static Flutter web build that plays entirely in the browser: it
 * reads and writes nothing in Starkeep. The server half is therefore the shell,
 * the platform's session routes and a sign-in page for the cloud surface, and
 * the platform's static responder for the build's files in `web/`.
 *
 * The build lives under `web/_static/`, except `index.html` (the shell, at the
 * root) and `web/pkg/` (the Rust engine, whose path `main.dart.js` fixes at
 * `pkg/`). In the cloud, CloudFront serves `/_static/*` from S3, so those
 * requests never reach this app; locally, `serveStatic` answers them.
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

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createSessionRoutes, mintIdToken, signInAddress } from "@starkeep/app-client/auth";
import { appBasePath, honoOriginGate, serveStatic } from "@starkeep/app-client/hono";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { signInPage } from "./sign-in.mjs";

/** The app id, fixed to match `starkeep.manifest.json`. */
export const APP_ID = manifest.id;

/** The Flutter web build, served as files, when nothing else is named. */
export const DEFAULT_WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");

/** What the manifest declares reachable without a session, read not copied. */
const STATIC_HANDLER = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
export const PUBLIC_PATHS = STATIC_HANDLER?.publicPaths ?? [];
/**
 * The build files the manifest declares. Locally `serveStatic` answers both
 * prefixes from `web/`; in the cloud only `/pkg/*` reaches this app.
 */
export const STATIC_PATHS = STATIC_HANDLER?.staticAssetPaths ?? [];

const SIGN_IN_PATH = "/sign-in";

export function isCloud() {
  return process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
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

  // The build's files: `/_static/*` and `/pkg/*`, with the platform's content
  // types and revalidation headers. Flutter does not hash its file names, so
  // nothing is cached forever. A declared path with no file is a 404 here.
  app.use(
    "*",
    serveStatic({ assetsDir: WEB_DIR, staticPaths: STATIC_PATHS, immutablePaths: [], staticMiss: "notFound" }),
  );

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

  /** The app root as a browser sees it, with the trailing slash sign-in returns to. */
  const home = () => `${appBasePath()}/`;

  /** `index.html` with the mount prefix written into Flutter's `<base href>`. */
  async function shell(setCookies = []) {
    const html = await readFile(resolve(WEB_DIR, "index.html"), "utf8");
    const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
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

  // Dice routes with the URL fragment (`#/...`), so every real navigation
  // lands on `/`, and any other path is a 404 rather than the shell.
  app.notFound((c) => c.json({ error: `Dice has no file at ${c.req.path}` }, 404));

  return app;
}

/** The local surface's app, serving the checkout's `web/`. */
export const app = createApp();
