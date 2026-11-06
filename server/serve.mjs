/**
 * Dice's local surface: `@hono/node-server` in front of `app.mjs`.
 *
 * admin-web starts this from the manifest's `localRun` and appends
 * `--port <n>`. It listens on loopback only and refuses a request addressed to
 * any other host name, the way Starkeep's own Photos app does, so a
 * DNS-rebinding page cannot reach it.
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(PKG_DIR, "node_modules", "hono"))) {
  console.error(
    `dice: dependencies are missing. Run \`pnpm install\` (or \`npm install\`) in ${PKG_DIR}, then start Dice again.`,
  );
  process.exit(1);
}

const { getRequestListener } = await import("@hono/node-server");
const { app } = await import("./app.mjs");

function portFromArgv(argv) {
  const at = argv.findIndex((a) => a === "--port" || a === "-p");
  const value = at >= 0 ? Number(argv[at + 1]) : Number(process.env.PORT);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("dice needs a port: --port <n> (admin-web passes it via the manifest portFlag)");
  }
  return value;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
function isLoopbackHost(host) {
  if (host === undefined) return true;
  const lower = host.trim().toLowerCase();
  const end = lower.startsWith("[") ? lower.indexOf("]") + 1 : lower.indexOf(":");
  return LOOPBACK.has(end > 0 ? lower.slice(0, end) : lower);
}

const port = portFromArgv(process.argv.slice(2));
const listener = getRequestListener(app.fetch);

createServer((req, res) => {
  if (!isLoopbackHost(req.headers.host)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Dice answers on its loopback address only" }));
    return;
  }
  listener(req, res);
}).listen(port, "127.0.0.1", () => {
  console.log(`dice listening on http://localhost:${port}`);
});
