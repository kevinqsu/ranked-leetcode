# CodeDuel — LeetCode 1v1

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

## Deploying on Director (director.tjhsst.edu)

This mirrors how the ranked-zetamac site was deployed, minus `npm install` — there are no
dependencies.

1. **Create the site.** Go to https://director.tjhsst.edu, click *Create Site*, give it a
   name (for example `codeduel`) and a description, choose site type **Dynamic**, and add
   yourself as a user. Click *Create site*.

2. **Pick a Node.js image.** On the site page click *Customize Docker image*. Choose a
   **Node.js** image — Alpine is fine, and it must be **Node 18 or newer**. If you will
   clone from GitHub, type `git` into the *Packages* box. Leave *Write run.sh file?*
   **unchecked** (this project ships its own `run.sh`). Save and wait for the image to
   finish building.

3. **Put the code in the site directory.** Open *Web Terminal* on the site page. Either:

   **Option A — git (recommended, easy updates).** Push this folder to a GitHub repo first
   (`git init && git add -A && git commit -m "CodeDuel" && git branch -M main`, create an empty
   repo on GitHub, then `git remote add origin <url> && git push -u origin main`). Then, because
   `/site` already contains `public/` and `private/`, clone into it like this:

   ```sh
   cd /site
   git init
   git remote add origin https://github.com/<you>/codeduel.git
   git fetch origin
   git checkout -f -t origin/main      # use origin/master if that is your branch name
   chmod +x run.sh
   ```

   **Option B — zip.** Download the zip onto the site and unpack it in `/site`:

   ```sh
   cd /site
   curl -L -o codeduel.zip "<direct link to codeduel.zip>"
   unzip -o codeduel.zip
   chmod +x run.sh
   ```

   You can also drag the files into the *Online Editor* instead; afterwards right-click
   `run.sh` in the file list and choose *Set executable* (it turns green).

   Either way you should end up with `/site/run.sh`, `/site/server/`, `/site/public/`.
   (Director also accepts `run.sh` at `/site/public/run.sh` if you unpack everything into
   `public/` instead — the script finds its own files relative to itself.)

4. **Start it.** Click *Restart process* on the site page (or press Alt+Enter in the online
   editor). The process output in the editor's terminal pane should show
   `CodeDuel listening on http://0.0.0.0:80`.

5. **Open the site** at `https://<sitename>.sites.tjhsst.edu`. Open it in two browsers (or a
   normal and a private window — each window gets its own player identity) to test a duel.

**Updating later:** in the Web Terminal run `cd /site && git pull` (or unzip the new files
over the old ones), click *Restart process*, and hard-refresh the page (Ctrl+Shift+R). The
server sends `no-cache` headers, but bumping the `?v=` query strings in `public/index.html`
is the belt-and-braces option.

**Where things live:** duel state is a small JSON file in `/site/data/` (created
automatically, not served). Players' problems and code drafts are cached in their own
browsers.

### Troubleshooting

- *"DIRECTOR: No run.sh file found"* in the process output — `run.sh` is not executable.
  `chmod +x /site/run.sh` (or *Set executable* in the editor) and restart.
- *"CodeDuel needs Node.js 18 or newer"* — choose a newer Node image under *Customize
  Docker image*.
- *"LeetCode refused the request (HTTP 403)"* — LeetCode rate-limited or blocked the
  server. It usually clears within a minute; problems already fetched are cached.
- *Python stuck on "Loading Python…"* — the browser could not download Pyodide (about
  12 MB on first load). Three CDN paths are tried in order (jsDelivr's Pyodide mirror, the
  npm package on jsDelivr, unpkg). To remove the CDN dependency entirely, grab the
  `pyodide-core-*.tar.bz2` asset for version 314.0.5 from
  https://github.com/pyodide/pyodide/releases (or `npm pack pyodide@314.0.5`), unpack its
  files (`pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`,
  `pyodide-lock.json`) into `public/pyodide/`, and put `"pyodide/"` first in
  `pyodideBases` in `public/index.html`.
- *Site shows the old version* — hard refresh (Ctrl+Shift+R).
- *Process keeps dying* — check the output pane; after a few crashes Director stops
  restarting the process until you click *Restart process* again.

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
