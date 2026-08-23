// Runs the Python judge harness (extracted from public/python-worker.js) inside
// Pyodide under Node, against the fixture problems and sample solutions.
// Requires: cd test/.pyodide && npm install pyodide

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProblem, expectedValues, judgeOptions } from "../server/leetcode.js";
import { judgeExamples } from "../public/judge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { loadPyodide } = await import(path.join(here, ".pyodide/node_modules/pyodide/pyodide.mjs"));

const workerSource = fs.readFileSync(path.join(here, "../public/python-worker.js"), "utf8");
const harness = workerSource.match(/const HARNESS = String\.raw`([\s\S]*?)`;\n/)[1];

const questions = JSON.parse(fs.readFileSync(path.join(here, "fixtures/problems.json"), "utf8"));
const problems = Object.fromEntries(questions.map((q) => [q.titleSlug, buildProblem(q)]));

const pyodide = await loadPyodide();
pyodide.runPython(harness);

function run(code, inputs, metadata, mode = "run") {
  pyodide.globals.set("__duel_code", code);
  pyodide.globals.set("__duel_inputs", JSON.stringify(inputs));
  pyodide.globals.set("__duel_metadata", JSON.stringify(metadata || {}));
  pyodide.globals.set("__duel_mode", mode);
  return JSON.parse(pyodide.runPython("__duel_run(__duel_code, __duel_inputs, __duel_metadata, __duel_mode)"));
}

function judge(slug, code, mode = "run") {
  const problem = problems[slug];
  const results = run(code, problem.examples.map((e) => e.input), problem.metaData, mode);
  const expected = expectedValues(problem).map((value) => ({ expected: value }));
  return { results, verdict: judgeExamples(expected, results, judgeOptions(problem)) };
}

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : "");
  }
}

const SOLUTIONS = {
  "two-sum": `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                return [seen[target - n], i]
            seen[n] = i`,
  "add-two-numbers": `class Solution:
    def addTwoNumbers(self, l1, l2):
        dummy = cur = ListNode()
        carry = 0
        while l1 or l2 or carry:
            s = carry + (l1.val if l1 else 0) + (l2.val if l2 else 0)
            carry, d = divmod(s, 10)
            cur.next = ListNode(d)
            cur = cur.next
            l1 = l1.next if l1 else None
            l2 = l2.next if l2 else None
        return dummy.next`,
  "min-stack": `class MinStack:
    def __init__(self):
        self.s = []
    def push(self, val: int) -> None:
        m = min(val, self.s[-1][1]) if self.s else val
        self.s.append((val, m))
    def pop(self) -> None:
        self.s.pop()
    def top(self) -> int:
        return self.s[-1][0]
    def getMin(self) -> int:
        return self.s[-1][1]`,
  "rotate-array": `class Solution:
    def rotate(self, nums: List[int], k: int) -> None:
        k %= len(nums)
        nums[:] = nums[-k:] + nums[:-k]`,
  "valid-parentheses": `class Solution:
    def isValid(self, s: str) -> bool:
        st = []
        pairs = {')': '(', ']': '[', '}': '{'}
        for c in s:
            if c in pairs:
                if not st or st.pop() != pairs[c]:
                    return False
            else:
                st.append(c)
        return not st`,
  "maximum-depth-of-binary-tree": `class Solution:
    def maxDepth(self, root: Optional[TreeNode]) -> int:
        if not root:
            return 0
        return 1 + max(self.maxDepth(root.left), self.maxDepth(root.right))`,
  "median-of-two-sorted-arrays": `class Solution:
    def findMedianSortedArrays(self, nums1: List[int], nums2: List[int]) -> float:
        a = sorted(nums1 + nums2)
        n = len(a)
        return (a[n // 2] + a[(n - 1) // 2]) / 2`,
  "3sum": `class Solution:
    def threeSum(self, nums: List[int]) -> List[List[int]]:
        nums.sort()
        out = set()
        for i in range(len(nums)):
            j, k = i + 1, len(nums) - 1
            while j < k:
                s = nums[i] + nums[j] + nums[k]
                if s == 0:
                    out.add((nums[k], nums[j], nums[i]))  # deliberately reversed inner order
                    j += 1
                elif s < 0:
                    j += 1
                else:
                    k -= 1
        return [list(t) for t in out]`,
  "lowest-common-ancestor-of-a-binary-search-tree": `class Solution:
    def lowestCommonAncestor(self, root, p, q):
        while root:
            if p.val < root.val and q.val < root.val:
                root = root.left
            elif p.val > root.val and q.val > root.val:
                root = root.right
            else:
                return root`,
  "trapping-rain-water": `class Solution:
    def trap(self, height: List[int]) -> int:
        l, r = 0, len(height) - 1
        lm = rm = ans = 0
        while l < r:
            if height[l] < height[r]:
                lm = max(lm, height[l]); ans += lm - height[l]; l += 1
            else:
                rm = max(rm, height[r]); ans += rm - height[r]; r -= 1
        return ans`,
  "merge-sorted-array": `class Solution:
    def merge(self, nums1: List[int], m: int, nums2: List[int], n: int) -> None:
        nums1[m:] = nums2
        nums1.sort()`,
  "group-anagrams": `class Solution:
    def groupAnagrams(self, strs: List[str]) -> List[List[str]]:
        d = defaultdict(list)
        for s in strs:
            d["".join(sorted(s))].append(s)
        return list(d.values())`,
  "fizz-buzz": `class Solution:
    def fizzBuzz(self, n: int) -> List[str]:
        return ["FizzBuzz" if i % 15 == 0 else "Fizz" if i % 3 == 0 else "Buzz" if i % 5 == 0 else str(i) for i in range(1, n + 1)]`,
};

