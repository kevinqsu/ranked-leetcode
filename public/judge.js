// Output comparison shared by the server (to award duel wins) and the browser
// (to show per-example results). Plain ES module, no dependencies.

const FLOAT_TOLERANCE = 1e-5;

// Parse an expected-output string from a LeetCode statement ("[0,1]", "true",
// "\"abc\"", "2.00000", "[null,null,-3]", Python-style "True"/"None" ...).
export function parseLiteral(text) {
  if (typeof text !== "string") return { ok: false, value: null };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    /* fall through */
  }
  // Python-flavoured literals: True/False/None, single quotes, tuples.
  const pythonised = trimmed
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    .replace(/'/g, '"')
    .replace(/\(/g, "[")
    .replace(/\)/g, "]");
  try {
    return { ok: true, value: JSON.parse(pythonised) };
  } catch {
    /* fall through */
  }
  // Bare numbers with trailing zeros or a lone word (unquoted string output).
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: true, value: Number(trimmed) };
  if (/^[A-Za-z0-9_ .,-]+$/.test(trimmed) && !/\s=\s/.test(trimmed)) return { ok: true, value: trimmed, bare: true };
  return { ok: false, value: null };
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function canonical(value) {
  return JSON.stringify(normalizeForSort(value));
}

function normalizeForSort(value) {
  if (Array.isArray(value)) return value.map(normalizeForSort);
  if (isNumber(value) && Number.isInteger(value)) return value;
  if (isNumber(value)) return Number(value.toFixed(5));
  return value;
}

// Deep-sort arrays so that order does not matter (used when a statement says
// the answer may be returned "in any order").
export function deepSort(value) {
  if (!Array.isArray(value)) return value;
  const sorted = value.map(deepSort);
  sorted.sort((a, b) => {
    const ca = canonical(a);
    const cb = canonical(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  return sorted;
}

export function valuesEqual(expected, actual) {
  if (expected === actual) return true;
  if (expected === null || actual === null || expected === undefined || actual === undefined) {
    return (expected ?? null) === (actual ?? null);
  }
  if (typeof expected === "boolean" || typeof actual === "boolean") {
    const ex = typeof expected === "boolean" ? Number(expected) : expected;
    const ac = typeof actual === "boolean" ? Number(actual) : actual;
    return ex === ac;
  }
  if (isNumber(expected) && isNumber(actual)) {
    if (Number.isInteger(expected) && Number.isInteger(actual)) return expected === actual;
    return Math.abs(expected - actual) <= FLOAT_TOLERANCE * Math.max(1, Math.abs(expected), Math.abs(actual));
  }
  if (typeof expected === "string" && typeof actual === "string") return expected === actual;
  if (typeof expected === "string" && isNumber(actual)) return expected === String(actual);
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i += 1) if (!valuesEqual(expected[i], actual[i])) return false;
    return true;
  }
  if (typeof expected === "object" && typeof actual === "object") {
    const keysA = Object.keys(expected).sort();
    const keysB = Object.keys(actual).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i += 1) {
      if (keysA[i] !== keysB[i]) return false;
      if (!valuesEqual(expected[keysA[i]], actual[keysA[i]])) return false;
    }
    return true;
  }
  return false;
}

// expected: parsed value; actual: value produced by the Python harness.
// nodeReturn: the method returns a TreeNode/ListNode, which the harness serialises
// as a list; LeetCode prints just the node value for problems like "lowest common
// ancestor", so a scalar expectation is compared against the returned node's value.
export function outputsMatch(expected, actual, { anyOrder = false, nodeReturn = false } = {}) {
  if (valuesEqual(expected, actual)) return true;
  if (anyOrder && Array.isArray(expected) && Array.isArray(actual)) {
    return valuesEqual(deepSort(expected), deepSort(actual));
  }
  if (nodeReturn && !Array.isArray(expected) && Array.isArray(actual) && actual.length > 0) {
    return valuesEqual(expected, actual[0]);
  }
  return false;
}

// Judge a batch of example runs. examples: [{expected (parsed)}], results: [{actual, error}]
export function judgeExamples(examples, results, { anyOrder = false, nodeReturn = false } = {}) {
  const details = examples.map((example, index) => {
    const result = results[index] || { error: "No result." };
    if (result.error) {
      return { index, passed: false, status: classifyError(result.error), error: result.error, actual: null };
    }
    const passed = outputsMatch(example.expected, result.actual, { anyOrder, nodeReturn });
    return { index, passed, status: passed ? "Accepted" : "Wrong Answer", actual: result.actual ?? null };
  });
  const passedCount = details.filter((d) => d.passed).length;
  const firstFailure = details.find((d) => !d.passed) || null;
  return {
    accepted: passedCount === examples.length && examples.length > 0,
    passed: passedCount,
    total: examples.length,
    verdict: passedCount === examples.length && examples.length > 0 ? "Accepted" : firstFailure ? firstFailure.status : "No examples",
    details,
  };
}

export function classifyError(message) {
  const text = String(message || "");
  if (/Time Limit Exceeded|timed out/i.test(text)) return "Time Limit Exceeded";
  if (/SyntaxError|IndentationError/.test(text)) return "Compile Error";
  return "Runtime Error";
}

export function formatValue(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
