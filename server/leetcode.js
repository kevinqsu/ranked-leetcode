// LeetCode data access: problem statements via the public GraphQL endpoint,
// random problem selection, example parsing and HTML sanitising.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_SLUGS } from "./problem-list.js";
import { parseLiteral } from "../public/judge.js";

const GRAPHQL_URL = "https://leetcode.com/graphql/";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DIFFICULTIES = ["Easy", "Medium", "Hard"];
const PROBLEM_CACHE_MAX = 200;
const LIST_CACHE_TTL = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 15000;

const MOCK = process.env.LEETCODE_MOCK === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const problemCache = new Map(); // slug -> problem
const listCache = new Map(); // difficulty -> { total, fetchedAt, mode }
let mockProblems = null;

export function normalizeDifficulty(value) {
  const text = String(value || "").trim().toLowerCase();
  return DIFFICULTIES.find((d) => d.toLowerCase() === text) || null;
}

// "https://leetcode.com/problems/two-sum/description/" -> "two-sum"
export function slugFromInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/leetcode\.(?:com|cn)\/problems\/([a-z0-9-]+)/i);
  if (match) return match[1].toLowerCase();
  if (/^[a-z0-9-]{1,100}$/i.test(text)) return text.toLowerCase();
  return "";
}

export class LeetCodeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// HTTP

// At most a few LeetCode requests in flight at once, so a burst of users cannot
// get the server rate limited (or blocked) by LeetCode.
const MAX_CONCURRENT = 4;
const MAX_QUEUED = 40;
let inFlight = 0;
const queue = [];

function acquire() {
  if (inFlight < MAX_CONCURRENT) {
    inFlight += 1;
    return Promise.resolve();
  }
  if (queue.length >= MAX_QUEUED) return Promise.reject(new LeetCodeError("Too many problem requests right now; try again shortly.", 503));
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  const next = queue.shift();
  if (next) next();
  else inFlight -= 1;
}

export async function leetcodeFetch(url, init) {
  await acquire();
  try {
    return await fetch(url, init);
  } finally {
    release();
  }
}

export async function graphql(query, variables, { referer = "https://leetcode.com/problemset/", cookies = null } = {}) {
  if (typeof fetch !== "function") {
    throw new LeetCodeError("This Node.js version has no fetch(); pick a newer Node image (18+).", 500);
  }
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Referer: referer,
    Origin: "https://leetcode.com",
    "User-Agent": USER_AGENT,
  };
  if (cookies) {
    headers.Cookie = `LEETCODE_SESSION=${cookies.session}; csrftoken=${cookies.csrf}`;
    headers["x-csrftoken"] = cookies.csrf;
  }
  let response;
  try {
    response = await leetcodeFetch(GRAPHQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
  } catch (error) {
    if (error instanceof LeetCodeError) throw error;
    const reason = error && error.name === "TimeoutError" ? "timed out" : error?.message || "network error";
    throw new LeetCodeError(`Could not reach LeetCode (${reason}).`);
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!response.ok || !payload) {
    const blocked = response.status === 403 || /cloudflare|just a moment/i.test(text);
    throw new LeetCodeError(
      blocked
        ? `LeetCode refused the request (HTTP ${response.status}). The server may be rate limited; try again in a minute.`
        : `LeetCode returned HTTP ${response.status}.`,
    );
  }
  if (payload.errors?.length || !payload.data) {
    throw new LeetCodeError(payload.errors?.[0]?.message || "LeetCode did not return data.");
  }
  return payload.data;
}

// ---------------------------------------------------------------------------
// Problem fetch

const QUESTION_QUERY = `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionId
      questionFrontendId
      title
      titleSlug
      content
      difficulty
      isPaidOnly
      exampleTestcases
      sampleTestCase
      metaData
      topicTags { name slug }
      codeSnippets { lang langSlug code }
    }
  }
`;

export async function getProblem(slug) {
  const key = slugFromInput(slug);
  if (!key) throw new LeetCodeError("Invalid problem slug.", 400);
  if (problemCache.has(key)) {
    const cached = problemCache.get(key);
    problemCache.delete(key); // refresh LRU position
    problemCache.set(key, cached);
    return cached;
  }
  const problem = MOCK ? await fetchMockProblem(key) : await fetchProblem(key);
  problemCache.set(key, problem);
  if (problemCache.size > PROBLEM_CACHE_MAX) problemCache.delete(problemCache.keys().next().value);
  return problem;
}

