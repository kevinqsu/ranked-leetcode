// Runs every test suite that has its prerequisites available.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hasPyodide = fs.existsSync(path.join(here, ".pyodide", "node_modules", "pyodide", "pyodide.mjs"));
let hasPlaywright = false;
try {
  const { createRequire } = await import("node:module");
  createRequire(import.meta.url).resolve("playwright");
  hasPlaywright = true;
} catch {
  /* not installed */
}

const suites = [
  ["api.test.mjs", true],
  ["harness.test.mjs", hasPyodide],
  ["e2e.test.mjs", hasPyodide && hasPlaywright],
  ["e2e-leetcode.test.mjs", hasPyodide && hasPlaywright],
];
let failed = 0;
for (const [file, enabled] of suites) {
  if (!enabled) {
    console.log(`skip ${file} (missing prerequisites)`);
    continue;
  }
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: "inherit" });
  if (result.status !== 0) failed += 1;
}
process.exit(failed ? 1 : 0);
