// CodeDuel server: static files + JSON API + WebSocket push. No dependencies.
// Listens on PORT/HOST from the environment (Director sets PORT=80, HOST=0.0.0.0).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { acceptWebSocket } from "./ws.js";
import { DuelEngine, DuelError, cleanName, isValidSessionId } from "./duels.js";
import { LeetCodeError, expectedValues, getProblem, isMock, judgeOptions, lookupProblem, randomProblem, slugFromInput } from "./leetcode.js";
import { parseCookieInput, submitToLeetCode, verifyCookies } from "./lcsubmit.js";
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
store.load({ users: {}, duels: {} });
const engine = new DuelEngine(store);

// ---------------------------------------------------------------------------
// helpers

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

function fail(res, error) {
  const status = error instanceof DuelError || error instanceof LeetCodeError ? error.status : 500;
  if (status >= 500) console.error("[server]", error);
  send(res, status, { error: error.message || "Request failed." });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
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

function publicProblem(problem) {
  return {
    id: problem.id,
    title: problem.title,
    titleSlug: problem.titleSlug,
    difficulty: problem.difficulty,
    content: problem.content,
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
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
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
      const user = engine.user(sessionId);
      if (!user || !user.leetcode) throw new DuelError("Link a LeetCode account to submit to LeetCode.", 403);
      if (!code.trim()) throw new DuelError("Write some code first.", 400);
      verdict = await submitToLeetCode({ sessionId, cookies: user.leetcode, problem, code });
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
    user.leetcode = { ...cookies, username, linkedAt: Date.now() };
    engine.changed();
    return send(res, 200, { username });
  }

  if (route === "POST /api/leetcode/unlink") {
    const body = await readJson(req);
    const sessionId = requireSession(body.sessionId);
    const user = engine.touch(sessionId);
    delete user.leetcode;
    engine.changed();
    return send(res, 200, { ok: true });
  }

  if (route === "GET /api/health") {
    return send(res, 200, { ok: true, mock: isMock(), duels: Object.keys(engine.state.duels).length, online: engine.onlineCount() });
  }

  return send(res, 404, { error: "Not found." });
}

// ---------------------------------------------------------------------------
// server

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
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
  const conn = acceptWebSocket(req, socket, head);
  if (!conn) return;
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
