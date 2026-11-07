/**
 * Dice's cloud entry: the one Lambda a browser reaches, declared as the
 * `static` handler in `starkeep.manifest.json`.
 *
 * The platform's web adapter strips the `/apps/dice` mount, converts API
 * Gateway events to and from web `Request`/`Response`, and hands every request
 * to the same Hono app the local surface runs. Nothing is served from disk
 * ahead of the app (`staticPaths` is empty, as the manifest's
 * `staticAssetPaths` says), so every path passes the manifest's gate first.
 *
 * `requestUpstream` is a started import, not a thunk: the module graph loads
 * during Lambda's INIT phase, as `createWebAppHandler` requires.
 *
 * `scripts/bundle.mjs` bundles this file to `index.mjs` at the root of the zip
 * and stages the Flutter build beside it at `web/`.
 */

import { createWebAppHandler } from "@starkeep/app-client/web";
import { honoUpstream } from "@starkeep/app-client/hono";

export const handler = await createWebAppHandler({
  basePath: process.env.STARKEEP_APP_BASE_PATH,
  // Flutter's output is not content-hashed, so nothing is cached forever.
  immutablePaths: [],
  requestUpstream: import("./app.mjs").then((m) => ({
    handler: honoUpstream(m.createApp({ webDir: new URL("./web/", import.meta.url) })),
  })),
  // Answered rather than thrown: a thrown Lambda error becomes a bare 502 with
  // nothing in the response to say what failed.
  onError: (err) => ({
    statusCode: 500,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: `dice static handler: ${String(err)}` }),
  }),
});