async function fetchProblem(slug) {
  const data = await graphql(QUESTION_QUERY, { titleSlug: slug }, { referer: `https://leetcode.com/problems/${slug}/` });
  const question = data.question;
  if (!question) throw new LeetCodeError("No such problem on LeetCode.", 404);
  return buildProblem(question);
}

export function buildProblem(question) {
  if (question.isPaidOnly) throw new LeetCodeError("That problem is premium-only on LeetCode.", 403);
  if (!question.content) throw new LeetCodeError("That problem has no public statement.", 404);
  const snippet = (question.codeSnippets || []).find((s) => s.langSlug === "python3");
  if (!snippet) throw new LeetCodeError("That problem has no Python 3 starter code.", 404);

  let metaData = {};
  try {
    metaData = JSON.parse(question.metaData || "{}");
  } catch {
    metaData = {};
  }
  const content = sanitizeHtml(question.content);
  const plain = htmlToText(question.content);
  const examples = parseExamples(question.content, question.exampleTestcases || "", metaData);
  const support = checkSupport(metaData, snippet.code);
  const anyOrder = /\bany\s+order\b|\border\b[^.]{0,80}\b(does\s+not|doesn'?t)\s+matter/i.test(plain);
  const ambiguous =
    /\bany\s+(valid|possible|correct|of\s+them|one\s+of\s+them|answers?|solutions?)\b/i.test(plain) ||
    /\breturn\s+any\b/i.test(plain) ||
    /\bmultiple\s+(valid|possible|correct)?\s*(answers|solutions)\b/i.test(plain) ||
    /\balso\s+(be\s+)?(a\s+)?(valid|accepted|correct)\b/i.test(plain) ||
    /\b(pick|return|choose|select|generat\w*)\s+(a\s+)?random|\brandomly\s+(pick|return|choose|select)|\bequal\s+probability\b|\bgetRandom\b/i.test(plain) ||
    /\bcustom\s+judge\b/i.test(plain);

  const reasons = [];
  if (!support.ok) reasons.push(support.reason);
  if (!examples.ok) reasons.push(examples.reason);
  if (ambiguous && examples.ok && support.ok) reasons.push("This problem accepts multiple answers, so outputs cannot be checked automatically.");

  return {
    id: String(question.questionFrontendId || question.questionId || ""),
    questionId: String(question.questionId || ""),
    title: question.title,
    titleSlug: question.titleSlug,
    difficulty: normalizeDifficulty(question.difficulty) || "Medium",
    content,
    tags: (question.topicTags || []).map((t) => t.name).slice(0, 8),
    starterCode: snippet.code,
    metaData,
    sampleTestCase: question.sampleTestCase || examples.items[0]?.input || "",
    examples: examples.items.map((e) => ({ input: e.input, expectedText: e.expectedText })),
    anyOrder,
    nodeReturn: isNodeReturn(metaData),
    judgeable: reasons.length === 0 && examples.items.length > 0,
    judgeNote: reasons[0] || "",
    sourceUrl: `https://leetcode.com/problems/${question.titleSlug}/`,
  };
}

function isNodeReturn(metaData) {
  if (!metaData || metaData.classname) return false;
  const type = String(metaData.return?.type || "").toLowerCase();
  return type === "treenode" || type === "listnode";
}

export function judgeOptions(problem) {
  return { anyOrder: !!problem.anyOrder, nodeReturn: !!problem.nodeReturn };
}

// Parsed expected values live server-side only (not strictly secret, they are in
// the statement, but the client never needs them in parsed form).
export function expectedValues(problem) {
  return problem.examples.map((e) => parseLiteral(e.expectedText).value);
}

// ---------------------------------------------------------------------------
// Example parsing

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function htmlToText(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}

export function parseExamples(contentHtml, exampleTestcases, metaData) {
  const isDesign = !!(metaData && (metaData.classname || metaData.systemdesign));
  const paramCount = isDesign ? 2 : Array.isArray(metaData?.params) ? metaData.params.length : 0;
  if (!paramCount) return { ok: false, items: [], reason: "The problem's input format is not recognised." };

  const lines = String(exampleTestcases || "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
  if (!lines.length || lines.length % paramCount !== 0) {
    return { ok: false, items: [], reason: "Example inputs could not be split into test cases." };
  }
  const inputs = [];
  for (let i = 0; i < lines.length; i += paramCount) inputs.push(lines.slice(i, i + paramCount).join("\n"));

  const outputs = [];
  const pattern = /<(?:strong|b)(?:\s[^>]*)?>\s*Output\s*:?\s*<\/(?:strong|b)>\s*:?\s*([^\n<]*)/gi;
  let match;
  while ((match = pattern.exec(contentHtml)) !== null) {
    outputs.push(decodeEntities(match[1]).trim());
  }
  if (outputs.length !== inputs.length) {
    return { ok: false, items: [], reason: "Example outputs could not be matched to example inputs." };
  }
  const items = inputs.map((input, i) => ({ input, expectedText: outputs[i] }));
  const unparsable = items.find((item) => !parseLiteral(item.expectedText).ok);
  if (unparsable) {
    return { ok: false, items, reason: `Example output "${unparsable.expectedText.slice(0, 40)}" is not a plain value.` };
  }
  return { ok: true, items, reason: "" };
}

const SUPPORTED_BASE_TYPES = new Set([
  "integer", "long", "double", "float", "string", "character", "boolean", "void", "listnode", "treenode",
]);

function typeSupported(type) {
  let t = String(type || "").trim().toLowerCase();
  if (!t) return true;
  // list<list<integer>> -> integer ; integer[][] -> integer
  for (;;) {
    const m = t.match(/^list<(.*)>$/);
    if (m) {
      t = m[1];
      continue;
    }
    if (t.endsWith("[]")) {
      t = t.slice(0, -2);
      continue;
    }
    break;
  }
  return SUPPORTED_BASE_TYPES.has(t);
}

function checkSupport(metaData, starterCode) {
  if (/already\s+defined\s+for\s+you|API\s+interface|is\s+an\s+interface/i.test(starterCode || "")) {
    return { ok: false, reason: "This problem uses a hidden API, which cannot run in the browser." };
  }
  if (metaData?.classname || metaData?.systemdesign) {
    if (!metaData.classname) return { ok: false, reason: "Unsupported design problem format." };
    const paramTypes = [
      ...(metaData.constructor?.params || []).map((p) => p.type),
      ...(metaData.methods || []).flatMap((m) => [...(m.params || []).map((p) => p.type), m.return?.type]),
    ];
    const bad = paramTypes.find((t) => !typeSupported(t));
    if (bad) return { ok: false, reason: `Type "${bad}" is not supported by the in-browser judge.` };
    return { ok: true, reason: "" };
  }
  if (!metaData?.name || !Array.isArray(metaData.params)) {
    return { ok: false, reason: "The problem's method signature is not recognised." };
  }
  const types = [...metaData.params.map((p) => p.type), metaData.return?.type];
  const bad = types.find((t) => !typeSupported(t));
  if (bad) return { ok: false, reason: `Type "${bad}" is not supported by the in-browser judge.` };
  if (String(metaData.return?.type || "").toLowerCase() === "void" && !metaData.output) {
    return { ok: false, reason: "In-place problems without a declared output cannot be checked." };
  }
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------------------
// HTML sanitiser (statement HTML comes from LeetCode; keep formatting, drop scripts)

const ALLOWED_TAGS = new Set([
  "p", "br", "pre", "code", "strong", "b", "em", "i", "u", "s", "del", "ul", "ol", "li", "sup", "sub",
  "span", "div", "blockquote", "hr", "small", "img", "a", "font", "table", "thead", "tbody", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "var", "kbd",
]);

export function sanitizeHtml(html) {
  let text = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, "");
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (whole, rawName, rawAttrs) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";
    if (whole.startsWith("</")) return `</${name}>`;
    const attrs = [];
    const attrPattern = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = attrPattern.exec(rawAttrs)) !== null) {
      const key = m[1].toLowerCase();
      const value = (m[2] ?? m[3] ?? m[4] ?? "").trim();
      if (name === "img" && key === "src" && /^https:\/\//i.test(value)) attrs.push(`src="${escapeAttr(value)}"`);
      else if (name === "img" && (key === "alt" || key === "width" || key === "height")) attrs.push(`${key}="${escapeAttr(value)}"`);
      else if (name === "img" && key === "style") {
        const safe = value
          .split(";")
          .map((d) => d.trim())
          .filter((d) => /^(width|height|max-width)\s*:\s*[\d.]+(px|%|em)$/i.test(d))
          .join("; ");
        if (safe) attrs.push(`style="${escapeAttr(safe)}"`);
      } else if (name === "a" && key === "href" && /^https?:\/\//i.test(value)) {
        attrs.push(`href="${escapeAttr(value)}" target="_blank" rel="noopener noreferrer"`);
      } else if (name === "font" && key === "face") attrs.push(`face="${escapeAttr(value)}"`);
      else if (key === "class" && name === "strong") attrs.push(`class="${escapeAttr(value)}"`);
    }
    const selfClose = name === "br" || name === "img" || name === "hr" ? " /" : "";
    return `<${name}${attrs.length ? " " + attrs.join(" ") : ""}${selfClose}>`;
  });
  return text;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Random selection

