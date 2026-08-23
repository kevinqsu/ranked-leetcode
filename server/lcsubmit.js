// Two separate things live here:
//
//   1. Account verification — proves a player owns a LeetCode username by having
//      them put a one-time code on their public profile. No credentials involved,
//      so this is the default way to link an account.
//   2. Submitting to LeetCode — needs the player's own session cookie, exactly as
//      the VS Code LeetCode extension does, because LeetCode publishes no OAuth or
//      public submit API. Opt-in, and only for players who want hidden-test judging.

import crypto from "node:crypto";
import { LeetCodeError, graphql, isMock, leetcodeFetch as limitedFetch } from "./leetcode.js";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SUBMIT_TIMEOUT = 15000;
const POLL_INTERVAL = 1200;
const POLL_MAX = 40000;
const MIN_GAP = 3000;

const inflight = new Map(); // sessionId -> timestamp of last submit start

export function parseCookieInput(text) {
  // Accept raw values or a pasted "name=value; name2=value2" cookie header.
  const value = String(text || "").trim();
  if (!value) return "";
  const match = value.match(/(?:^|;\s*)(?:LEETCODE_SESSION|csrftoken)=([^;\s]+)/i);
  return match ? match[1] : value.replace(/^["']|["']$/g, "");
}

export async function verifyCookies(cookies) {
  if (isMock()) {
    if (cookies.session === "bad") return { username: "" };
    const named = /^user:([A-Za-z0-9_.-]+)$/.exec(cookies.session);
    return { username: named ? named[1] : `mock_${cookies.csrf.slice(0, 8)}` };
  }
  const data = await graphql(
    `query userStatus { userStatus { isSignedIn username } }`,
    {},
    { cookies, referer: "https://leetcode.com/" },
  );
  const status = data.userStatus;
  if (!status || !status.isSignedIn) {
    throw new LeetCodeError("LeetCode did not accept those cookies (expired or incomplete?).", 401);
  }
  return { username: status.username || "" };
}

async function leetcodeFetch(url, { cookies, method = "GET", body = null, referer }) {
  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    Referer: referer,
    Origin: "https://leetcode.com",
    Cookie: `LEETCODE_SESSION=${cookies.session}; csrftoken=${cookies.csrf}`,
    "x-csrftoken": cookies.csrf,
    "x-requested-with": "XMLHttpRequest",
  };
  if (body) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await limitedFetch(url, { method, headers, body, signal: AbortSignal.timeout(SUBMIT_TIMEOUT) });
  } catch (error) {
    if (error instanceof LeetCodeError) throw error;
    throw new LeetCodeError(`Could not reach LeetCode (${error?.message || "network error"}).`);
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (response.status === 401 || response.status === 403) {
    throw new LeetCodeError("LeetCode rejected the session (cookie expired or blocked). Re-link your account.", 401);
  }
  if (response.status === 429) throw new LeetCodeError("LeetCode is rate limiting submissions; wait a moment.", 429);
  if (!response.ok || !payload) throw new LeetCodeError(`LeetCode returned HTTP ${response.status}.`);
  return payload;
}

// Returns a verdict shaped like the examples judge: {accepted, verdict, passed, total, ...}
export async function submitToLeetCode({ sessionId, cookies, problem, code }) {
  const last = inflight.get(sessionId) || 0;
  if (Date.now() - last < MIN_GAP) throw new LeetCodeError("Please wait a few seconds between submissions.", 429);
  inflight.set(sessionId, Date.now());
  try {
    if (isMock()) return mockSubmit(code);
    const referer = `https://leetcode.com/problems/${problem.titleSlug}/`;
    const submit = await leetcodeFetch(`https://leetcode.com/problems/${problem.titleSlug}/submit/`, {
      cookies,
      method: "POST",
      referer,
      body: JSON.stringify({ lang: "python3", question_id: String(problem.questionId), typed_code: code }),
    });
    const submissionId = submit.submission_id;
    if (!submissionId) throw new LeetCodeError(submit.error || "LeetCode did not accept the submission.");

    const deadline = Date.now() + POLL_MAX;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      const check = await leetcodeFetch(`https://leetcode.com/submissions/detail/${submissionId}/check/`, { cookies, referer });
      if (check.state === "SUCCESS") return mapVerdict(check, submissionId);
    }
    throw new LeetCodeError("LeetCode is taking too long to judge; check the submission on leetcode.com.", 504);
  } finally {
    inflight.set(sessionId, Date.now());
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapVerdict(check, submissionId) {
  const status = String(check.status_msg || "Unknown");
  const accepted = status === "Accepted";
  const total = Number(check.total_testcases || 0);
  const passed = Number(check.total_correct || 0);
  const detail = {};
  if (status === "Wrong Answer") {
    detail.input = check.last_testcase || check.input || "";
    detail.expected = check.expected_output || "";
    detail.output = check.code_output || "";
  } else if (status === "Runtime Error") {
    detail.error = check.full_runtime_error || check.runtime_error || "";
    detail.input = check.last_testcase || "";
  } else if (status === "Compile Error") {
    detail.error = check.full_compile_error || check.compile_error || "";
  } else if (status === "Time Limit Exceeded") {
    detail.input = check.last_testcase || "";
  }
  return {
    source: "leetcode",
    accepted,
    verdict: status,
    passed: accepted ? total : passed,
    total,
    runtime: check.status_runtime || "",
    memory: check.status_memory || "",
    runtimePercentile: numberOrNull(check.runtime_percentile),
    memoryPercentile: numberOrNull(check.memory_percentile),
    submissionId: String(submissionId),
    detail,
  };
}

// ---------------------------------------------------------------------------
// Runtime / memory distribution ("Beats X%") for an accepted submission.

const DETAILS_QUERY = `
  query submissionDetails($submissionId: Int!) {
    submissionDetails(submissionId: $submissionId) {
      runtime
      runtimeDisplay
      runtimePercentile
      runtimeDistribution
      memory
      memoryDisplay
      memoryPercentile
      memoryDistribution
      statusCode
      totalCorrect
      totalTestcases
      lang { name verboseName }
    }
  }
`;

function parseDistribution(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.distribution) ? parsed.distribution : [];
  return list
    .map((entry) => (Array.isArray(entry) ? [Number(entry[0]), Number(entry[1])] : null))
    .filter((entry) => entry && Number.isFinite(entry[0]) && Number.isFinite(entry[1]))
    .sort((a, b) => a[0] - b[0]);
}

// Memory buckets come back in KB (sometimes bytes); normalise everything to MB.
function toMegabytes(value, sample) {
  if (!Number.isFinite(value)) return null;
  if (sample > 100000) return value / 1e6; // bytes
  if (sample > 1000) return value / 1000; // KB
  return value; // already MB
}

export async function submissionDetails({ cookies, submissionId }) {
  if (isMock()) return mockDetails(submissionId);
  const data = await graphql(DETAILS_QUERY, { submissionId: Number(submissionId) }, { cookies, referer: "https://leetcode.com/submissions/" });
  const d = data.submissionDetails;
  if (!d) throw new LeetCodeError("LeetCode has no details for that submission yet.", 404);
  const runtimeDistribution = parseDistribution(d.runtimeDistribution);
  const memoryRaw = parseDistribution(d.memoryDistribution);
  const memorySample = memoryRaw.length ? memoryRaw[memoryRaw.length - 1][0] : 0;
  const memoryDistribution = memoryRaw.map(([x, pct]) => [toMegabytes(x, memorySample), pct]);
  const memoryBytes = numberOrNull(d.memory);
  return {
    submissionId: String(submissionId),
    statusCode: d.statusCode ?? null,
    runtimeMs: numberOrNull(d.runtime),
    runtimeDisplay: d.runtimeDisplay || "",
    runtimePercentile: numberOrNull(d.runtimePercentile),
    runtimeDistribution,
    memoryMb: memoryBytes === null ? null : toMegabytes(memoryBytes, memoryBytes),
    memoryDisplay: d.memoryDisplay || "",
    memoryPercentile: numberOrNull(d.memoryPercentile),
    memoryDistribution,
    totalCorrect: d.totalCorrect ?? null,
    totalTestcases: d.totalTestcases ?? null,
    lang: d.lang?.verboseName || d.lang?.name || "Python3",
  };
}

// ---------------------------------------------------------------------------
// Mock mode (LEETCODE_MOCK=1): exercises the whole flow without LeetCode.

const mockCalls = new Map();

function mockSubmit(code) {
  const wrong = /WRONG/.test(code);
  const id = String(700000 + Math.floor(Math.random() * 1000));
  return {
    source: "leetcode",
    accepted: !wrong,
    verdict: wrong ? "Wrong Answer" : "Accepted",
    passed: wrong ? 23 : 57,
    total: 57,
    runtime: "40 ms",
    memory: "17.9 MB",
    runtimePercentile: null,
    memoryPercentile: null,
    submissionId: id,
    detail: wrong ? { input: "[3,2,4]\n6", expected: "[1,2]", output: "[0,0]" } : {},
  };
}

function mockDetails(submissionId) {
  // Percentiles "arrive" on the second poll, like the real site.
  const calls = (mockCalls.get(submissionId) || 0) + 1;
  mockCalls.set(submissionId, calls);
  const ready = calls >= 2;
  const runtimeDistribution = [];
  for (let ms = 28; ms <= 120; ms += 2) runtimeDistribution.push([ms, Math.max(0.05, 12 * Math.exp(-((ms - 46) ** 2) / 300))]);
  const memoryDistribution = [];
  for (let mb = 17.2; mb <= 19.6; mb = Math.round((mb + 0.1) * 10) / 10) memoryDistribution.push([mb, Math.max(0.1, 9 * Math.exp(-((mb - 17.9) ** 2) / 0.3))]);
  return {
    submissionId: String(submissionId),
    statusCode: 10,
    runtimeMs: 40,
    runtimeDisplay: "40 ms",
    runtimePercentile: ready ? 85.12 : null,
    runtimeDistribution: ready ? runtimeDistribution : [],
    memoryMb: 17.9,
    memoryDisplay: "17.9 MB",
    memoryPercentile: ready ? 40.37 : null,
    memoryDistribution: ready ? memoryDistribution : [],
    totalCorrect: 57,
    totalTestcases: 57,
    lang: "Python3",
  };
}

// ---------------------------------------------------------------------------
// Account verification (no credentials)

const VERIFY_TTL = 15 * 60 * 1000;
const VERIFY_MAX_ATTEMPTS = 15;
const pending = new Map(); // sessionId -> { username, code, expiresAt, attempts }

export function cleanUsername(value) {
  const text = String(value || "").trim().replace(/^@/, "");
  const url = text.match(/leetcode\.com\/(?:u\/)?([A-Za-z0-9_.-]+)/i);
  const name = url ? url[1] : text;
  return /^[A-Za-z0-9_.-]{1,40}$/.test(name) ? name : "";
}

const PROFILE_QUERY = `
  query userPublicProfile($username: String!) {
    matchedUser(username: $username) {
      username
      profile { realName aboutMe websites }
    }
  }
`;

export async function publicProfile(username) {
  const data = await graphql(PROFILE_QUERY, { username }, { referer: `https://leetcode.com/u/${username}/` });
  const user = data.matchedUser;
  if (!user) throw new LeetCodeError(`LeetCode has no user called "${username}".`, 404);
  const profile = user.profile || {};
  return {
    username: user.username || username,
    fields: [profile.realName, profile.aboutMe, ...(Array.isArray(profile.websites) ? profile.websites : [])]
      .filter((v) => typeof v === "string" && v)
      .join("\n"),
  };
}

export function startVerification(sessionId, usernameInput) {
  const username = cleanUsername(usernameInput);
  if (!username) throw new LeetCodeError("That does not look like a LeetCode username.", 400);
  const code = `codeduel-${crypto.randomBytes(4).toString("hex")}`;
  const expiresAt = Date.now() + VERIFY_TTL;
  pending.set(sessionId, { username, code, expiresAt, attempts: 0 });
  if (pending.size > 500) {
    for (const [key, entry] of pending) if (entry.expiresAt < Date.now()) pending.delete(key);
  }
  return { username, code, expiresAt };
}

export function pendingVerification(sessionId) {
  const entry = pending.get(sessionId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return { username: entry.username, code: entry.code, expiresAt: entry.expiresAt };
}

export function cancelVerification(sessionId) {
  pending.delete(sessionId);
}

// Confirms the one-time code is on the profile, then forgets it.
export async function checkVerification(sessionId) {
  const entry = pending.get(sessionId);
  if (!entry || entry.expiresAt < Date.now()) {
    pending.delete(sessionId);
    throw new LeetCodeError("That verification expired. Start again to get a new code.", 400);
  }
  entry.attempts += 1;
  if (entry.attempts > VERIFY_MAX_ATTEMPTS) {
    pending.delete(sessionId);
    throw new LeetCodeError("Too many attempts. Start again to get a new code.", 429);
  }
  const profile = isMock()
    ? { username: entry.username, fields: entry.username === "notme" ? "nothing here" : entry.code }
    : await publicProfile(entry.username);
  if (!profile.fields.includes(entry.code)) {
    throw new LeetCodeError(
      `Could not find ${entry.code} on leetcode.com/u/${entry.username}. Add it to your profile's Name, Summary or a website link, save, then try again.`,
      400,
    );
  }
  pending.delete(sessionId);
  return { username: profile.username };
}