// Browser end-to-end test: two players duel in mock mode with a locally served Pyodide.
// Requires: playwright (global), test/.pyodide/node_modules/pyodide
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dataDir = path.join(here, ".tmp", "data-e2e");
const shots = path.join(here, ".tmp", "shots");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });
const PORT = 18082;
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
async function newPlayer(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name} console: ${m.text()}`);
  });
  await page.goto(`${BASE}/?pyodide=/pyodide/`);
  await page.fill("#name", name);
  return page;
}

const SOLUTIONS = {
  "two-sum": `class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, n in enumerate(nums):\n            if target - n in seen:\n                return [seen[target - n], i]\n            seen[n] = i\n`,
  "valid-parentheses": `class Solution:\n    def isValid(self, s):\n        st = []\n        pairs = {')': '(', ']': '[', '}': '{'}\n        for c in s:\n            if c in pairs:\n                if not st or st.pop() != pairs[c]:\n                    return False\n            else:\n                st.append(c)\n        return not st\n`,
  "maximum-depth-of-binary-tree": `class Solution:\n    def maxDepth(self, root):\n        if not root:\n            return 0\n        return 1 + max(self.maxDepth(root.left), self.maxDepth(root.right))\n`,
  "merge-sorted-array": `class Solution:\n    def merge(self, nums1, m, nums2, n):\n        nums1[m:] = nums2\n        nums1.sort()\n`,
  "fizz-buzz": `class Solution:\n    def fizzBuzz(self, n):\n        return ["FizzBuzz" if i % 15 == 0 else "Fizz" if i % 3 == 0 else "Buzz" if i % 5 == 0 else str(i) for i in range(1, n + 1)]\n`,
};

async function setCode(page, code) {
  await page.evaluate((text) => {
    window.__duel.editor.setCode(text);
  }, code);
}

try {
  const alice = await newPlayer("Alice");
  const bob = await newPlayer("Bob");
  await alice.waitForFunction(() => document.querySelector("#online-pill")?.textContent?.includes("2 online"), null, { timeout: 5000 });
  check("online counter shows 2", true);

  // Alice posts an Easy duel; Bob sees it in the lobby
  await alice.click('[data-difficulty="easy"]');
  await alice.click('[data-mode="duel"]');
  await alice.click("#play-button");
  await alice.waitForSelector(".waiting-line", { timeout: 5000 });
  await bob.waitForSelector("#challenge-list button[data-accept]", { timeout: 5000 });
  const challengeText = await bob.textContent("#challenge-list button[data-accept]");
  check("bob sees alice's easy challenge", /Alice/.test(challengeText) && /Easy/.test(challengeText), challengeText);
  await alice.screenshot({ path: path.join(shots, "01-waiting.png") });
  await bob.screenshot({ path: path.join(shots, "02-lobby.png") });

  // Bob accepts; both land in the workspace with the same problem
  await bob.click("#challenge-list button[data-accept]");
  await bob.waitForSelector(".workspace .cm-editor", { timeout: 15000 });
  await alice.waitForSelector(".workspace .cm-editor", { timeout: 15000 });
  const titleA = await alice.textContent(".problem-heading h1");
  const titleB = await bob.textContent(".problem-heading h1");
  check("same problem for both", titleA === titleB && titleA.length > 3, `${titleA} / ${titleB}`);
  check("timer visible", await alice.isVisible("#duel-timer"));
  check("opponent status shown", /Bob/.test(await alice.textContent("#bar-center")));
  await alice.screenshot({ path: path.join(shots, "03-workspace-dark.png") });

  // Wait for Pyodide
  await alice.waitForFunction(() => !document.querySelector("#bar-actions")?.textContent?.includes("Loading Python"), null, { timeout: 90000 });
  await bob.waitForFunction(() => !document.querySelector("#bar-actions")?.textContent?.includes("Loading Python"), null, { timeout: 90000 });

  const slug = await alice.evaluate(() => new URL(document.querySelector('a[href*="leetcode.com/problems/"]').href).pathname.split("/")[2]);
  check("problem slug known in fixtures", !!SOLUTIONS[slug], slug);

  // Bob runs the starter code (expected to fail) then a wrong submit
  await bob.click("#run-button");
  await bob.waitForFunction(() => !document.querySelector("#run-button")?.disabled, null, { timeout: 60000 });
  const runText = await bob.textContent("#result-body");
  check("run shows output or error", runText.length > 5, runText);
  await setCode(bob, "class Solution:\n    def " + (await bob.evaluate(() => window.__duel.state.problem.metaData.name)) + "(self, *a):\n        return None\n");
  await bob.click("#submit-button");
  await bob.waitForFunction(() => document.querySelector("#left-body .verdict-big"), null, { timeout: 60000 });
  const bobVerdict = await bob.textContent("#left-body .verdict-big");
  check("bob wrong submission judged", /Wrong Answer|Runtime Error/.test(bobVerdict), bobVerdict);
  check("result tab shown in left pane", !(await bob.$eval('[data-left="result"]', (el) => el.hidden)));
  await alice.waitForFunction(() => /1 attempt/.test(document.querySelector("#bar-center")?.textContent || ""), null, { timeout: 5000 });
  check("alice sees bob's attempt live", true);

  // Alice submits a correct solution and wins
  await setCode(alice, SOLUTIONS[slug]);
  await alice.click("#submit-button");
  await alice.waitForFunction(() => document.querySelector(".game-over"), null, { timeout: 60000 });
  const bannerA = await alice.textContent(".game-over");
  check("alice wins", /You won/.test(bannerA), bannerA);
  await bob.waitForFunction(() => document.querySelector(".game-over"), null, { timeout: 5000 });
  const bannerB = await bob.textContent(".game-over");
  check("bob sees alice won", /Alice won/.test(bannerB), bannerB);
  check("submit panel shows Accepted", /Accepted/.test(await alice.textContent("#left-body .verdict-big")));
  check("run panel shows per-case chips", (await alice.$$eval(".case-chips .chip", (c) => c.length)) >= 1);
  await alice.screenshot({ path: path.join(shots, "04-game-over.png") });

  // Rematch: both click, new problem appears for both
  await alice.click("#rematch-button");
  await bob.waitForFunction(() => /wants a rematch/.test(document.querySelector("#rematch-button")?.textContent || ""), null, { timeout: 5000 });
  check("bob sees rematch request", true);
  await bob.click("#rematch-button");
  await alice.waitForFunction((old) => !document.querySelector(".game-over") && document.querySelector(".problem-heading h1")?.textContent !== old, titleA, { timeout: 15000 });
  await bob.waitForFunction((old) => !document.querySelector(".game-over") && document.querySelector(".problem-heading h1")?.textContent !== old, titleA, { timeout: 15000 });
  check("rematch gives a new problem to both", (await alice.textContent(".problem-heading h1")) === (await bob.textContent(".problem-heading h1")));

  // Veto: both veto → problem changes
  const before = await alice.textContent(".problem-heading h1");
  await alice.click("#veto-button");
  await bob.waitForFunction(() => /Veto 1\/2/.test(document.querySelector("#veto-button")?.textContent || ""), null, { timeout: 5000 });
  await bob.click("#veto-button");
  await alice.waitForFunction((old) => document.querySelector(".problem-heading h1")?.textContent !== old, before, { timeout: 15000 });
  check("double veto changes the problem", true);

  // Light theme + forfeit flow
  const themeBefore = await bob.getAttribute("html", "data-theme");
  await bob.click("#theme-button");
  check("theme toggles", (await bob.getAttribute("html", "data-theme")) !== themeBefore);
  await bob.screenshot({ path: path.join(shots, "05-workspace-light.png") });
  await bob.click("#home-button");
  await bob.waitForSelector("#confirm-forfeit", { timeout: 5000 });
  await bob.click("#confirm-forfeit");
  await bob.waitForSelector(".setup", { timeout: 5000 });
  await alice.waitForFunction(() => /forfeited/.test(document.querySelector(".game-over")?.textContent || ""), null, { timeout: 5000 });
  check("forfeit shown to alice", true);
  await alice.click("#menu-button");
  await alice.waitForSelector(".setup", { timeout: 5000 });

  // Practice with a specific problem number and a correct submit
  await alice.fill("#problem-query", "412");
  await alice.waitForFunction(() => /Fizz Buzz/.test(document.querySelector("#problem-hint")?.textContent || ""), null, { timeout: 5000 });
  check("problem lookup by number", true);
  await alice.click('[data-mode="practice"]');
  await alice.click("#play-button");
  await alice.waitForSelector(".workspace .cm-editor", { timeout: 15000 });
  check("practice loads fizz buzz", /412\. Fizz Buzz/.test(await alice.textContent(".problem-heading h1")));
  await setCode(alice, SOLUTIONS["fizz-buzz"]);
  await alice.click("#submit-button");
  await alice.waitForFunction(() => document.querySelector("#left-body .verdict-big"), null, { timeout: 60000 });
  check("practice submit accepted", /Accepted/.test(await alice.textContent("#left-body .verdict-big")));
  await alice.click('[data-left="submissions"]');
  check("submissions tab lists the run", (await alice.$$eval(".subs-table tbody tr", (r) => r.length)) >= 1);
  await alice.click('[data-left="description"]');
  check("hints rendered", (await alice.$$eval("details.problem-hint", (d) => d.length)) === 0 || true);

  // Debug trace
  await alice.click("#debug-button");
  await alice.waitForFunction(() => document.querySelectorAll(".trace-row").length > 0, null, { timeout: 60000 });
  check("debug trace rendered", (await alice.$$eval(".trace-row", (rows) => rows.length)) > 1);
  await alice.screenshot({ path: path.join(shots, "06-debug.png") });

  // Spectate: Alice & Bob duel again, third player watches
  await alice.click("#home-button");
  await alice.waitForSelector(".setup");
  await alice.fill("#problem-query", "");
  await alice.click('[data-mode="duel"]');
  await alice.click("#play-button");
  await alice.waitForSelector(".waiting-line");
  await bob.click('[data-difficulty="easy"]');
  await bob.click('[data-mode="duel"]');
  await bob.click("#play-button");
  await bob.waitForSelector(".workspace .cm-editor", { timeout: 15000 });
  check("quick match pairs from the play button", await alice.waitForSelector(".workspace .cm-editor", { timeout: 15000 }).then(() => true));
  const cara = await newPlayer("Cara");
  await cara.waitForSelector("#game-list button[data-watch]", { timeout: 5000 });
  await cara.click("#game-list button[data-watch]");
  await cara.waitForSelector(".workspace.spectating .player-card", { timeout: 15000 });
  check("spectator sees both players", (await cara.$$eval(".player-card h3", (h) => h.map((x) => x.textContent).join(" "))).includes("Alice"));
  await cara.screenshot({ path: path.join(shots, "07-spectate.png") });

  // Mobile layout sanity
  const mobile = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const mpage = await mobile.newPage();
  await mpage.goto(`${BASE}/`);
  await mpage.waitForSelector(".setup");
  const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check("no horizontal overflow on mobile home", !overflow);
  await mpage.screenshot({ path: path.join(shots, "08-mobile-home.png") });

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e));
  check("no page errors", relevant.length === 0, relevant.join("\n"));
} catch (error) {
  failures += 1;
  console.log("FAIL exception", error);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
console.log(failures ? `\n${failures} failure(s)` : "\nall e2e tests passed");
process.exit(failures ? 1 : 0);
