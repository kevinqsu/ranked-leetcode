// CodeDuel server: static files + JSON API + WebSocket push. No dependencies.
// Listens on PORT/HOST from the environment (Director sets PORT=80, HOST=0.0.0.0).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StudyError, StudyService, MAX_STUDY_BODY } from "./study.js";
import { Store } from "./store.js";
import { acceptWebSocket } from "./ws.js";
import { DuelEngine, DuelError, cleanName, isValidSessionId } from "./duels.js";
import { LeetCodeError, expectedValues, getProblem, isMock, judgeOptions, lookupProblem, randomProblem, slugFromInput } from "./leetcode.js";
import {
  cancelVerification,
  checkVerification,
  parseCookieInput,
  pendingVerification,
  startVerification,
  submissionDetails,
  submitToLeetCode,
  verifyCookies,
} from "./lcsubmit.js";
import { RateLimiter, SecretBox, clientIp, inlineScriptHashes, sameOrigin, securityHeaders } from "./security.js";
import { judgeExamples } from "../public/judge.js";

const [major] = process.versions.node.split(".").map(Number);
if (major < 18) {
  console.error(`CodeDuel needs Node.js 18 or newer (found ${process.versions.node}). Pick a newer Node image in Director.`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.CODEDUEL_DATA_DIR || path.join(ROOT, "data");
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const PYODIDE_LOCAL_DIR = process.env.PYODIDE_LOCAL_DIR || ""; // tests only
const MAX_BODY = 512 * 1024;
const MAX_CODE = 64 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

const store = new Store(DATA_DIR);
store.load({ users: {}, duels: {}, records: {} });
const engine = new DuelEngine(store);
const box = new SecretBox(DATA_DIR);
const study = new StudyService(DATA_DIR);

// Rate limits, per client IP. Generous for ordinary play, tight for the calls
// that cost real work (LeetCode traffic) or that an attacker would want to grind.
const limits = {
  api: new RateLimiter({ limit: 1200, windowMs: 60 * 1000 }),
  problems: new RateLimiter({ limit: 120, windowMs: 60 * 1000 }),
  submit: new RateLimiter({ limit: 60, windowMs: 60 * 1000 }),
  account: new RateLimiter({ limit: 40, windowMs: 5 * 60 * 1000 }),
  study: new RateLimiter({ limit: 24, windowMs: 60 * 1000 }),
};
const studyUsers = new RateLimiter({ limit: 20, windowMs: 60 * 1000 });
const MAX_SOCKETS_PER_IP = 40;
const socketsPerIp = new Map();

// Credentials are encrypted with a key file next to the data, never echoed back.
function storeCredentials(user, cookies) {
  user.lcAuth = { session: box.encrypt(cookies.session), csrf: box.encrypt(cookies.csrf), addedAt: Date.now() };
}

function readCredentials(user) {
  if (!user?.lcAuth?.session) return null;
  const session = box.decrypt(user.lcAuth.session);
  const csrf = box.decrypt(user.lcAuth.csrf);
  return session && csrf ? { session, csrf } : null;
}

// Older releases kept the cookies in plain text under `leetcode`. Move them.
(function migrateStoredCredentials() {
  let moved = 0;
  for (const user of Object.values(engine.state.users || {})) {
    if (user?.leetcode?.session) {
      storeCredentials(user, { session: user.leetcode.session, csrf: user.leetcode.csrf || "" });
      user.leetcode = { username: user.leetcode.username || "", verifiedAt: user.leetcode.linkedAt || Date.now(), method: "credentials" };
      moved += 1;
    }
  }
  if (moved) {
    console.log(`Encrypted ${moved} stored LeetCode credential(s).`);
    store.flush();
  }
})();

// ---------------------------------------------------------------------------
// helpers

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders(),
    ...headers,
  });
  res.end(payload);
}

function fail(res, error) {
  const status = error instanceof DuelError || error instanceof LeetCodeError || error instanceof StudyError ? error.status : 500;
  if (status >= 500) console.error("[server]", error);
  send(res, status, { error: error.message || "Request failed." });
}

function readJson(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new DuelError("Request too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new DuelError("Invalid JSON body.", 400));
      }
    });
    req.on("error", () => reject(new DuelError("Request failed.", 400)));
  });
}

function requireSession(value) {
  if (!isValidSessionId(value)) throw new DuelError("Invalid session.", 400);
  return value;
}

function requireStudyUser(sessionId) {
  const user = engine.user(sessionId);
  if (!user?.leetcode?.username || !engine.canSubmitLeetCode(sessionId)) {
    throw new StudyError("Fully connect a LeetCode account to use Study.", 403);
  }
  return user.leetcode.username;
}

