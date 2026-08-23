// Browser test for the LeetCode-account path (mock mode): linking, name autofill,
// LeetCode-judged submissions with the runtime/memory distribution, banner close,
// pane resizing and the testcase editor.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dataDir = path.join(here, ".tmp", "data-e2e-lc");
const shots = path.join(here, ".tmp", "shots");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });
const PORT = 18084;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    LEETCODE_MOCK: "1",
    CODEDUEL_DATA_DIR: dataDir,
    PYODIDE_LOCAL_DIR: path.join(here, ".pyodide", "node_modules", "pyodide"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("listening") && resolve()));

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}`, extra !== undefined ? String(extra).slice(0, 500) : "");
  }
}

const browser = await chromium.launch();
const errors = [];
async function newPlayer(name, colorScheme = "dark") {
  const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, colorScheme });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${BASE}/?pyodide=/pyodide/`);
  if (name) await page.fill("#name", name);
  return page;
}
const setCode = (page, code) => page.evaluate((text) => window.__duel.editor.setCode(text), code);
const TWO_SUM = `class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, n in enumerate(nums):\n            if target - n in seen:\n                return [seen[target - n], i]\n            seen[n] = i\n`;

try {
  // ---- link a (mock) LeetCode account: name autofills
  const alice = await newPlayer("");
  await alice.waitForFunction(() => document.querySelector("#online-pill")?.textContent?.includes("online"));
  // credential-free verification: username -> profile code -> verified
  await alice.click("#lc-button");
  await alice.fill("#lc-username", "kevinqsu");
  await alice.click("#get-code");
  await alice.waitForSelector("#verify-code", { timeout: 5000 });
  check("verification code issued", /^codeduel-[0-9a-f]{8}$/.test((await alice.textContent("#verify-code")).trim()));
  check("no credentials asked for up front", (await alice.$("#lc-session")) === null || !(await alice.isVisible("#lc-session")));
  await alice.click("#verify-now");
  await alice.waitForFunction(() => document.querySelector("#lc-button")?.textContent?.includes("kevinqsu"), null, { timeout: 5000 });
  check("account verified without credentials", true);
  check("name locked to the verified username", (await alice.inputValue("#name")) === "kevinqsu" && (await alice.$eval("#name", (el) => el.readOnly)));
  check("lock subtext removed", (await alice.$("#name-hint")) === null);
  check("subtitle removed from the menu", (await alice.$(".setup .lead")) === null);
  check("problem placeholder is just Random", (await alice.$eval("#problem-query", (el) => el.placeholder)) === "Random");
  check("mode reads 1v1", /1v1/.test(await alice.textContent('[data-mode="duel"]')));
  check("sidebar footer removed", (await alice.$(".side-foot")) === null);
  check("leetcode logo in the header", (await alice.$("#home-button svg.lc-logo")) !== null);
  check("favicon is the leetcode mark", /image\/svg\+xml/.test(await alice.$eval('link[rel="icon"]', (l) => l.href)));
  check("verified alone cannot pick leetcode judging", await alice.$eval('[data-judging="leetcode"]', (b) => b.disabled));

  // opting into real submissions is behind the advanced disclosure
  await alice.click("#lc-button");
  await alice.click(".advanced > summary");
  await alice.fill("#lc-session", "user:kevinqsu");
  await alice.fill("#lc-csrf", "csrf12345");
  await alice.click("#link-button");
  await alice.waitForFunction(() => !document.querySelector('[data-judging="leetcode"]')?.disabled, null, { timeout: 5000 });
  check("submissions connected", true);
  check("judging defaults to LeetCode account once connected", await alice.$eval('[data-judging="leetcode"]', (b) => b.classList.contains("selected")));
  check("judging hint trimmed", (await alice.textContent("#judging-hint")).trim() === "Opponents must link an account too.");
  check("verified identity kept after connecting submissions", (await alice.inputValue("#name")) === "kevinqsu");

  // ---- practice with LeetCode judging: submit, see Beats + chart
  await alice.fill("#problem-query", "1");
  await alice.waitForFunction(() => /Two Sum/.test(document.querySelector("#problem-hint")?.textContent || ""));
  await alice.click('[data-mode="practice"]');
  await alice.click("#play-button");
  await alice.waitForSelector(".workspace .cm-editor", { timeout: 15000 });
  check("hints rendered", (await alice.$$eval("details.problem-hint", (d) => d.length)) === 3);
  check("stats footer rendered", /Acceptance Rate/.test(await alice.textContent(".problem-stats")));
  check("submit button targets LeetCode", /Submit to LeetCode/.test(await alice.textContent("#submit-button")));
  await setCode(alice, TWO_SUM);
  await alice.click("#submit-button");
  await alice.waitForFunction(() => document.querySelector("#left-body .verdict-big"), null, { timeout: 20000 });
  check("leetcode verdict accepted", /Accepted/.test(await alice.textContent("#left-body .verdict-big")));
  check("testcases count shown", /57 \/ 57 testcases passed/.test(await alice.textContent("#left-body")));
  check("runtime card present", /40 ms/.test(await alice.textContent('[data-metric="runtime"]')));
  await alice.waitForFunction(() => /Beats 85\.12%/.test(document.querySelector('[data-metric="runtime"]')?.textContent || ""), null, { timeout: 15000 });
  check("beats percentile arrives after polling", true);
  await alice.waitForSelector("#chart-mount svg.dist-chart", { timeout: 5000 });
  const bars = await alice.$$eval("#chart-mount .dist-bar", (b) => b.length);
  check("runtime distribution drawn", bars > 20, bars);
  check("you marker on chart", /You · 40 ms/.test(await alice.textContent("#chart-mount")));
  await alice.screenshot({ path: path.join(shots, "10-leetcode-accepted-dark.png") });
  await alice.click('[data-metric="memory"]');
  await alice.waitForFunction(() => /Memory distribution/.test(document.querySelector("#chart-mount")?.textContent || ""));
  check("memory chart toggles", /17\.9 MB/.test(await alice.textContent("#chart-mount")));
  // hover tooltip
  const hit = await alice.$("#chart-mount .hit");
  await hit.hover();
  check("chart tooltip on hover", !(await alice.$eval("#chart-mount .chart-tip", (t) => t.hidden)));
  check("table view available", (await alice.$$eval("#chart-mount .chart-table tbody tr", (r) => r.length)) > 5);

  // wrong answer through LeetCode path
  await setCode(alice, TWO_SUM + "\n# WRONG\n");
  await alice.waitForTimeout(3200); // MIN_GAP between submissions
  await alice.click("#submit-button");
  await alice.waitForFunction(() => /Wrong Answer/.test(document.querySelector("#left-body .verdict-big")?.textContent || ""), null, { timeout: 20000 });
  check("leetcode wrong answer shows expected/output", /Expected/.test(await alice.textContent("#left-body")) && /\[1,2\]/.test(await alice.textContent("#left-body")));
  await alice.click('[data-left="submissions"]');
  check("submissions history has both", (await alice.$$eval(".subs-table tbody tr", (r) => r.length)) === 2);
  await alice.screenshot({ path: path.join(shots, "11-submissions.png") });

  // ---- testcase editor: add a custom case, run all, chips
  await alice.click('[data-tab="testcase"]');
  await alice.click("[data-add]");
  check("custom case added", (await alice.$$eval(".case-chips .chip:not(.add)", (c) => c.length)) === 4);
  await alice.fill("#param-0", "[1,2,3]");
  await alice.fill("#param-1", "5");
  await setCode(alice, TWO_SUM);
  await alice.click("#run-button");
  await alice.waitForFunction(() => document.querySelector("#result-body .verdict-text"), null, { timeout: 60000 });
  check("run verdict accepted on examples", /Accepted/.test(await alice.textContent("#result-body .verdict-text")));
  await alice.click('#result-body [data-case="3"]');
  check("custom case output shown", /\[1,2\]/.test(await alice.textContent("#result-body")));
  await alice.screenshot({ path: path.join(shots, "12-testcases.png") });

  // ---- resize panes
  const before = await alice.$eval("#workspace", (w) => getComputedStyle(w).getPropertyValue("--left-pct").trim());
  const gutter = await alice.$("#gutter-v");
  const box = await gutter.boundingBox();
  await alice.mouse.move(box.x + 3, box.y + 200);
  await alice.mouse.down();
  await alice.mouse.move(box.x + 150, box.y + 200, { steps: 5 });
  await alice.mouse.up();
  const after = await alice.$eval("#workspace", (w) => getComputedStyle(w).getPropertyValue("--left-pct").trim());
  check("vertical gutter resizes panes", before !== after, `${before} -> ${after}`);

  // ---- duel: loser closes the banner and keeps working
  const bob = await newPlayer("Bob", "light");
  await alice.click("#home-button");
  await alice.waitForSelector(".setup");
  await alice.fill("#problem-query", "");
  await alice.click('[data-judging="examples"]');
  await alice.click('[data-difficulty="easy"]');
  await alice.click('[data-mode="duel"]');
  await alice.click("#play-button");
  await alice.waitForSelector(".waiting-line");
  await bob.waitForSelector("#challenge-list button[data-accept]", { timeout: 5000 });
  await bob.click("#challenge-list button[data-accept]");
  await bob.waitForSelector(".workspace .cm-editor", { timeout: 15000 });
  await alice.waitForSelector(".workspace .cm-editor", { timeout: 15000 });
  const slug = await alice.evaluate(() => window.__duel.state.problem.titleSlug);
  const SOLUTIONS = {
    "two-sum": TWO_SUM,
    "valid-parentheses": `class Solution:\n    def isValid(self, s):\n        st = []\n        pairs = {')': '(', ']': '[', '}': '{'}\n        for c in s:\n            if c in pairs:\n                if not st or st.pop() != pairs[c]:\n                    return False\n            else:\n                st.append(c)\n        return not st\n`,
    "maximum-depth-of-binary-tree": `class Solution:\n    def maxDepth(self, root):\n        if not root:\n            return 0\n        return 1 + max(self.maxDepth(root.left), self.maxDepth(root.right))\n`,
    "merge-sorted-array": `class Solution:\n    def merge(self, nums1, m, nums2, n):\n        nums1[m:] = nums2\n        nums1.sort()\n`,
    "fizz-buzz": `class Solution:\n    def fizzBuzz(self, n):\n        return ["FizzBuzz" if i % 15 == 0 else "Fizz" if i % 3 == 0 else "Buzz" if i % 5 == 0 else str(i) for i in range(1, n + 1)]\n`,
  };
  await alice.waitForFunction(() => !document.querySelector("#bar-actions")?.textContent?.includes("Loading Python"), null, { timeout: 90000 });
  await bob.waitForFunction(() => !document.querySelector("#bar-actions")?.textContent?.includes("Loading Python"), null, { timeout: 90000 });
  await setCode(alice, SOLUTIONS[slug]);
  await alice.click("#submit-button");
  await bob.waitForFunction(() => document.querySelector(".game-over"), null, { timeout: 60000 });
  check("bob sees loss banner", /won/.test(await bob.textContent(".game-over")));
  await bob.click("#banner-close");
  check("banner closes", !(await bob.$(".game-over")));
  check("result pill in top bar", /Rematch\?/.test(await bob.textContent("#bar-actions")));
  await setCode(bob, SOLUTIONS[slug]);
  await bob.click("#submit-button");
  await bob.waitForFunction(() => document.querySelector("#left-body .verdict-big"), null, { timeout: 60000 });
  check("loser can still submit after the duel", /Accepted/.test(await bob.textContent("#left-body .verdict-big")) && /already over/.test(await bob.textContent("#left-body")));
  await bob.screenshot({ path: path.join(shots, "13-after-loss-light.png") });
  await bob.click("#show-result");
  check("banner can be reopened", !!(await bob.$(".game-over")));
  check("winner's banner shows the record", /Your record: 1–0/.test(await alice.textContent(".game-over")), await alice.textContent(".game-over"));
  check("editor blocks spellcheck and Grammarly", await alice.$eval(".cm-content", (el) => el.getAttribute("spellcheck") === "false" && el.getAttribute("data-gramm") === "false"));
  await alice.click("#menu-button");
  await alice.waitForSelector(".setup", { timeout: 5000 });
  await alice.waitForFunction(() => /kevinqsu/.test(document.querySelector("#record-list")?.textContent || ""), null, { timeout: 5000 });
  check("records sidebar lists the linked winner", /1–0/.test(await alice.textContent("#record-list")));
  await alice.screenshot({ path: path.join(shots, "14-records-home.png") });

  check("no page errors", errors.filter((e) => !/ERR_TUNNEL|Failed to load resource/.test(e)).length === 0, errors.join("\n"));
} catch (error) {
  failures += 1;
  console.log("FAIL exception", error);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
console.log(failures ? `\n${failures} failure(s)` : "\nall leetcode-path e2e tests passed");
process.exit(failures ? 1 : 0);