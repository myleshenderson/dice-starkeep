# Dice for Starkeep

Dice is a scorecard dice game, and this repository packages its web build as a
[Starkeep](https://github.com/starkeep-org/starkeep-core) app. It is the
backend-less Flutter web build of Dice (from Myles Henderson's private
`dice-engine` repository), with a small server that satisfies Starkeep's app
contract.

## What you get

Solo play in the browser: **Beat the Bot**, a game of Dice Poker against the
expected-value solver (its solved table ships in the bundle). The home screen
offers that one game and nothing else. Dice's other built-ins, puzzles and
custom games stay in the engine but are reached through group shelves, which
need the hosted backend this build does not contain.

The game rules run in the browser as WebAssembly (the same Rust engine the phone
apps use). Nothing is stored in Starkeep: Dice asks for no file types, declares
no tables, and never calls the data server. Game history lives in the browser's
local storage.

## What it lacks

- No groups, daily puzzles, leaderboards or sign-in. Those need the hosted Dice
  backend, which this build does not contain.
- No sync between devices or browsers. In the cloud, game history lives in
  the browser that played the games.
- No maintenance promise. This is a one-off gift build; it may not be updated
  when Starkeep or Dice change.

## Install on a local Starkeep

You need a local Starkeep running from `starkeep-core` (see its README, "Part
A"), Node 22 or later and pnpm.

1. Clone this repository into a folder that will hold your third-party apps,
   for example `~/starkeep-third-party/dice-starkeep`. Starkeep's app discovery
   scans the **folders inside** a registered folder, so register the parent
   (`~/starkeep-third-party`), not `dice-starkeep` itself.
2. Install the server's dependencies. Starkeep runs apps from their folder and
   does not install dependencies for you:

   ```sh
   cd ~/starkeep-third-party/dice-starkeep
   pnpm install
   ```

3. In Starkeep Admin (`http://localhost:3000`), start the Data Server, click
   **Discover apps**, add the parent folder from step 1 and close the dialog.
   A **Dice** card appears under Local.
4. Click **Install Dice**, then **Approve & Install** (Dice requests no file
   access), then **Start Dice**, then **Open Dice ↗**.

`pnpm check` validates `starkeep.manifest.json` with the published
`@starkeep/admin-manifest`. `pnpm test` exercises the server half and checks that the build's hand-edited paths name files the manifest serves.

## Install in your Starkeep cloud

Once Starkeep Cloud is deployed from the same computer (starkeep-core's
README, "Part B"), a **Dice** card appears under **Cloud** in Starkeep Admin.
Click **Install Dice in cloud**. The install runs `pnpm bundle` here, uploads
the zip and creates Dice's Lambda and routes; **Open Dice ↗** then opens
`/apps/dice` on your deployment, which shows a sign-in page until you sign in
with your Starkeep account.

Dice holds no data in Starkeep, so the cloud install creates nothing but the
compute for the shell and the copy of the build that CloudFront serves. The
installer copies `web/_static/` to the deployment's app assets bucket, and
CloudFront serves those files from S3 with no Lambda and no size limit. The
build's files (`/_static/*` and `/pkg/*`) are public, like every Starkeep app's
static files. A person without a session gets the sign-in page instead of the
game, and the platform's session authorizer gates every other path.

The cloud install needs a deployment on the `starkeep-core` release that added
the app assets bucket (`@starkeep/admin-manifest` 0.9.0).

## How it is put together

| Path | What it is |
| --- | --- |
| `starkeep.manifest.json` | App identity, `tier: community`, no grants, `localRun` starting `node server/serve.mjs --port <n>`, and one session-gated `static` compute handler for the cloud. `/`, `/sign-in`, the session routes and the build's files are public; `bundleAssetsDir` names `web/` in the zip. |
| `server/app.mjs` | The Hono app: `serveStatic` for `/_static/*` and `/pkg/*`, `/api/session/*` (the platform's session routes), and the root and `/sign-in` (the game, or the sign-in page for a cloud visitor without a session). `index.html` gets its `<base href>` from `appBasePath()`. Dice keeps no data in Starkeep, so it carries no runtime-config route or signing proxy. |
| `server/sign-in.mjs` | The one-button sign-in page, linking to the platform's `/auth/start`. |
| `server/serve.mjs` | The local surface: `@hono/node-server` on 127.0.0.1, refusing non-loopback `Host` headers. |
| `server/lambda.mjs` | The cloud surface: the platform's web adapter in front of the same Hono app. |
| `scripts/bundle.mjs` | `pnpm bundle`: stages `web/`, bundles the Lambda entry with esbuild and zips. |
| `web/` | The pre-built Flutter web bundle (static files, not rebuilt here): `index.html` at the root, the Rust engine in `pkg/`, and everything else in `_static/`. |

The bundle is not built with Vite. Starkeep's docs name Vite as the default for
the browser half, but the local surface only needs files on disk, so the Flutter
output is served as is.

## Where the bundle came from

Built from `dice-engine` commit `844d398b1d1e6808d6622c4ca34e67919d7278b0`
(Flutter 3.47.2) with:

```sh
scripts/gen-ev-table.sh
(cd apps/mobile && tool/build_web.sh --release)
(cd apps/mobile && flutter build web --release --pwa-strategy=none \
   --no-web-resources-cdn --base-href /)
```

`--no-web-resources-cdn` makes the page load CanvasKit from this app instead of
from Google's CDN, so Dice works without internet access.

Starkeep serves files under `/_static/` from S3 in the cloud, so the build was
then rearranged to match:

- Everything except `index.html` and `pkg/` moved into `_static/`. `pkg/`
  stays at the root because `main.dart.js` loads the Rust engine from
  `pkg/rust_lib_mobile` relative to the page.
- `index.html` points its icon, manifest and `flutter_bootstrap.js` links at
  `_static/`.
- `flutter_bootstrap.js` passes `entrypointBaseUrl: "_static/"`,
  `assetBase: "_static/"` and `canvasKitBaseUrl: "_static/canvaskit/"` to
  `_flutter.loader.load()`.
- `_static/manifest.json` sets `start_url` to `../`, the app root. The CanvasKit
variants the dart2js/CanvasKit build never fetches were then deleted
(`skwasm*`, `wimp*`, `webparagraph/`, every `*.js.symbols`), as were the
hosted site's `privacy.html` and `terms.html`, which describe a service this
build does not use. What remains is about 21 MB on disk: CanvasKit for
Chromium browsers (`canvaskit/chromium/`) and for everything else
(`canvaskit/canvaskit.wasm`), `main.dart.js`, the Rust engine
(`pkg/`), and the solver table.

See [NOTES.md](NOTES.md) for the rough edges found while packaging it.

## License

MIT. See [LICENSE](LICENSE).
