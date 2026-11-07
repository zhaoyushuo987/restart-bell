// Inlines scripts/helper-template.vbs into lib/index.js as a JSON string literal.
// Idempotent: re-run after editing the VBS → node scripts/embed-helper.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const template = readFileSync(join(root, "scripts", "helper-template.vbs"), "utf8");
const indexPath = join(root, "lib", "index.js");
const source = readFileSync(indexPath, "utf8");
const lineRe = /^const VBS_TEMPLATE = .*;$/m;

if (!lineRe.test(source)) {
  throw new Error("VBS_TEMPLATE assignment line not found in lib/index.js");
}

writeFileSync(
  indexPath,
  source.replace(lineRe, () => "const VBS_TEMPLATE = " + JSON.stringify(template) + ";"),
  "utf8",
);
console.log("embedded helper template (" + template.length + " chars) into lib/index.js");