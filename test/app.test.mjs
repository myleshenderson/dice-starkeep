/**
 * The server half, exercised in-process through `app.fetch`.
 *
 * A temporary `web/`, laid out like the real one (`index.html`, `_static/`,
 * `pkg/`), stands in for the Flutter build so the tests say nothing about its
 * contents, and the cloud cases run with no user pool configured, so
 * every visitor is a stranger: the page with the button, never a token.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let webDir;
let createApp;
const PAYLOAD = Buffer.from("not really wasm, but big enough to tell apart");

before(async () => {
  webDir = mkdtempSync(join(tmpdir(), "dice-test-web-"));
  writeFileSync(join(webDir, "index.html"), '<!DOCTYPE html><html><head><base href="/"></head><body>dice</body></html>');
  mkdirSync(join(webDir, "_static"));
  writeFileSync(join(webDir, "_static", "main.dart.js"), "console.log('dice')");
  mkdirSync(join(webDir, "pkg"));
  writeFileSync(join(webDir, "pkg", "rust_lib_mobile_bg.wasm"), PAYLOAD);
  writeFileSync(join(webDir, "stray.js"), "not declared");
  ({ createApp } = await import("../server/app.mjs"));
});

after(() => rmSync(webDir, { recursive: true, force: true }));

function local() {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  delete process.env.STARKEEP_APP_BASE_PATH;
  return createApp({ webDir });
}

function cloud() {
  process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
  process.env.STARKEEP_APP_BASE_PATH = "/apps/dice";
  for (const k of ["STARKEEP_USER_POOL_ID", "STARKEEP_USER_POOL_CLIENT_ID", "AWS_REGION"]) delete process.env[k];
  return createApp({ webDir });
}

const get = (app, path, headers = {}) => app.fetch(new Request(`http://dice.test${path}`, { headers }));

beforeEach(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  delete process.env.STARKEEP_APP_BASE_PATH;
});

test("local root is the shell with the root base href", async () => {
  const res = await get(local(), "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /<base href="\/">/);
});

test("local sign-in sends the visitor home", async () => {
  const res = await get(local(), "/sign-in");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
});

// The platform's own tests cover what `serveStatic` sends (types, cache
// headers, ETags, the traversal guard). These check only that Dice hands it
// both prefixes.
test("a _static file is served", async () => {
  const res = await get(local(), "/_static/main.dart.js");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "console.log('dice')");
});

test("the Rust engine is served from pkg/ at the root", async () => {
  const res = await get(local(), "/pkg/rust_lib_mobile_bg.wasm");
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PAYLOAD);
});

test("a declared path with no file is a 404, not the shell", async () => {
  const res = await get(local(), "/_static/nope.js");
  assert.equal(res.status, 404);
});

test("a file outside the declared paths is not served", async () => {
  const res = await get(local(), "/stray.js");
  assert.equal(res.status, 404);
});

test("the data routes are gone", async () => {
  assert.equal((await get(local(), "/starkeep-runtime-config")).status, 404);
  assert.equal((await get(local(), "/api/local-data/data/records")).status, 404);
});

test("cloud root without a session is the sign-in page", async () => {
  const res = await get(cloud(), "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /Sign in/);
  assert.match(html, /href="\/auth\/start\?app=dice&return=%2Fapps%2Fdice%2F"/);
  assert.doesNotMatch(html, /<base href/);
});

test("cloud sign-in page without a session has the button", async () => {
  const res = await get(cloud(), "/sign-in");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /\/auth\/start\?app=dice/);
});

test("cloud build files are public, as the manifest declares", async () => {
  const res = await get(cloud(), "/_static/main.dart.js");
  assert.equal(res.status, 200);
  const pkg = await get(cloud(), "/pkg/rust_lib_mobile_bg.wasm");
  assert.equal(pkg.status, 200);
});

test("cloud undeclared path without a session is sent to sign-in by the origin gate", async () => {
  const res = await get(cloud(), "/stray.js");
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get("location"), "http://dice.test").pathname, "/apps/dice/sign-in");
});

test("cloud session probe is public and answers signed out", async () => {
  const res = await get(cloud(), "/api/session");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { signedIn: false });
});
