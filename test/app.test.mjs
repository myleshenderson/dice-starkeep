/**
 * The server half, exercised in-process through `app.fetch`.
 *
 * A temporary `web/` stands in for the Flutter build so the tests say nothing
 * about its contents, and the cloud cases run with no user pool configured, so
 * every visitor is a stranger: the page with the button, never a token.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

let webDir;
let createApp;
const PAYLOAD = Buffer.from("not really wasm, but big enough to tell apart");

before(async () => {
  webDir = mkdtempSync(join(tmpdir(), "dice-test-web-"));
  writeFileSync(join(webDir, "index.html"), '<!DOCTYPE html><html><head><base href="/"></head><body>dice</body></html>');
  writeFileSync(join(webDir, "main.dart.js"), "console.log('dice')");
  mkdirSync(join(webDir, "canvaskit"));
  writeFileSync(join(webDir, "canvaskit", "canvaskit.wasm"), PAYLOAD);
  writeFileSync(join(webDir, "canvaskit", "canvaskit.wasm.gz"), gzipSync(PAYLOAD));
  writeFileSync(join(webDir, "canvaskit", "only-gz.wasm.gz"), gzipSync(PAYLOAD));
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

test("a bundle file is served with its type", async () => {
  const res = await get(local(), "/main.dart.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  assert.equal(await res.text(), "console.log('dice')");
});

test("a gzip sibling is sent when the browser accepts gzip", async () => {
  const res = await get(local(), "/canvaskit/canvaskit.wasm", { "accept-encoding": "gzip, deflate, br" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
  assert.equal(res.headers.get("content-type"), "application/wasm");
  assert.equal(res.headers.get("vary"), "Accept-Encoding");
  assert.deepEqual(gunzipSync(Buffer.from(await res.arrayBuffer())), PAYLOAD);
});

test("the plain file is sent when the browser does not accept gzip", async () => {
  const res = await get(local(), "/canvaskit/canvaskit.wasm", { "accept-encoding": "identity" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), null);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PAYLOAD);
});

test("a file that exists only gzipped is still served to a gzip client", async () => {
  const res = await get(local(), "/canvaskit/only-gz.wasm", { "accept-encoding": "gzip" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
});

test("a path outside the bundle is refused", async () => {
  const res = await get(local(), "/../package.json");
  assert.equal(res.status, 404);
  const res2 = await get(local(), "/%2e%2e/package.json");
  assert.equal(res2.status, 404);
});

test("an unknown file is a 404, not the shell", async () => {
  const res = await get(local(), "/nope.js");
  assert.equal(res.status, 404);
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

test("cloud bundle file without a session is sent to sign-in by the origin gate", async () => {
  const res = await get(cloud(), "/main.dart.js");
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get("location"), "http://dice.test").pathname, "/apps/dice/sign-in");
});

test("cloud runtime config is public", async () => {
  const res = await get(cloud(), "/starkeep-runtime-config");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /json/);
});

test("cloud session probe is public and answers signed out", async () => {
  const res = await get(cloud(), "/api/session");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { signedIn: false });
});