function publicProblem(problem) {
  return {
    id: problem.id,
    title: problem.title,
    titleSlug: problem.titleSlug,
    difficulty: problem.difficulty,
    content: problem.content,
    hints: problem.hints || [],
    stats: problem.stats || null,
    tags: problem.tags,
    starterCode: problem.starterCode,
    metaData: problem.metaData,
    sampleTestCase: problem.sampleTestCase,
    examples: problem.examples,
    anyOrder: problem.anyOrder,
    judgeable: problem.judgeable,
    judgeNote: problem.judgeNote,
    sourceUrl: problem.sourceUrl,
  };
}

function problemSummary(problem) {
  return {
    id: problem.id,
    title: problem.title,
    titleSlug: problem.titleSlug,
    difficulty: problem.difficulty,
    judgeable: problem.judgeable,
    judgeNote: problem.judgeNote,
  };
}

// ---------------------------------------------------------------------------
// static files

function serveStatic(req, res, urlPath) {
  let relative = decodeURIComponent(urlPath);
  if (relative === "/") relative = "/index.html";
  let base = PUBLIC_DIR;
  if (PYODIDE_LOCAL_DIR && relative.startsWith("/pyodide/")) {
    base = PYODIDE_LOCAL_DIR;
    relative = relative.slice("/pyodide".length);
  }
  const file = path.normalize(path.join(base, relative));
  if (!file.startsWith(base + path.sep) && file !== base) return send(res, 404, "Not found");
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext];
  if (!type) return send(res, 404, "Not found");
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return send(res, 404, "Not found");
    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    const headers = {
      "Content-Type": type,
      "Cache-Control": ext === ".html" ? "no-cache" : "no-cache, max-age=0, must-revalidate",
      ETag: etag,
      ...securityHeaders({ html: ext === ".html", scriptHashes: ext === ".html" ? inlineScriptHashes(file) : [] }),
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers["Content-Length"] = stat.size;
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// API

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/view") {
    const sessionId = requireSession(url.searchParams.get("sessionId"));
    engine.touch(sessionId);
    return send(res, 200, engine.view(sessionId));
  }

  if (route === "GET /api/study") {
    const sessionId = requireSession(url.searchParams.get("sessionId"));
    const username = requireStudyUser(sessionId);
    return send(res, 200, { conversations: study.summaries(username) });
  }

  if (route === "GET /api/study/config") {
    const sessionId = requireSession(url.searchParams.get("sessionId"));
    requireStudyUser(sessionId);
    return send(res, 200, study.config());
  }

  const studyConversation = route.startsWith("GET /api/study/conversations/")
    ? url.pathname.match(/^\/api\/study\/conversations\/([a-f0-9-]{36})$/)
    : null;
  if (studyConversation) {
    const sessionId = requireSession(url.searchParams.get("sessionId"));
    const username = requireStudyUser(sessionId);
    return send(res, 200, { conversation: study.get(username, studyConversation[1]) });
  }

  if (route === "POST /api/study/message") {
    const body = await readJson(req, MAX_STUDY_BODY);
    const sessionId = requireSession(body.sessionId);
    const username = requireStudyUser(sessionId);
    const gate = studyUsers.take(username.toLowerCase());
    if (!gate.ok) throw new StudyError("Too many study messages — wait a moment and try again.", 429);
    const options = body.options && typeof body.options === "object" && !Array.isArray(body.options) ? { ...body.options } : {};
    for (const key of ["model", "engine", "thinking", "thinkingLevel", "reasoning", "webSearch", "codeExecution", "urlContext"]) {
      if (Object.hasOwn(body, key)) options[key] = body[key];
    }
    return send(res, 200, await study.send(username, {
      conversationId: typeof body.conversationId === "string" ? body.conversationId : "",
      text: body.text,
      files: body.files,
      options,
    }));
  }

  if (route === "GET /api/problem") {
    const query = url.searchParams.get("slug") || url.searchParams.get("q") || "";
    const problem = url.searchParams.get("slug") ? await getProblem(slugFromInput(query)) : await lookupProblem(query);
    return send(res, 200, { problem: publicProblem(problem) });
  }

  if (route === "GET /api/problem/random") {
    const exclude = String(url.searchParams.get("exclude") || "")
      .split(",")
      .map((s) => slugFromInput(s))
      .filter(Boolean);
    const problem = await randomProblem(url.searchParams.get("difficulty"), { exclude, requireJudgeable: true });
    return send(res, 200, { problem: publicProblem(problem) });
  }

  if (route === "GET /api/problem/lookup") {
    const problem = await lookupProblem(url.searchParams.get("q") || "");
    return send(res, 200, { problem: problemSummary(problem) });
  }

  if (route === "POST /api/duels") {
    const body = await readJson(req);
    const sessionId = requireSession(body.sessionId);
    const name = body.name;
    switch (body.action) {
      case "create":
        return send(res, 201, {
          duel: await engine.createChallenge({
            sessionId,
            name,
            difficulty: body.difficulty,
            judging: body.judging,
            problemQuery: typeof body.problem === "string" ? body.problem.trim().slice(0, 200) : "",
          }),
        });
      case "accept":
        return send(res, 200, { duel: await engine.acceptChallenge({ sessionId, name, duelId: body.duelId }) });
      case "leave":
        return send(res, 200, { duel: engine.leave({ sessionId, duelId: body.duelId, forfeit: body.forfeit === true }) });
      case "veto":
        return send(res, 200, { duel: await engine.veto({ sessionId, duelId: body.duelId }) });
      case "rematch":
        return send(res, 200, { duel: await engine.rematch({ sessionId, duelId: body.duelId }) });
      case "watch":
        engine.touch(sessionId, name);
        engine.watch(sessionId, typeof body.duelId === "string" ? body.duelId : null);
        return send(res, 200, { ok: true });
      case "code":
        engine.touch(sessionId);
        engine.setLiveCode({ sessionId, duelId: body.duelId, code: typeof body.code === "string" ? body.code : "", lastRun: body.lastRun });
        return send(res, 200, { ok: true });
      case "hello":
        engine.touch(sessionId, name);
        return send(res, 200, { view: engine.view(sessionId) });
      default:
        throw new DuelError("Unknown action.", 400);
    }
  }

  if (route === "POST /api/submit") {
    const body = await readJson(req);
    const sessionId = requireSession(body.sessionId);
    engine.touch(sessionId, body.name);
    const slug = slugFromInput(body.slug);
    if (!slug) throw new DuelError("Problem is required.", 400);
    const problem = await getProblem(slug);
    const duelId = typeof body.duelId === "string" ? body.duelId : null;
    const duel = duelId ? engine.state.duels[duelId] : null;
    const code = typeof body.code === "string" ? body.code : "";
    if (code.length > MAX_CODE) throw new DuelError("Code is too long.", 413);

    const wantsLeetCode = duel ? duel.judging === "leetcode" : body.mode === "leetcode";
    let verdict;
    if (wantsLeetCode) {
      const cookies = readCredentials(engine.user(sessionId));
      if (!cookies) throw new DuelError("Connect LeetCode submissions to submit to LeetCode.", 403);
      if (!code.trim()) throw new DuelError("Write some code first.", 400);
      verdict = await submitToLeetCode({ sessionId, cookies, problem, code });
    } else {
      if (!problem.judgeable) throw new DuelError(`This problem cannot be auto-judged: ${problem.judgeNote}`, 409);
      const results = Array.isArray(body.results) ? body.results.slice(0, problem.examples.length) : [];
      if (results.length !== problem.examples.length) throw new DuelError("Run all examples before submitting.", 400);
      const expected = expectedValues(problem).map((value) => ({ expected: value }));
      verdict = { source: "examples", ...judgeExamples(expected, results, judgeOptions(problem)) };
    }
    verdict.slug = slug;
    const updated = duel ? engine.recordSubmission({ sessionId, duelId, verdict }) : null;
    return send(res, 200, { verdict, duel: updated });
  }

  if (route === "POST /api/leetcode/link") {
    const body = await readJson(req);
    const sessionId = requireSession(body.sessionId);
    const user = engine.touch(sessionId, body.name);
    const cookies = { session: parseCookieInput(body.session), csrf: parseCookieInput(body.csrf) };
    if (!cookies.session || !cookies.csrf) throw new DuelError("Both LEETCODE_SESSION and csrftoken are required.", 400);
    if (cookies.session.length > 4096 || cookies.csrf.length > 256) throw new DuelError("Cookie values look wrong.", 400);
    const { username } = await verifyCookies(cookies);
    // Never let credentials silently move a session onto a different identity:
    // records belong to a verified username.
    const current = user.leetcode?.username;
    if (current && username && current.toLowerCase() !== username.toLowerCase()) {
      throw new DuelError(`Those cookies belong to ${username}, but this session is linked to ${current}. Unlink first.`, 409);
    }
    storeCredentials(user, cookies);
    user.leetcode = { username, verifiedAt: Date.now(), method: "credentials" };
    engine.touch(sessionId); // locks the display name to the LeetCode username
    engine.changed();
    return send(res, 200, { username });
  }

  if (route === "GET /api/leetcode/submission") {
    const sessionId = requireSession(url.searchParams.get("sessionId"));
    const cookies = readCredentials(engine.user(sessionId));
    if (!cookies) throw new DuelError("Connect LeetCode submissions first.", 403);
    const id = String(url.searchParams.get("id") || "").trim();
    if (!/^\d{1,12}$/.test(id)) throw new DuelError("Invalid submission id.", 400);
    return send(res, 200, { submission: await submissionDetails({ cookies, submissionId: id }) });
  }

  if (route === "POST /api/leetcode/unlink") {
    const body = await readJson(req);
    const sessionId = requireSession(body.sessionId);
    const user = engine.touch(sessionId);
    cancelVerification(sessionId);
    delete user.lcAuth;
    if (body.credentialsOnly !== true) delete user.leetcode;
    engine.changed();
    return send(res, 200, { ok: true });
  }

  // Credential-free linking: put a one-time code on your LeetCode profile.
  if (route === "POST /api/leetcode/verify") {
    const body = await readJson(req);
    const sessionId = requireSession(body.sessionId);
    engine.touch(sessionId);
    if (body.action === "cancel") {
      cancelVerification(sessionId);
      return send(res, 200, { ok: true });
    }
    if (body.action === "start") {
      return send(res, 200, { pending: startVerification(sessionId, body.username) });
    }
    if (body.action === "status") {
      return send(res, 200, { pending: pendingVerification(sessionId) });
    }
    const { username } = await checkVerification(sessionId);
    const user = engine.user(sessionId);
    user.leetcode = { username, verifiedAt: Date.now(), method: "profile" };
    engine.touch(sessionId);
    engine.changed();
    return send(res, 200, { username });
  }

  if (route === "GET /api/health") {
    return send(res, 200, { ok: true, mock: isMock(), duels: Object.keys(engine.state.duels).length, online: engine.onlineCount() });
  }

  return send(res, 404, { error: "Not found." });
}

