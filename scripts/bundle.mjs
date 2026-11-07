#!/usr/bin/env node
/**
 * Build Dice's cloud bundle (dist.zip) for a Starkeep cloud install.
 *
 * The app-owned half of the install contract. The platform installer runs
 * `pnpm bundle` in this directory and consumes the zip it writes:
 *
 *   env in:  STARKEEP_APP_BASE_PATH = /apps/dice   (route prefix to bake in)
 *            STARKEEP_BUNDLE_OUT    = <abs path>   (where to write dist.zip)
 *   out:     dist.zip at STARKEEP_BUNDLE_OUT
 *
 * Three steps: stage the Flutter build at `web/`, pre-compress the files a
 * Lambda could not otherwise answer, and bundle `server/lambda.mjs` with
 * esbuild to `index.mjs` at the zip's root (the manifest's `index.handler`).
 *
 * Nothing is rebuilt here. The Flutter output in `web/` is already built; the
 * base path is not baked in because `server/app.mjs` writes it into the shell's
 * `<base href>` at request time from the mount the platform sets.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build as esbuild } from "esbuild";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const APP_BASE_PATH = process.env.STARKEEP_APP_BASE_PATH;
if (!APP_BASE_PATH) {
  console.error("Error: STARKEEP_APP_BASE_PATH env var is required (e.g. /apps/dice).");
  process.exit(1);
}
const BUNDLE_OUT = process.env.STARKEEP_BUNDLE_OUT;
if (!BUNDLE_OUT) {
  console.error("Error: STARKEEP_BUNDLE_OUT env var is required (abs path to write dist.zip).");
  process.exit(1);
}

/**
 * A Lambda's answer is capped at 6 MB, and the platform's adapter sends a
 * binary body as base64, which grows it by a third. A binary over this size
 * therefore cannot leave the Lambda as is, so the bundle writes a gzip sibling
 * for the server to send instead. Text (JavaScript, JSON, HTML) is sent as
 * text, with no base64 growth, and is left alone: the adapter would read a
 * compressed text file back as UTF-8 and corrupt it.
 */
const GZIP_OVER_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".txt", ".svg", ".xml"]);

/** The Lambda entry must stay small; anything bigger has swallowed something. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function buildDiceBundle(distZip) {
  const staging = mkdtempSync(join(tmpdir(), "starkeep-dice-bundle-"));
  try {
    // 1. The Flutter build, as is, at `web/` beside the entry. `server/app.mjs`
    //    resolves it from the entry's own location.
    console.log("\nStaging the Flutter web build…");
    const web = join(staging, "web");
    cpSync(join(PKG_DIR, "web"), web, { recursive: true });

    // 2. Gzip siblings for the large binaries (CanvasKit's wasm, in practice).
    let compressed = 0;
    for (const file of walk(web)) {
      const ext = extname(file).toLowerCase();
      if (ext === ".gz" || TEXT_EXT.has(ext)) continue;
      const size = statSync(file).size;
      if (size <= GZIP_OVER_BYTES) continue;
      const gz = gzipSync(readFileSync(file), { level: 9 });
      writeFileSync(`${file}.gz`, gz);
      compressed += 1;
      console.log(
        `  ${file.slice(web.length + 1)}: ${(size / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(1)} MB gzipped`,
      );
    }
    if (compressed === 0) console.log("  nothing over the size threshold");

    // 3. The Lambda entry, bundled. The Lambda has no install step of its own,
    //    so Hono and `@starkeep/app-client` are inlined; `node:*` is the
    //    runtime's. ESM with top-level await, which `createWebAppHandler`
    //    relies on to load the app during INIT.
    console.log("\nBundling the Lambda entry with esbuild…");
    await esbuild({
      entryPoints: [join(PKG_DIR, "server", "lambda.mjs")],
      outfile: join(staging, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["node:*"],
      banner: {
        // Inlined CommonJS dependencies expect `require`.
        js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);",
      },
      logLevel: "warning",
    });
    const entryBytes = statSync(join(staging, "index.mjs")).size;
    if (entryBytes > MAX_ENTRY_BYTES) {
      console.error(
        `The Lambda entry is ${(entryBytes / 1048576).toFixed(1)} MB, over the ` +
          `${MAX_ENTRY_BYTES / 1048576} MB ceiling; something unexpected was inlined.`,
      );
      process.exit(1);
    }
    console.log(`  index.mjs: ${(entryBytes / 1024).toFixed(0)} KB`);

    // 4. Zip. `web/` keeps its shape inside the zip because the server
    //    resolves paths under it.
    console.log("\nCreating dist.zip…");
    mkdirSync(dirname(distZip), { recursive: true });
    rmSync(distZip, { force: true });
    execFileSync("zip", ["-ryq", distZip, "."], { cwd: staging, stdio: "inherit" });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

await buildDiceBundle(BUNDLE_OUT);

const bytes = statSync(BUNDLE_OUT).size;
console.log(`\nBundle written: ${BUNDLE_OUT} (${(bytes / 1048576).toFixed(1)} MB) for ${APP_BASE_PATH}`);