for (const [slug, code] of Object.entries(SOLUTIONS)) {
  const { verdict, results } = judge(slug, code);
  check(`${slug} accepted`, verdict.accepted, { verdict, results });
}

// Wrong answer
{
  const { verdict } = judge("two-sum", `class Solution:\n    def twoSum(self, nums, target):\n        return [0, 0]`);
  check("two-sum wrong answer", !verdict.accepted && verdict.verdict === "Wrong Answer" && verdict.passed === 0, verdict);
}
// Runtime error with a clean traceback
{
  const { verdict, results } = judge("two-sum", `class Solution:\n    def twoSum(self, nums, target):\n        return nums[100]`);
  check("runtime error", verdict.verdict === "Runtime Error" && /IndexError/.test(results[0].error) && /solution\.py", line 3/.test(results[0].error), results[0]);
}
// Syntax error
{
  const { verdict, results } = judge("two-sum", `class Solution:\n    def twoSum(self, nums, target)\n        return []`);
  check("compile error", verdict.verdict === "Compile Error" && /SyntaxError/.test(results[0].error), results[0]);
}
// Missing Solution class
{
  const { results } = judge("two-sum", `def twoSum(nums, target):\n    return [0, 1]`);
  check("missing class", /class Solution is not defined/.test(results[0].error), results[0]);
}
// stdout capture and debug trace
{
  const problem = problems["two-sum"];
  const results = run(
    `class Solution:\n    def twoSum(self, nums, target):\n        print("hello", nums)\n        for i in range(2):\n            x = i * 2\n        return [0, 1]`,
    [problem.examples[0].input],
    problem.metaData,
    "debug",
  );
  check("stdout captured", results[0].stdout.startsWith("hello [2, 7, 11, 15]"), results[0]);
  check("trace rows", results[0].trace.length >= 4 && results[0].trace.some((r) => r.locals.x === "2"), results[0].trace);
}
// Custom input with whitespace and trailing newline
{
  const problem = problems["valid-parentheses"];
  const results = run(SOLUTIONS["valid-parentheses"], ['"(("\n'], problem.metaData);
  check("custom input", results[0].actual === false, results[0]);
}
// Deep recursion does not crash the runtime
{
  const problem = problems["two-sum"];
  const results = run(
    `import sys\nclass Solution:\n    def twoSum(self, nums, target):\n        def f(n):\n            return 0 if n == 0 else 1 + f(n - 1)\n        return [f(2500), 1]`,
    [problem.examples[0].input],
    problem.metaData,
  );
  check("recursion depth 2500", results[0].error === null && results[0].actual[0] === 2500, results[0]);
  const deeper = run(
    `class Solution:\n    def twoSum(self, nums, target):\n        def f(n):\n            return f(n + 1)\n        return f(0)`,
    [problem.examples[0].input],
    problem.metaData,
  );
  check("infinite recursion reported", /Recursion/i.test(deeper[0].error || ""), deeper[0]);
  const after = judge("two-sum", SOLUTIONS["two-sum"]);
  check("runtime still healthy after recursion error", after.verdict.accepted, after.verdict);
}
// Float tolerance and bool/int handling via judge
{
  const { verdict } = judge("median-of-two-sorted-arrays", `class Solution:\n    def findMedianSortedArrays(self, a, b):\n        return 2.0000001 if len(a)+len(b) == 3 else 2.5`);
  check("float tolerance", verdict.accepted, verdict);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall harness tests passed");
process.exit(failures ? 1 : 0);