// ---------------------------------------------------------------------------
// server

function limiterFor(pathname) {
  if (pathname === "/api/study/message") return limits.study;
  if (pathname.startsWith("/api/leetcode")) return limits.account;
  if (pathname === "/api/submit") return limits.submit;
  if (pathname.startsWith("/api/problem")) return limits.problems;
  return limits.api;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    // A browser on another site can read a visitor's session id from nothing, but
    // it could still try to drive the API with guessed ids; refuse foreign origins.
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
      return send(res, 403, { error: "Cross-site request blocked." });
    }
    const gate = limiterFor(url.pathname).take(clientIp(req));
    if (!gate.ok) {
      return send(res, 429, { error: "Too many requests — slow down for a moment." }, { "Retry-After": String(gate.retryAfter) });
    }
    handleApi(req, res, url).catch((error) => fail(res, error));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  return serveStatic(req, res, url.pathname);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const sessionId = url.searchParams.get("sessionId");
  if (!isValidSessionId(sessionId)) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!sameOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const ip = clientIp(req);
  const open = socketsPerIp.get(ip) || 0;
  if (open >= MAX_SOCKETS_PER_IP) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const conn = acceptWebSocket(req, socket, head);
  if (!conn) return;
  socketsPerIp.set(ip, open + 1);
  conn.on("close", () => {
    const left = (socketsPerIp.get(ip) || 1) - 1;
    if (left > 0) socketsPerIp.set(ip, left);
    else socketsPerIp.delete(ip);
  });
  engine.touch(sessionId, url.searchParams.get("name") || undefined);
  engine.addConnection(sessionId, conn);
  conn.send(JSON.stringify({ type: "view", view: engine.view(sessionId) }));
  conn.on("message", (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "name") engine.touch(sessionId, cleanName(message.name));
    if (message.type === "watch") engine.watch(sessionId, typeof message.duelId === "string" ? message.duelId : null);
    if (message.type === "code") {
      engine.setLiveCode({ sessionId, duelId: message.duelId, code: typeof message.code === "string" ? message.code : "", lastRun: message.lastRun });
    }
    if (message.type === "ping") conn.send(JSON.stringify({ type: "pong", now: Date.now() }));
  });
});

// Keep connections alive through Director's proxies (2 minute idle timeout).
setInterval(() => {
  for (const conns of engine.connections.values()) {
    for (const conn of conns) {
      if (!conn.alive) conn.close(1001);
      else conn.ping();
    }
  }
}, 25 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`CodeDuel listening on http://${HOST}:${PORT}${isMock() ? " (LeetCode mock mode)" : ""}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`);
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  console.error("[server] uncaught exception:", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[server] unhandled rejection:", error);
});
