// Validate starkeep.manifest.json with the published @starkeep/admin-manifest.
import { readFileSync } from "node:fs";
import { validateManifest } from "@starkeep/admin-manifest";

const raw = JSON.parse(readFileSync(new URL("../starkeep.manifest.json", import.meta.url), "utf8"));
const { valid, errors, warnings } = validateManifest(raw);
for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
console.log(valid ? "starkeep.manifest.json is valid" : "starkeep.manifest.json is NOT valid");
process.exit(valid ? 0 : 1);
