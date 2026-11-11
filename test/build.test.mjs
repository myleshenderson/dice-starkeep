/**
 * The checked-in Flutter build agrees with itself and with the manifest.
 *
 * The build was rearranged by hand to sit under `_static/` (README, "Rebuilding
 * the web bundle"), so its relative paths are edits, not Flutter output. A
 * wrong one leaves the server tests green and the game blank. Each path here
 * is resolved the way the browser resolves it, against the app root or the
 * file that names it, and must name a file in `web/` that the manifest's
 * static paths cover.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { publicPathCovers } from "@starkeep/admin-manifest";
import { DEFAULT_WEB_DIR as WEB, STATIC_PATHS } from "../server/app.mjs";

const ORIGIN = "http://dice.test";
const MOUNT = "/apps/dice";

/** The app-relative path a reference resolves to, from an app-relative page. */
function resolveFrom(page, ref) {
  const { pathname } = new URL(ref, `${ORIGIN}${MOUNT}${page}`);
  assert.ok(pathname.startsWith(`${MOUNT}/`), `${ref} from ${page} leaves the app (${pathname})`);
  return pathname.slice(MOUNT.length);
}

function assertServedFile(path) {
  assert.ok(existsSync(join(WEB, path)), `web${path} does not exist`);
  assert.ok(
    STATIC_PATHS.some((entry) => publicPathCovers(entry, path)),
    `${path} is not under the manifest's staticAssetPaths`,
  );
}

const read = (path) => readFileSync(join(WEB, path), "utf8");

test("every link in the shell names a served file", () => {
  const html = read("index.html");
  const refs = [...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, "index.html has no links");
  for (const ref of refs) assertServedFile(resolveFrom("/", ref));
});

test("the loader's base URLs name the entrypoint, CanvasKit and the assets", () => {
  const bootstrap = read("_static/flutter_bootstrap.js");
  const config = (key) => {
    const m = bootstrap.match(new RegExp(`${key}:\\s*"([^"]+)"`));
    assert.ok(m, `flutter_bootstrap.js does not set ${key}`);
    return m[1];
  };
  const mainJs = bootstrap.match(/"mainJsPath":"([^"]+)"/)?.[1];
  assert.ok(mainJs, "flutter_bootstrap.js names no mainJsPath");

  // The loader resolves each base against the document, whose base is the app root.
  assertServedFile(resolveFrom("/", config("entrypointBaseUrl") + mainJs));
  for (const file of ["canvaskit.js", "canvaskit.wasm"]) {
    assertServedFile(resolveFrom("/", config("canvasKitBaseUrl") + file));
  }
  for (const file of ["assets/AssetManifest.bin", "assets/FontManifest.json"]) {
    assertServedFile(resolveFrom("/", config("assetBase") + file));
  }
});

test("the Rust engine sits where main.dart.js loads it", () => {
  // main.dart.js fixes this path, relative to the document, at build time.
  assert.ok(read("_static/main.dart.js").includes('"pkg/rust_lib_mobile"'), "main.dart.js no longer loads pkg/rust_lib_mobile");
  for (const file of ["rust_lib_mobile.js", "rust_lib_mobile_bg.wasm"]) {
    assertServedFile(resolveFrom("/", `pkg/${file}`));
  }
});

test("the PWA manifest starts at the app root and names served icons", () => {
  const manifestPath = "/_static/manifest.json";
  const pwa = JSON.parse(read(manifestPath));
  assert.equal(resolveFrom(manifestPath, pwa.start_url), "/");
  for (const icon of pwa.icons) assertServedFile(resolveFrom(manifestPath, icon.src));
});