const LIST_QUERY = `
  query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
    problemsetQuestionList: questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
      total: totalNum
      questions: data { titleSlug difficulty paidOnly: isPaidOnly }
    }
  }
`;

const LIST_QUERY_V2 = `
  query problemsetQuestionListV2($filters: QuestionFilterInput, $limit: Int, $skip: Int, $categorySlug: String) {
    problemsetQuestionListV2(filters: $filters, limit: $limit, skip: $skip, categorySlug: $categorySlug) {
      questions { titleSlug difficulty paidOnly }
      totalLength
    }
  }
`;

function v2Filters(difficulty) {
  return {
    filterCombineType: "ALL",
    statusFilter: { questionStatuses: [], operator: "IS" },
    difficultyFilter: { difficulties: [difficulty.toUpperCase()], operator: "IS" },
    languageFilter: { languageSlugs: [], operator: "IS" },
    topicFilter: { topicSlugs: [], operator: "IS" },
    acceptanceFilter: {},
    frequencyFilter: {},
    frontendIdFilter: {},
    lastSubmittedFilter: {},
    publishedFilter: {},
    companyFilter: { companySlugs: [], operator: "IS" },
    positionFilter: { positionSlugs: [], operator: "IS" },
    premiumFilter: { premiumStatus: [], operator: "IS" },
  };
}

