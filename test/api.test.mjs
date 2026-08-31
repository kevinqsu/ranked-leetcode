// Exercises the HTTP API and WebSocket push end to end against a mock-mode server.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.LEETCODE_MOCK = "1";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dataDir = path.join(here, ".tmp", "data-api");
fs.rmSync(dataDir, { recursive: true, force: true });
const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server/server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", LEETCODE_MOCK: "1", STUDY_MOCK: "1", CODEDUEL_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("listening") && resolve()));

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : "");
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url, body) {
  const res = await fetch(BASE + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
async function get(url) {
  const res = await fetch(BASE + url);
  return { status: res.status, body: await res.json() };
}
function wsClient(sessionId, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?sessionId=${sessionId}&name=${encodeURIComponent(name)}`);
  const client = { ws, views: [], latest: null, opened: new Promise((r) => (ws.onopen = r)) };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "view") {
      client.views.push(msg.view);
      client.latest = msg.view;
    }
  };
  client.waitFor = async (predicate, timeout = 4000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (client.latest && predicate(client.latest)) return client.latest;
      await sleep(25);
    }
    throw new Error("timeout waiting for view");
  };
  return client;
}

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const C = "cccccccc-3333-4333-8333-cccccccccccc";

try {
  // static + health
  const index = await fetch(BASE + "/");
  const indexHtml = await index.text();
  check("index.html served", index.status === 200 && indexHtml.includes("<title>"));
  check("study button is absent from static HTML", !indexHtml.includes('id="study-button"'));
  check("health", (await get("/api/health")).body.ok === true);
  check("path traversal blocked", (await fetch(BASE + "/../package.json")).status === 404);

  // problem lookup
  const lookup = await get("/api/problem/lookup?q=1");
  check("lookup by number", lookup.body.problem?.title === "Two Sum", lookup.body);
  const byUrl = await get("/api/problem?q=" + encodeURIComponent("https://leetcode.com/problems/3sum/"));
  check("problem by url", byUrl.body.problem?.id === "15" && byUrl.body.problem.examples.length === 3, byUrl.body);
  check("unjudgeable lookup reports note", (await get("/api/problem/lookup?q=5")).body.problem.judgeable === false);

  // websocket clients
  const a = wsClient(A, "Alice");
  const b = wsClient(B, "Bob");
  await Promise.all([a.opened, b.opened]);
  await a.waitFor((v) => v.me.name === "Alice" && v.online >= 2);
  check("initial view over ws", a.latest.online >= 2 && a.latest.challenges.length === 0, a.latest);

  // Alice creates a challenge; Bob sees it in the lobby
  const created = await post("/api/duels", { action: "create", sessionId: A, name: "Alice", difficulty: "medium", judging: "examples" });
  check("create challenge", created.status === 201 && created.body.duel.status === "open", created.body);
  await b.waitFor((v) => v.challenges.length === 1);
  check("bob sees challenge", b.latest.challenges[0].creatorName === "Alice" && b.latest.challenges[0].difficulty === "Medium");
  check("alice sees own duel open", (await a.waitFor((v) => v.duel?.status === "open")).duel.players.length === 1);

  // Quick match: Bob creates at the same difficulty and is paired instantly
  const paired = await post("/api/duels", { action: "create", sessionId: B, name: "Bob", difficulty: "Medium", judging: "examples" });
  check("quick match pairs", paired.status === 201 && paired.body.duel.status === "active" && paired.body.duel.players.length === 2, paired.body);
  const activeA = await a.waitFor((v) => v.duel?.status === "active");
  check("both get same problem", activeA.duel.problem.slug === paired.body.duel.problem.slug && activeA.duel.id === paired.body.duel.id);
  check("problem is medium & judgeable", activeA.duel.difficulty === "Medium");
  check("lobby cleared", b.latest.challenges.length === 0 && a.latest.games.length === 1);

  // Spectator
  const c = wsClient(C, "Cara");
  await c.opened;
  await c.waitFor((v) => v.games.length === 1);
  await post("/api/duels", { action: "watch", sessionId: C, duelId: activeA.duel.id });
  const watching = await c.waitFor((v) => v.watch && v.watch.id === activeA.duel.id);
  check("spectator view", watching.watch.players.length === 2);
  check("players see spectator names", (await a.waitFor((v) => v.duel?.spectators?.length === 1)).duel.spectators[0] === "Cara");
  // live code relay: only to watchers, snapshot included in the watcher's view
  const codeMsg = new Promise((resolve) => {
    const prev = c.ws.onmessage;
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "code") resolve(m);
      else prev(e);
    };
  });
  a.ws.send(JSON.stringify({ type: "code", duelId: activeA.duel.id, code: "print('hi')", lastRun: { kind: "run", verdict: "Accepted", passed: 2, total: 2, at: Date.now() } }));
  const relayed = await codeMsg;
  check("code relayed to spectator", relayed.playerId === A && relayed.code === "print('hi')" && relayed.lastRun.verdict === "Accepted", relayed);
  check("code not sent to the opponent", !b.views.some((v) => v.watch));
  const snapshot = (await get(`/api/view?sessionId=${C}`)).body;
  check("watcher view carries code snapshot", snapshot.watch.codes[A].code === "print('hi')", snapshot.watch.codes);
  check("player views carry no code", (await get(`/api/view?sessionId=${B}`)).body.duel.codes === undefined);
  await post("/api/duels", { action: "watch", sessionId: A, duelId: activeA.duel.id });
  check("a player cannot spectate their own duel", (await get(`/api/view?sessionId=${A}`)).body.watch === null);

  // Veto flow: one veto does nothing, both re-roll
  const duelId = activeA.duel.id;
  const v1 = await post("/api/duels", { action: "veto", sessionId: A, duelId });
  check("single veto recorded", v1.body.duel.players.find((p) => p.id === A).vetoed === true && v1.body.duel.problem.slug === activeA.duel.problem.slug, v1.body);
  const v2 = await post("/api/duels", { action: "veto", sessionId: B, duelId });
  check("double veto re-rolls", v2.body.duel.problem.slug !== activeA.duel.problem.slug && v2.body.duel.rerolls === 1 && v2.body.duel.players.every((p) => !p.vetoed), v2.body);
  const afterVeto = await a.waitFor((v) => v.duel?.problem?.slug === v2.body.duel.problem.slug);
  check("alice pushed new problem", !!afterVeto);

  // Submission: wrong answer then accepted
  const slug = v2.body.duel.problem.slug;
  const problem = (await get("/api/problem?slug=" + slug)).body.problem;
  const wrong = await post("/api/submit", { sessionId: B, slug, duelId, results: problem.examples.map(() => ({ actual: "nope" })), code: "x" });
  check("wrong answer verdict", wrong.body.verdict.accepted === false && wrong.body.duel.status === "active", wrong.body);
  const statsView = await a.waitFor((v) => v.duel?.players.find((p) => p.id === B)?.attempts === 1);
  check("opponent attempts visible", statsView.duel.players.find((p) => p.id === B).lastVerdict === "Wrong Answer");
  const badCount = await post("/api/submit", { sessionId: B, slug, duelId, results: [], code: "x" });
  check("partial results rejected", badCount.status === 400);
  // use the server's own expectations to produce correct actuals
  const { expectedValues } = await import("../server/leetcode.js");
  const mod = await import("../server/leetcode.js");
  const serverProblem = await mod.getProblem(slug);
  const correct = expectedValues(serverProblem).map((value) => ({ actual: value }));
  const win = await post("/api/submit", { sessionId: A, slug, duelId, results: correct, code: "class Solution: pass" });
  check("accepted ends duel", win.body.verdict.accepted === true && win.body.duel.status === "complete" && win.body.duel.winnerId === A, win.body);
  const over = await b.waitFor((v) => v.duel?.status === "complete");
  check("bob sees game over", over.duel.winnerName === "Alice" && over.duel.endReason === "solved");
  const late = await post("/api/submit", { sessionId: B, slug, duelId, results: correct, code: "x" });
  check("late submission does not change winner", late.body.duel.winnerId === A);

  // Rematch: both click -> new active duel
  const r1 = await post("/api/duels", { action: "rematch", sessionId: A, duelId });
  check("rematch requested", r1.body.duel.players.find((p) => p.id === A).wantsRematch === true && r1.body.duel.status === "complete");
  const r2 = await post("/api/duels", { action: "rematch", sessionId: B, duelId });
  check("rematch starts new duel", r2.body.duel.status === "active" && r2.body.duel.id !== duelId && r2.body.duel.problem.slug !== slug, r2.body);
  const newA = await a.waitFor((v) => v.duel?.status === "active" && v.duel.id === r2.body.duel.id);
  check("alice moved to rematch duel", !!newA);

  // Forfeit by leaving
  const leaveNoFlag = await post("/api/duels", { action: "leave", sessionId: B, duelId: r2.body.duel.id });
  check("leave active requires forfeit flag", leaveNoFlag.status === 409);
  await post("/api/duels", { action: "leave", sessionId: B, duelId: r2.body.duel.id, forfeit: true });
  const forfeited = await a.waitFor((v) => v.duel?.status === "complete" && v.duel.id === r2.body.duel.id);
  check("forfeit awards win", forfeited.duel.winnerId === A && forfeited.duel.endReason === "forfeit");
  check("bob's view cleared after leaving", (await b.waitFor((v) => !v.duel || v.duel.id !== r2.body.duel.id)) !== null);

  // Specific problem challenge + accept from lobby
  const specific = await post("/api/duels", { action: "create", sessionId: A, name: "Alice", difficulty: "easy", judging: "examples", problem: "#155" });
  check("specific problem challenge", specific.body.duel.status === "open" && specific.body.duel.requestedProblem.title === "Min Stack" && specific.body.duel.difficulty === "Medium", specific.body);
  await b.waitFor((v) => v.challenges.some((ch) => ch.problem?.title === "Min Stack"));
  const accepted = await post("/api/duels", { action: "accept", sessionId: B, name: "Bob", duelId: specific.body.duel.id });
  check("accept gives requested problem", accepted.body.duel.status === "active" && accepted.body.duel.problem.slug === "min-stack", accepted.body);
  const unjudgeable = await post("/api/duels", { action: "create", sessionId: C, name: "Cara", difficulty: "easy", judging: "examples", problem: "5" });
  check("unjudgeable specific problem rejected", unjudgeable.status === 400 && /cannot be auto-judged/.test(unjudgeable.body.error), unjudgeable.body);
  const leetJudging = await post("/api/duels", { action: "create", sessionId: C, name: "Cara", difficulty: "easy", judging: "leetcode" });
  check("leetcode judging needs linked account", leetJudging.status === 400, leetJudging.body);

  // Polling fallback
  const polled = await get(`/api/view?sessionId=${C}`);
  check("polling view", polled.body.me.name === "Cara" && polled.body.games.length === 1);

  // Persistence: state file written
  await sleep(400);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  check("state persisted", Object.keys(state.duels).length >= 2 && state.users[A].name === "Alice");

  // Records + name lock (mock link)
  const link = await post("/api/leetcode/link", { sessionId: A, session: "mocksession", csrf: "alice_csrf" });
  check("mock link works", link.status === 200 && link.body.username === "mock_alice_cs", link.body);
  const renamed = await post("/api/duels", { action: "hello", sessionId: A, name: "Someone Else" });
  check("linked name is locked to the username", renamed.body.view.me.name === "mock_alice_cs", renamed.body.view.me);
  check("fresh record is 0-0", renamed.body.view.me.record.wins === 0 && renamed.body.view.me.record.losses === 0);
  // Alice (linked) vs Bob (guest): Alice wins -> record 1-0, Bob unchanged (no username)
  await post("/api/duels", { action: "leave", sessionId: B, duelId: accepted.body.duel.id, forfeit: true });
  const postForfeit = (await get(`/api/view?sessionId=${A}`)).body;
  check("forfeit counts as a win on the record", postForfeit.me.record.wins === 1 && postForfeit.me.record.losses === 0, postForfeit.me);
  check("records leaderboard lists the username", postForfeit.records.length === 1 && postForfeit.records[0].username === "mock_alice_cs" && postForfeit.records[0].wins === 1, postForfeit.records);
  await post("/api/leetcode/unlink", { sessionId: A });
  const unlinked = await post("/api/duels", { action: "hello", sessionId: A, name: "Alice Again" });
  check("name editable again after unlinking", unlinked.body.view.me.name === "Alice Again" && unlinked.body.view.me.record === null);
  check("record survives unlinking", unlinked.body.view.records[0].wins === 1);


  // ---- security + credential-free verification
  const headRes = await fetch(BASE + "/");
  const csp = headRes.headers.get("content-security-policy") || "";
  check("CSP on html", /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /sha256-/.test(csp), csp.slice(0, 120));
  check("other security headers", headRes.headers.get("x-content-type-options") === "nosniff" && headRes.headers.get("x-frame-options") === "DENY" && !!headRes.headers.get("strict-transport-security"));
  const crossSite = await fetch(BASE + "/api/duels", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ action: "hello", sessionId: A }),
  });
  check("cross-site POST blocked", crossSite.status === 403, crossSite.status);

  const V = "dddddddd-4444-4444-8444-dddddddddddd";
  const start = await post("/api/leetcode/verify", { action: "start", sessionId: V, username: "kevinqsu" });
  check("verification issues a profile code", /^codeduel-[0-9a-f]{8}$/.test(start.body.pending.code), start.body);
  const badName = await post("/api/leetcode/verify", { action: "start", sessionId: V, username: "not a username!" });
  check("bad username rejected", badName.status === 400);
  await post("/api/leetcode/verify", { action: "start", sessionId: V, username: "notme" });
  const denied = await post("/api/leetcode/verify", { action: "check", sessionId: V });
  check("verification fails when the code is absent", denied.status === 400 && /Could not find/.test(denied.body.error), denied.body);
  await post("/api/leetcode/verify", { action: "start", sessionId: V, username: "kevinqsu" });
  const verified = await post("/api/leetcode/verify", { action: "check", sessionId: V });
  check("verification links the username", verified.body.username === "kevinqsu", verified.body);
  const view = (await get(`/api/view?sessionId=${V}`)).body;
  check("verified identity enables tutor without submissions", view.me.name === "kevinqsu" && view.me.linked === true && view.me.canSubmit === false && view.me.canStudy === true, view.me);
  const profileTutor = await get(`/api/study?sessionId=${V}`);
  check("profile-only account can list tutor history", profileTutor.status === 200 && Array.isArray(profileTutor.body.conversations), profileTutor.body);
  const profileConfig = await get(`/api/study/config?sessionId=${V}`);
  check("profile-only account can load tutor options", profileConfig.status === 200 && profileConfig.body.defaultModel === "gemini-3.7-flash", profileConfig.body);
  const profileReply = await post("/api/study/message", { sessionId: V, text: "blocked", options: { model: "gemini-3.7-flash", thinkingLevel: "high" } });
  check("profile-only account can send tutor messages", profileReply.status === 200 && /Mock reply/.test(profileReply.body.conversation.messages[1].text), profileReply.body);
  const noCreds = await post("/api/duels", { action: "create", sessionId: V, difficulty: "easy", judging: "leetcode" });
  check("leetcode judging needs credentials, not just a name", noCreds.status === 400, noCreds.body);
  const wrongAccount = await post("/api/leetcode/link", { sessionId: V, session: "user:someoneelse", csrf: "csrf1234" });
  check("credentials for another account refused", wrongAccount.status === 409, wrongAccount.body);
  const creds = await post("/api/leetcode/link", { sessionId: V, session: "user:kevinqsu", csrf: "csrf1234" });
  const fullyLinkedView = (await get(`/api/view?sessionId=${V}`)).body;
  check("own credentials accepted", creds.status === 200 && fullyLinkedView.me.canSubmit === true && fullyLinkedView.me.canStudy === true);
  const studyReply = await post("/api/study/message", {
    sessionId: V,
    text: "Explain this file",
    files: [{ name: "example.py", type: "text/x-python", data: Buffer.from("print('hello')").toString("base64") }],
  });
  check("fully linked account can study", studyReply.status === 200 && /Mock reply/.test(studyReply.body.conversation.messages[1].text), studyReply.body);
  check("study upload metadata persisted", studyReply.body.conversation.messages[0].files[0].name === "example.py" && studyReply.body.conversation.messages[0].files[0].size > 0);
  const studyList = await get(`/api/study?sessionId=${V}`);
  check("study history is listed for the account", studyList.status === 200 && studyList.body.conversations[0].id === studyReply.body.conversation.id, studyList.body);
  const studyHistory = await get(`/api/study/conversations/${studyReply.body.conversation.id}?sessionId=${V}`);
  check("study history reloads", studyHistory.status === 200 && studyHistory.body.conversation.messages.length === 2, studyHistory.body);
  await sleep(400); // let the debounced save land
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  const saved = stored.users[V];
  check("credentials encrypted at rest", saved.lcAuth.session.startsWith("v1.") && !JSON.stringify(saved).includes("user:kevinqsu"), Object.keys(saved));
  check("view never exposes credentials", !JSON.stringify(view).includes("csrf"));

  a.ws.close(); b.ws.close(); c.ws.close();
} catch (error) {
  failures += 1;
  console.log("FAIL exception", error);
} finally {
  server.kill("SIGTERM");
}
console.log(failures ? `\n${failures} failure(s)` : "\nall api tests passed");
process.exit(failures ? 1 : 0);
