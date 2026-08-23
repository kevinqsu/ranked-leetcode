# LeetCode 1v1

Race a friend on the same LeetCode problem. Pick a difficulty (or a specific problem
number), post a challenge, and the first player whose Python passes the problem's
example tests wins. Built for TJHSST Director: a zero-dependency Node.js server plus a
static frontend, no build step.

**Features**

- Lobby with open challenges and quick match (posting a challenge at the same difficulty
  as someone who is waiting pairs you instantly), plus a spectate list for duels in progress.
- Choose a problem by number (`1`), slug (`two-sum`) or pasted URL, or go random.
- LeetCode-style workspace: statement, CodeMirror Python editor, Run / Debug (line trace
  with locals) / Submit, dark and light themes.
- Live opponent status (attempts, best examples passed, online dot) and a duel clock,
  pushed over WebSockets (falls back to polling).
- Veto: if both players veto, a new problem is picked. Rematch when both players agree.
- Judging runs in the browser (Pyodide) against the example tests; the server verifies
  the outputs before awarding the win.
- Optional: link your own LeetCode account (session cookie) to judge on real LeetCode
  submissions with hidden tests.

## How judging works

LeetCode has no public judge, so by default the site checks the **example tests** shown in
the statement: the inputs come from LeetCode's `exampleTestcases`, the expected outputs
are parsed from the statement, your code runs in a Web Worker with Pyodide, and the server
compares the outputs (with float tolerance, and order-insensitive when the statement says
"in any order"). Problems whose examples cannot be checked automatically (multiple valid
answers, hidden APIs like `isBadVersion`, unsupported node types) are skipped for duels
and marked in practice mode. Because only the examples are checked, a slow solution can
still "win"; for hidden tests and time limits, link a LeetCode account and pick
*LeetCode account* judging (both players must be linked).

## Linking a LeetCode account (optional)

Click *Link LeetCode* in the top bar and paste the `LEETCODE_SESSION` and `csrftoken`
cookies from leetcode.com (DevTools → Application/Storage → Cookies). The server stores
them in `/site/data/state.json` (mode 600, never served) and uses them only to submit code
and poll the verdict on your behalf. Unlink when you are done; logging out of LeetCode also
invalidates the cookie. LeetCode may rate limit or block submissions from the server — the
error is shown in the Test Result panel.

## Running locally

```sh
npm start                 # real LeetCode, http://localhost:8080
npm run dev               # LEETCODE_MOCK=1: uses test/fixtures, no network needed
```

Tests (optional, need `playwright` available to Node and
`cd test/.pyodide && npm install pyodide@314.0.5`):

```sh
node test/harness.test.mjs   # Python judge harness inside Pyodide
node test/api.test.mjs       # HTTP API + WebSocket flows
node test/e2e.test.mjs       # two-player duel in headless Chromium
```

## Layout

```
run.sh                   Director entry point (exec node server/server.js)
server/server.js         HTTP static files + JSON API + WebSocket upgrade
server/ws.js             minimal RFC 6455 WebSocket server
server/duels.js          lobby, quick match, veto, submissions, presence, rematch, expiry
server/leetcode.js       LeetCode GraphQL client, example parsing, sanitiser, random picker
server/problem-list.js   built-in fallback pool of free problems
server/lcsubmit.js       optional real submissions with a linked account
server/store.js          JSON file persistence (data/state.json)
public/index.html        page shell + Pyodide source list
public/app.js            UI (vanilla JS module)
public/style.css         LeetCode-like theme, dark/light
public/judge.js          output comparison shared by server and browser
public/python-worker.js  Pyodide worker + Python harness (ListNode/TreeNode, design classes, trace)
public/vendor/codemirror.js  CodeMirror 6 bundle (Python, One Dark) built with esbuild
test/                    fixtures and tests
```

## Configuration

Everything has sensible defaults. Environment variables the server understands:
`PORT`, `HOST` (set by Director), `CODEDUEL_DATA_DIR` (default `./data`),
`LEETCODE_MOCK=1` (fixtures instead of LeetCode).