async function listPage(difficulty, skip, limit) {
  const cached = listCache.get(difficulty);
  const mode = cached?.mode || "v1";
  if (mode !== "v2") {
    try {
      const data = await graphql(LIST_QUERY, {
        categorySlug: "",
        limit,
        skip,
        filters: { difficulty: difficulty.toUpperCase() },
      });
      const page = data.problemsetQuestionList;
      if (page && Array.isArray(page.questions)) {
        return { total: page.total || 0, questions: page.questions, mode: "v1" };
      }
    } catch (error) {
      if (mode === "v1" && cached) throw error; // v1 used to work; transient failure
      console.warn("[leetcode] questionList failed, trying V2:", error.message);
    }
  }
  const data = await graphql(LIST_QUERY_V2, {
    categorySlug: "all-code-essentials",
    limit,
    skip,
    filters: v2Filters(difficulty),
  });
  const page = data.problemsetQuestionListV2;
  if (!page || !Array.isArray(page.questions)) throw new LeetCodeError("LeetCode problem list unavailable.");
  return { total: page.totalLength || 0, questions: page.questions, mode: "v2" };
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function candidateSlugs(difficulty) {
  if (MOCK) {
    const problems = await loadMockProblems();
    return shuffle(Object.values(problems).filter((p) => p.difficulty === difficulty).map((p) => p.titleSlug));
  }
  try {
    let cached = listCache.get(difficulty);
    if (!cached || Date.now() - cached.fetchedAt > LIST_CACHE_TTL) {
      const probe = await listPage(difficulty, 0, 1);
      cached = { total: probe.total, fetchedAt: Date.now(), mode: probe.mode };
      listCache.set(difficulty, cached);
    }
    const limit = 50;
    const skip = Math.floor(Math.random() * Math.max(1, cached.total - limit));
    const page = await listPage(difficulty, skip, limit);
    const slugs = page.questions.filter((q) => !q.paidOnly && q.titleSlug).map((q) => q.titleSlug);
    if (slugs.length) return shuffle(slugs);
  } catch (error) {
    console.warn("[leetcode] live problem list unavailable, using built-in list:", error.message);
  }
  return shuffle([...new Set(FALLBACK_SLUGS[difficulty] || [])]);
}

// Picks a random free problem of the given difficulty; with requireJudgeable the
// in-browser judge must be able to check it (needed for duels).
export async function randomProblem(difficulty, { exclude = [], requireJudgeable = true, attempts = 8 } = {}) {
  const level = normalizeDifficulty(difficulty);
  if (!level) throw new LeetCodeError("Invalid difficulty.", 400);
  const excluded = new Set(exclude);
  const slugs = (await candidateSlugs(level)).filter((s) => !excluded.has(s));
  let lastError = null;
  let tried = 0;
  for (const slug of slugs) {
    if (tried >= attempts) break;
    tried += 1;
    try {
      const problem = await getProblem(slug);
      if (problem.difficulty !== level) continue;
      if (requireJudgeable && !problem.judgeable) continue;
      return problem;
    } catch (error) {
      lastError = error;
      if (error instanceof LeetCodeError && error.status === 502) throw error; // network-level problem: stop early
    }
  }
  throw lastError instanceof LeetCodeError && lastError.status !== 404 && lastError.status !== 403
    ? lastError
    : new LeetCodeError("Could not find a suitable problem right now. Try again.");
}

// ---------------------------------------------------------------------------
// Mock mode (local development without network access)

async function loadMockProblems() {
  if (mockProblems) return mockProblems;
  const file = path.join(__dirname, "..", "test", "fixtures", "problems.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  mockProblems = {};
  for (const question of raw) mockProblems[question.titleSlug] = buildProblem(question);
  return mockProblems;
}

async function fetchMockProblem(slug) {
  const problems = await loadMockProblems();
  if (!problems[slug]) throw new LeetCodeError("No such problem on LeetCode.", 404);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return problems[slug];
}

export function isMock() {
  return MOCK;
}

// ---------------------------------------------------------------------------
// Problem lookup by number ("1" -> two-sum)

const INDEX_TTL = 24 * 60 * 60 * 1000;
let problemIndex = null; // { byNumber: Map<string, {slug, paidOnly}>, fetchedAt }
let indexPromise = null;

async function loadProblemIndex() {
  if (problemIndex && Date.now() - problemIndex.fetchedAt < INDEX_TTL) return problemIndex;
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    const byNumber = new Map();
    if (MOCK) {
      for (const problem of Object.values(await loadMockProblems())) byNumber.set(problem.id, { slug: problem.titleSlug, paidOnly: false });
    } else {
      let response;
      try {
        response = await leetcodeFetch("https://leetcode.com/api/problems/all/", {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT, Referer: "https://leetcode.com/problemset/" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
      } catch (error) {
        throw new LeetCodeError(`Could not reach LeetCode (${error?.message || "network error"}).`);
      }
      if (!response.ok) throw new LeetCodeError(`LeetCode problem index returned HTTP ${response.status}.`);
      const payload = await response.json().catch(() => null);
      const pairs = payload?.stat_status_pairs;
      if (!Array.isArray(pairs) || !pairs.length) throw new LeetCodeError("LeetCode problem index is unavailable.");
      for (const pair of pairs) {
        const number = String(pair?.stat?.frontend_question_id ?? "");
        const slug = pair?.stat?.question__title_slug;
        if (number && slug) byNumber.set(number, { slug, paidOnly: !!pair.paid_only });
      }
    }
    problemIndex = { byNumber, fetchedAt: Date.now() };
    return problemIndex;
  })();
  try {
    return await indexPromise;
  } finally {
    indexPromise = null;
  }
}

const SEARCH_QUERY = `
  query search($limit: Int, $filters: QuestionListFilterInput) {
    problemsetQuestionList: questionList(categorySlug: "", limit: $limit, skip: 0, filters: $filters) {
      questions: data { titleSlug questionFrontendId paidOnly: isPaidOnly }
    }
  }
`;

async function searchByNumber(number) {
  const data = await graphql(SEARCH_QUERY, { limit: 20, filters: { searchKeywords: number } });
  const hit = (data.problemsetQuestionList?.questions || []).find((q) => String(q.questionFrontendId) === number);
  if (!hit) throw new LeetCodeError(`No problem #${number} found.`, 404);
  if (hit.paidOnly) throw new LeetCodeError(`Problem #${number} is premium-only on LeetCode.`, 403);
  return hit.titleSlug;
}

export async function slugForNumber(number) {
  const key = String(number).trim();
  try {
    const index = await loadProblemIndex();
    const entry = index.byNumber.get(key);
    if (entry) {
      if (entry.paidOnly) throw new LeetCodeError(`Problem #${key} is premium-only on LeetCode.`, 403);
      return entry.slug;
    }
    if (index.byNumber.size > 100) throw new LeetCodeError(`No problem #${key} found.`, 404);
  } catch (error) {
    if (error instanceof LeetCodeError && (error.status === 403 || error.status === 404)) throw error;
    console.warn("[leetcode] problem index unavailable, searching instead:", error.message);
  }
  if (MOCK) throw new LeetCodeError(`No problem #${key} found.`, 404);
  return searchByNumber(key);
}

// Accepts "1", "#1", "two-sum" or a LeetCode URL and returns the problem.
export async function lookupProblem(query) {
  const text = String(query || "").trim().replace(/^#/, "");
  if (!text) throw new LeetCodeError("Enter a problem number, slug or URL.", 400);
  if (/^\d{1,5}$/.test(text)) return getProblem(await slugForNumber(text));
  const slug = slugFromInput(text);
  if (!slug) throw new LeetCodeError("That does not look like a LeetCode problem number, slug or URL.", 400);
  return getProblem(slug);
}
