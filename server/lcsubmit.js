// Optional: judge on real LeetCode submissions using a player's own session
// cookie (LEETCODE_SESSION + csrftoken). This mirrors what the VS Code LeetCode
// extension does. It is best-effort: LeetCode can rate limit or block the server.

import { LeetCodeError, graphql, leetcodeFetch as limitedFetch } from "./leetcode.js";

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
    submissionId,
    detail,
  };
}
