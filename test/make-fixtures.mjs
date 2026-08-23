// Generates test/fixtures/problems.json: GraphQL-shaped questions used by
// LEETCODE_MOCK=1 and by the unit tests. Statement HTML mirrors LeetCode's format.
import fs from "node:fs";

const ex = (input, output, explanation) =>
  `<pre>\n<strong>Input:</strong> ${input}\n<strong>Output:</strong> ${output}\n` +
  (explanation ? `<strong>Explanation:</strong> ${explanation}\n` : "") + `</pre>\n`;
const exTitle = (n) => `<p><strong class="example">Example ${n}:</strong></p>\n`;
const LISTNODE_DEF = `# Definition for singly-linked list.\n# class ListNode:\n#     def __init__(self, val=0, next=None):\n#         self.val = val\n#         self.next = next\n`;
const TREENODE_DEF = `# Definition for a binary tree node.\n# class TreeNode:\n#     def __init__(self, val=0, left=None, right=None):\n#         self.val = val\n#         self.left = left\n#         self.right = right\n`;

const questions = [
  {
    questionId: "1", questionFrontendId: "1", title: "Two Sum", titleSlug: "two-sum", difficulty: "Easy", isPaidOnly: false,
    content: `<p>Given an array of integers <code>nums</code>&nbsp;and an integer <code>target</code>, return <em>indices of the two numbers such that they add up to <code>target</code></em>.</p>\n\n<p>You may assume that each input would have <strong><em>exactly</em> one solution</strong>, and you may not use the <em>same</em> element twice.</p>\n\n<p>You can return the answer in any order.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("nums = [2,7,11,15], target = 9", "[0,1]", "Because nums[0] + nums[1] == 9, we return [0, 1].")}${exTitle(2)}${ex("nums = [3,2,4], target = 6", "[1,2]")}${exTitle(3)}${ex("nums = [3,3], target = 6", "[0,1]")}<p>&nbsp;</p>\n<p><strong>Constraints:</strong></p>\n<ul>\n\t<li><code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li>\n\t<li><code>-10<sup>9</sup> &lt;= nums[i] &lt;= 10<sup>9</sup></code></li>\n</ul>`,
    exampleTestcases: "[2,7,11,15]\n9\n[3,2,4]\n6\n[3,3]\n6", sampleTestCase: "[2,7,11,15]\n9",
    metaData: JSON.stringify({ name: "twoSum", params: [{ name: "nums", type: "integer[]" }, { type: "integer", name: "target" }], return: { type: "integer[]", size: 2 } }),
    hints: ["A really brute force way would be to search for all possible pairs of numbers but that would be too slow. Again, it's best to try out brute force solutions for just for completeness. It is from these brute force solutions that you can come up with optimizations.", "So, if we fix one of the numbers, say <code>x</code>, we have to scan the entire array to find the next number <code>y</code> which is <code>value - x</code> where value is the input parameter. Can we change our array somehow so that this search becomes faster?", "The second train of thought is, without changing the array, can we use additional space somehow? Like maybe a hash map to speed up the search?"],
    stats: JSON.stringify({ totalAccepted: "14.2M", totalSubmission: "26.1M", totalAcceptedRaw: 14200000, totalSubmissionRaw: 26100000, acRate: "54.4%" }),
    topicTags: [{ name: "Array", slug: "array" }, { name: "Hash Table", slug: "hash-table" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        " }, { lang: "C++", langSlug: "cpp", code: "class Solution {};" }],
  },
  {
    questionId: "2", questionFrontendId: "2", title: "Add Two Numbers", titleSlug: "add-two-numbers", difficulty: "Medium", isPaidOnly: false,
    content: `<p>You are given two <strong>non-empty</strong> linked lists representing two non-negative integers. The digits are stored in <strong>reverse order</strong>, and each of their nodes contains a single digit. Add the two numbers and return the sum&nbsp;as a linked list.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}<img alt="" src="https://assets.leetcode.com/uploads/2020/10/02/addtwonumber1.jpg" style="width: 483px; height: 342px;" />\n${ex("l1 = [2,4,3], l2 = [5,6,4]", "[7,0,8]", "342 + 465 = 807.")}${exTitle(2)}${ex("l1 = [0], l2 = [0]", "[0]")}${exTitle(3)}${ex("l1 = [9,9,9,9,9,9,9], l2 = [9,9,9,9]", "[8,9,9,9,0,0,0,1]")}`,
    exampleTestcases: "[2,4,3]\n[5,6,4]\n[0]\n[0]\n[9,9,9,9,9,9,9]\n[9,9,9,9]", sampleTestCase: "[2,4,3]\n[5,6,4]",
    metaData: JSON.stringify({ name: "addTwoNumbers", params: [{ name: "l1", type: "ListNode" }, { name: "l2", type: "ListNode" }], return: { type: "ListNode" } }),
    topicTags: [{ name: "Linked List", slug: "linked-list" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: `${LISTNODE_DEF}class Solution:\n    def addTwoNumbers(self, l1: Optional[ListNode], l2: Optional[ListNode]) -> Optional[ListNode]:\n        ` }],
  },
  {
    questionId: "155", questionFrontendId: "155", title: "Min Stack", titleSlug: "min-stack", difficulty: "Medium", isPaidOnly: false,
    content: `<p>Design a stack that supports push, pop, top, and retrieving the minimum element in constant time.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}<pre>\n<strong>Input</strong>\n[&quot;MinStack&quot;,&quot;push&quot;,&quot;push&quot;,&quot;push&quot;,&quot;getMin&quot;,&quot;pop&quot;,&quot;top&quot;,&quot;getMin&quot;]\n[[],[-2],[0],[-3],[],[],[],[]]\n\n<strong>Output</strong>\n[null,null,null,null,-3,null,0,-2]\n\n<strong>Explanation</strong>\nMinStack minStack = new MinStack();\nminStack.push(-2);\n</pre>`,
    exampleTestcases: '["MinStack","push","push","push","getMin","pop","top","getMin"]\n[[],[-2],[0],[-3],[],[],[],[]]', sampleTestCase: '["MinStack","push","push","push","getMin","pop","top","getMin"]\n[[],[-2],[0],[-3],[],[],[],[]]',
    metaData: JSON.stringify({ classname: "MinStack", constructor: { params: [] }, methods: [{ name: "push", params: [{ type: "integer", name: "val" }], return: { type: "void" } }, { name: "pop", params: [], return: { type: "void" } }, { name: "top", params: [], return: { type: "integer" } }, { name: "getMin", params: [], return: { type: "integer" } }], return: { type: "boolean" }, systemdesign: true }),
    topicTags: [{ name: "Stack", slug: "stack" }, { name: "Design", slug: "design" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "class MinStack:\n\n    def __init__(self):\n        \n\n    def push(self, val: int) -> None:\n        \n\n    def pop(self) -> None:\n        \n\n    def top(self) -> int:\n        \n\n    def getMin(self) -> int:\n        \n\n\n# Your MinStack object will be instantiated and called as such:\n# obj = MinStack()\n# obj.push(val)\n# obj.pop()\n# param_3 = obj.top()\n# param_4 = obj.getMin()" }],
  },
  {
    questionId: "189", questionFrontendId: "189", title: "Rotate Array", titleSlug: "rotate-array", difficulty: "Medium", isPaidOnly: false,
    content: `<p>Given an integer array <code>nums</code>, rotate the array to the right by <code>k</code> steps, where <code>k</code> is non-negative.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("nums = [1,2,3,4,5,6,7], k = 3", "[5,6,7,1,2,3,4]", "rotate 1 steps to the right: [7,1,2,3,4,5,6]")}${exTitle(2)}${ex("nums = [-1,-100,3,99], k = 2", "[3,99,-1,-100]")}`,
    exampleTestcases: "[1,2,3,4,5,6,7]\n3\n[-1,-100,3,99]\n2", sampleTestCase: "[1,2,3,4,5,6,7]\n3",
    metaData: JSON.stringify({ name: "rotate", params: [{ name: "nums", type: "integer[]" }, { name: "k", type: "integer" }], return: { type: "void" }, output: { paramindex: 0 } }),
    topicTags: [{ name: "Array", slug: "array" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: 'class Solution:\n    def rotate(self, nums: List[int], k: int) -> None:\n        """\n        Do not return anything, modify nums in-place instead.\n        """\n        ' }],
  },
  {
    questionId: "20", questionFrontendId: "20", title: "Valid Parentheses", titleSlug: "valid-parentheses", difficulty: "Easy", isPaidOnly: false,
    content: `<p>Given a string <code>s</code> containing just the characters <code>&#39;(&#39;</code>, <code>&#39;)&#39;</code>, <code>&#39;{&#39;</code>, <code>&#39;}&#39;</code>, <code>&#39;[&#39;</code> and <code>&#39;]&#39;</code>, determine if the input string is valid.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("s = &quot;()&quot;", "true")}${exTitle(2)}${ex("s = &quot;()[]{}&quot;", "true")}${exTitle(3)}${ex("s = &quot;(]&quot;", "false")}${exTitle(4)}${ex("s = &quot;([])&quot;", "true")}`,
    exampleTestcases: '"()"\n"()[]{}"\n"(]"\n"([])"', sampleTestCase: '"()"',
    metaData: JSON.stringify({ name: "isValid", params: [{ name: "s", type: "string" }], return: { type: "boolean" } }),
    topicTags: [{ name: "String", slug: "string" }, { name: "Stack", slug: "stack" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "class Solution:\n    def isValid(self, s: str) -> bool:\n        " }],
  },
  {
    questionId: "104", questionFrontendId: "104", title: "Maximum Depth of Binary Tree", titleSlug: "maximum-depth-of-binary-tree", difficulty: "Easy", isPaidOnly: false,
    content: `<p>Given the <code>root</code> of a binary tree, return <em>its maximum depth</em>.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}<img alt="" src="https://assets.leetcode.com/uploads/2020/11/26/tmp-tree.jpg" style="width: 400px; height: 277px;" />\n${ex("root = [3,9,20,null,null,15,7]", "3")}${exTitle(2)}${ex("root = [1,null,2]", "2")}`,
    exampleTestcases: "[3,9,20,null,null,15,7]\n[1,null,2]", sampleTestCase: "[3,9,20,null,null,15,7]",
    metaData: JSON.stringify({ name: "maxDepth", params: [{ name: "root", type: "TreeNode" }], return: { type: "integer" } }),
    topicTags: [{ name: "Tree", slug: "tree" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: `${TREENODE_DEF}class Solution:\n    def maxDepth(self, root: Optional[TreeNode]) -> int:\n        ` }],
  },
  {
    questionId: "4", questionFrontendId: "4", title: "Median of Two Sorted Arrays", titleSlug: "median-of-two-sorted-arrays", difficulty: "Hard", isPaidOnly: false,
    content: `<p>Given two sorted arrays <code>nums1</code> and <code>nums2</code> of size <code>m</code> and <code>n</code> respectively, return <strong>the median</strong> of the two sorted arrays.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("nums1 = [1,3], nums2 = [2]", "2.00000", "merged array = [1,2,3] and median is 2.")}${exTitle(2)}${ex("nums1 = [1,2], nums2 = [3,4]", "2.50000", "merged array = [1,2,3,4] and median is (2 + 3) / 2 = 2.5.")}`,
    exampleTestcases: "[1,3]\n[2]\n[1,2]\n[3,4]", sampleTestCase: "[1,3]\n[2]",
    metaData: JSON.stringify({ name: "findMedianSortedArrays", params: [{ name: "nums1", type: "integer[]" }, { name: "nums2", type: "integer[]" }], return: { type: "double" } }),
    topicTags: [{ name: "Binary Search", slug: "binary-search" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "class Solution:\n    def findMedianSortedArrays(self, nums1: List[int], nums2: List[int]) -> float:\n        " }],
  },
  {
    questionId: "15", questionFrontendId: "15", title: "3Sum", titleSlug: "3sum", difficulty: "Medium", isPaidOnly: false,
    content: `<p>Given an integer array nums, return all the triplets <code>[nums[i], nums[j], nums[k]]</code> such that <code>i != j</code>, <code>i != k</code>, and <code>j != k</code>, and <code>nums[i] + nums[j] + nums[k] == 0</code>.</p>\n\n<p>Notice that the solution set must not contain duplicate triplets.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("nums = [-1,0,1,2,-1,-4]", "[[-1,-1,2],[-1,0,1]]", "Notice that the order of the output and the order of the triplets does not matter.")}${exTitle(2)}${ex("nums = [0,1,1]", "[]", "The only possible triplet does not sum up to 0.")}${exTitle(3)}${ex("nums = [0,0,0]", "[[0,0,0]]", "The only possible triplet sums up to 0.")}`,
    exampleTestcases: "[-1,0,1,2,-1,-4]\n[0,1,1]\n[0,0,0]", sampleTestCase: "[-1,0,1,2,-1,-4]",
    metaData: JSON.stringify({ name: "threeSum", params: [{ name: "nums", type: "integer[]" }], return: { type: "list<list<integer>>" } }),
    topicTags: [{ name: "Array", slug: "array" }, { name: "Two Pointers", slug: "two-pointers" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "class Solution:\n    def threeSum(self, nums: List[int]) -> List[List[int]]:\n        " }],
  },
  {
    questionId: "235", questionFrontendId: "235", title: "Lowest Common Ancestor of a Binary Search Tree", titleSlug: "lowest-common-ancestor-of-a-binary-search-tree", difficulty: "Medium", isPaidOnly: false,
    content: `<p>Given a binary search tree (BST), find the lowest common ancestor (LCA) node of two given nodes in the BST.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("root = [6,2,8,0,4,7,9,null,null,3,5], p = 2, q = 8", "6", "The LCA of nodes 2 and 8 is 6.")}${exTitle(2)}${ex("root = [6,2,8,0,4,7,9,null,null,3,5], p = 2, q = 4", "2")}${exTitle(3)}${ex("root = [2,1], p = 2, q = 1", "2")}`,
    exampleTestcases: "[6,2,8,0,4,7,9,null,null,3,5]\n2\n8\n[6,2,8,0,4,7,9,null,null,3,5]\n2\n4\n[2,1]\n2\n1", sampleTestCase: "[6,2,8,0,4,7,9,null,null,3,5]\n2\n8",
    metaData: JSON.stringify({ name: "lowestCommonAncestor", params: [{ name: "root", type: "TreeNode" }, { name: "p", type: "TreeNode" }, { name: "q", type: "TreeNode" }], return: { type: "TreeNode" } }),
    topicTags: [{ name: "Tree", slug: "tree" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "# Definition for a binary tree node.\n# class TreeNode:\n#     def __init__(self, x):\n#         self.val = x\n#         self.left = None\n#         self.right = None\n\nclass Solution:\n    def lowestCommonAncestor(self, root: 'TreeNode', p: 'TreeNode', q: 'TreeNode') -> 'TreeNode':\n        " }],
  },
  {
    questionId: "5", questionFrontendId: "5", title: "Longest Palindromic Substring", titleSlug: "longest-palindromic-substring", difficulty: "Medium", isPaidOnly: false,
    content: `<p>Given a string <code>s</code>, return <em>the longest palindromic substring</em> in <code>s</code>.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("s = &quot;babad&quot;", "&quot;bab&quot;", "&quot;aba&quot; is also a valid answer.")}${exTitle(2)}${ex("s = &quot;cbbd&quot;", "&quot;bb&quot;")}`,
    exampleTestcases: '"babad"\n"cbbd"', sampleTestCase: '"babad"',
    metaData: JSON.stringify({ name: "longestPalindrome", params: [{ name: "s", type: "string" }], return: { type: "string" } }),
    topicTags: [{ name: "String", slug: "string" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "class Solution:\n    def longestPalindrome(self, s: str) -> str:\n        " }],
  },
  {
    questionId: "42", questionFrontendId: "42", title: "Trapping Rain Water", titleSlug: "trapping-rain-water", difficulty: "Hard", isPaidOnly: false,
    content: `<p>Given <code>n</code> non-negative integers representing an elevation map where the width of each bar is <code>1</code>, compute how much water it can trap after raining.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("height = [0,1,0,2,1,0,1,3,2,1,2,1]", "6")}${exTitle(2)}${ex("height = [4,2,0,3,2,5]", "9")}`,
    exampleTestcases: "[0,1,0,2,1,0,1,3,2,1,2,1]\n[4,2,0,3,2,5]", sampleTestCase: "[0,1,0,2,1,0,1,3,2,1,2,1]",
    metaData: JSON.stringify({ name: "trap", params: [{ name: "height", type: "integer[]" }], return: { type: "integer" } }),
    topicTags: [{ name: "Array", slug: "array" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "class Solution:\n    def trap(self, height: List[int]) -> int:\n        " }],
  },
  {
    questionId: "88", questionFrontendId: "88", title: "Merge Sorted Array", titleSlug: "merge-sorted-array", difficulty: "Easy", isPaidOnly: false,
    content: `<p>You are given two integer arrays <code>nums1</code> and <code>nums2</code>, sorted in <strong>non-decreasing order</strong>, and two integers <code>m</code> and <code>n</code>. Merge <code>nums2</code> into <code>nums1</code> as one array sorted in non-decreasing order.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("nums1 = [1,2,3,0,0,0], m = 3, nums2 = [2,5,6], n = 3", "[1,2,2,3,5,6]")}${exTitle(2)}${ex("nums1 = [1], m = 1, nums2 = [], n = 0", "[1]")}${exTitle(3)}${ex("nums1 = [0], m = 0, nums2 = [1], n = 1", "[1]")}`,
    exampleTestcases: "[1,2,3,0,0,0]\n3\n[2,5,6]\n3\n[1]\n1\n[]\n0\n[0]\n0\n[1]\n1", sampleTestCase: "[1,2,3,0,0,0]\n3\n[2,5,6]\n3",
    metaData: JSON.stringify({ name: "merge", params: [{ name: "nums1", type: "integer[]" }, { name: "m", type: "integer" }, { name: "nums2", type: "integer[]" }, { name: "n", type: "integer" }], return: { type: "void" }, output: { paramindex: 0 } }),
    topicTags: [{ name: "Array", slug: "array" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: 'class Solution:\n    def merge(self, nums1: List[int], m: int, nums2: List[int], n: int) -> None:\n        """\n        Do not return anything, modify nums1 in-place instead.\n        """\n        ' }],
  },
  {
    questionId: "49", questionFrontendId: "49", title: "Group Anagrams", titleSlug: "group-anagrams", difficulty: "Medium", isPaidOnly: false,
    content: `<p>Given an array of strings <code>strs</code>, group the anagrams together. You can return the answer in <strong>any order</strong>.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("strs = [&quot;eat&quot;,&quot;tea&quot;,&quot;tan&quot;,&quot;ate&quot;,&quot;nat&quot;,&quot;bat&quot;]", "[[&quot;bat&quot;],[&quot;nat&quot;,&quot;tan&quot;],[&quot;ate&quot;,&quot;eat&quot;,&quot;tea&quot;]]")}${exTitle(2)}${ex("strs = [&quot;&quot;]", "[[&quot;&quot;]]")}${exTitle(3)}${ex("strs = [&quot;a&quot;]", "[[&quot;a&quot;]]")}`,
    exampleTestcases: '["eat","tea","tan","ate","nat","bat"]\n[""]\n["a"]', sampleTestCase: '["eat","tea","tan","ate","nat","bat"]',
    metaData: JSON.stringify({ name: "groupAnagrams", params: [{ name: "strs", type: "string[]" }], return: { type: "list<list<string>>" } }),
    topicTags: [{ name: "Hash Table", slug: "hash-table" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "class Solution:\n    def groupAnagrams(self, strs: List[str]) -> List[List[str]]:\n        " }],
  },
  {
    questionId: "412", questionFrontendId: "412", title: "Fizz Buzz", titleSlug: "fizz-buzz", difficulty: "Easy", isPaidOnly: false,
    content: `<p>Given an integer <code>n</code>, return <em>a string array </em><code>answer</code><em> (<strong>1-indexed</strong>)</em>.</p>\n\n<p>&nbsp;</p>\n${exTitle(1)}${ex("n = 3", "[&quot;1&quot;,&quot;2&quot;,&quot;Fizz&quot;]")}${exTitle(2)}${ex("n = 5", "[&quot;1&quot;,&quot;2&quot;,&quot;Fizz&quot;,&quot;4&quot;,&quot;Buzz&quot;]")}`,
    exampleTestcases: "3\n5", sampleTestCase: "3",
    metaData: JSON.stringify({ name: "fizzBuzz", params: [{ name: "n", type: "integer" }], return: { type: "list<string>" } }),
    topicTags: [{ name: "Math", slug: "math" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "class Solution:\n    def fizzBuzz(self, n: int) -> List[str]:\n        " }],
  },
  {
    questionId: "278", questionFrontendId: "278", title: "First Bad Version", titleSlug: "first-bad-version", difficulty: "Easy", isPaidOnly: false,
    content: `<p>You are a product manager and currently leading a team to develop a new product.</p>\n${exTitle(1)}${ex("n = 5, bad = 4", "4")}${exTitle(2)}${ex("n = 1, bad = 1", "1")}`,
    exampleTestcases: "5\n4\n1\n1", sampleTestCase: "5\n4",
    metaData: JSON.stringify({ name: "firstBadVersion", params: [{ name: "n", type: "integer" }, { name: "bad", type: "integer" }], return: { type: "integer" } }),
    topicTags: [{ name: "Binary Search", slug: "binary-search" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: "# The isBadVersion API is already defined for you.\n# def isBadVersion(version: int) -> bool:\n\nclass Solution:\n    def firstBadVersion(self, n: int) -> int:\n        " }],
  },
  {
    questionId: "141", questionFrontendId: "141", title: "Linked List Cycle", titleSlug: "linked-list-cycle", difficulty: "Easy", isPaidOnly: false,
    content: `<p>Given <code>head</code>, the head of a linked list, determine if the linked list has a cycle in it.</p>\n${exTitle(1)}${ex("head = [3,2,0,-4], pos = 1", "true")}${exTitle(2)}${ex("head = [1,2], pos = 0", "true")}${exTitle(3)}${ex("head = [1], pos = -1", "false")}`,
    exampleTestcases: "[3,2,0,-4]\n1\n[1,2]\n0\n[1]\n-1", sampleTestCase: "[3,2,0,-4]\n1",
    metaData: JSON.stringify({ name: "hasCycle", params: [{ name: "head", type: "ListNode", dealloc: false }], return: { type: "boolean" } }),
    topicTags: [{ name: "Linked List", slug: "linked-list" }],
    codeSnippets: [{ lang: "Python3", langSlug: "python3", code: `${LISTNODE_DEF}\nclass Solution:\n    def hasCycle(self, head: Optional[ListNode]) -> bool:\n        ` }],
  },
];

fs.writeFileSync(new URL("./fixtures/problems.json", import.meta.url), JSON.stringify(questions, null, 1));
console.log(`wrote ${questions.length} fixtures`);
