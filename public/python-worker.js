// Module Web Worker: runs the player's Python with Pyodide (CPython compiled to WebAssembly).
// Pyodide 0.28+/314+ only supports module workers, so this file is loaded with {type:"module"}.
// Messages in:  {type:"init", pyodideBases:[url, ...]}
//               {type:"run", id, code, metadata, mode:"run"|"debug"|"judge", inputs:[string]}
// Messages out: {type:"ready"} | {type:"error", error} | {type:"result", id, results:[...]}

let pyodide = null;
let loading = null;

const HARNESS = String.raw`
import ast
import bisect
import collections
import contextlib
import functools
import heapq
import io
import itertools
import json
import math
import operator
import random
import re
import string
import sys
import time
import traceback
from collections import *
from functools import *
from heapq import *
from itertools import *
from math import *
from typing import *

sys.setrecursionlimit(4000)

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

class Node:
    def __init__(self, val=0, children=None, next=None, random=None, left=None, right=None, neighbors=None):
        self.val = val
        self.children = children if children is not None else []
        self.next = next
        self.random = random
        self.left = left
        self.right = right
        self.neighbors = neighbors if neighbors is not None else []

# Everything imported above (typing, collections, heapq, ...) is visible to the
# player's code without imports, matching LeetCode's Python environment.
__DUEL_HELPERS = {k: v for k, v in dict(globals()).items() if not k.startswith("_")}

def __duel_make_list(values):
    dummy = ListNode()
    cursor = dummy
    for value in values or []:
        cursor.next = ListNode(value)
        cursor = cursor.next
    return dummy.next

def __duel_make_tree(values):
    if not values or values[0] is None:
        return None
    root = TreeNode(values[0])
    queue = collections.deque([root])
    index = 1
    while queue and index < len(values):
        node = queue.popleft()
        if index < len(values):
            if values[index] is not None:
                node.left = TreeNode(values[index])
                queue.append(node.left)
            index += 1
        if index < len(values):
            if values[index] is not None:
                node.right = TreeNode(values[index])
                queue.append(node.right)
            index += 1
    return root

def __duel_find_tree_node(root, target):
    stack = [root]
    while stack:
        node = stack.pop()
        if node is None:
            continue
        if node.val == target:
            return node
        stack.append(node.left)
        stack.append(node.right)
    return None

def __duel_base_type(type_name):
    t = (type_name or "").strip()
    depth = 0
    while True:
        if t.startswith("list<") and t.endswith(">"):
            t = t[5:-1]
            depth += 1
        elif t.endswith("[]"):
            t = t[:-2]
            depth += 1
        else:
            break
    return t, depth

def __duel_convert(value, type_name):
    base, depth = __duel_base_type(type_name)
    if base == "ListNode":
        if depth == 0:
            return __duel_make_list(value)
        return [__duel_convert(item, type_name[:-2] if type_name.endswith("[]") else "ListNode") for item in (value or [])]
    if base == "TreeNode":
        if depth == 0:
            if isinstance(value, (int, float, str)) or value is None:
                return value  # node reference by value; resolved against the first tree argument
            return __duel_make_tree(value)
        return [__duel_convert(item, "TreeNode") for item in (value or [])]
    if base in ("double", "float") and depth == 0 and isinstance(value, int) and not isinstance(value, bool):
        return float(value)
    return value

def __duel_resolve_node_refs(arguments, params):
    # LeetCode passes tree-node parameters (e.g. p and q in LCA problems) as plain values.
    first_tree = None
    for arg, param in zip(arguments, params):
        if __duel_base_type(param.get("type", ""))[0] == "TreeNode" and isinstance(arg, TreeNode):
            first_tree = arg
            break
    if first_tree is None:
        return arguments
    resolved = []
    for arg, param in zip(arguments, params):
        base, depth = __duel_base_type(param.get("type", ""))
        if base == "TreeNode" and depth == 0 and isinstance(arg, (int, float, str)):
            found = __duel_find_tree_node(first_tree, arg)
            resolved.append(found if found is not None else arg)
        else:
            resolved.append(arg)
    return resolved

def __duel_serialize(value, _depth=0):
    if _depth > 64:
        return "..."
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return repr(value)
        return value
    if isinstance(value, ListNode):
        output = []
        seen = set()
        while value is not None and id(value) not in seen:
            seen.add(id(value))
            output.append(__duel_serialize(value.val, _depth + 1))
            value = value.next
        return output
    if isinstance(value, TreeNode):
        output = []
        queue = collections.deque([value])
        while queue:
            node = queue.popleft()
            if node is None:
                output.append(None)
                continue
            output.append(__duel_serialize(node.val, _depth + 1))
            queue.append(node.left)
            queue.append(node.right)
        while output and output[-1] is None:
            output.pop()
        return output
    if isinstance(value, dict):
        return {str(key): __duel_serialize(item, _depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset, collections.deque)):
        return [__duel_serialize(item, _depth + 1) for item in value]
    if hasattr(value, "__iter__") and not hasattr(value, "__len__"):
        try:
            return [__duel_serialize(item, _depth + 1) for item in itertools.islice(value, 10000)]
        except Exception:
            return repr(value)
    return repr(value)

def __duel_parse_value(text):
    try:
        return json.loads(text)
    except Exception:
        return ast.literal_eval(text)

def __duel_safe_locals(values):
    output = {}
    for key, value in values.items():
        if key.startswith("__") or key == "self":
            continue
        try:
            rendered = repr(__duel_serialize(value))
        except Exception:
            rendered = "<" + type(value).__name__ + ">"
        output[key] = rendered[:200]
    return output

def __duel_format_error(exc):
    lines = []
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename == "solution.py":
            lines.append('  File "solution.py", line %d, in %s' % (frame.lineno, frame.name))
            if frame.line:
                lines.append("    " + frame.line.strip())
    tail = traceback.format_exception_only(type(exc), exc)
    lines.extend(line.rstrip("\n") for line in tail)
    return "\n".join(lines)[:4000]

def __duel_call_function(namespace, lines, metadata, tracer):
    params = metadata.get("params", [])
    if len(lines) < len(params):
        raise ValueError("Expected %d input line(s) but got %d." % (len(params), len(lines)))
    arguments = [__duel_convert(__duel_parse_value(lines[i]), params[i].get("type", "")) for i in range(len(params))]
    arguments = __duel_resolve_node_refs(arguments, params)
    solution_type = namespace.get("Solution")
    method_name = metadata.get("name")
    if solution_type is None:
        raise NameError("class Solution is not defined.")
    if not method_name or not hasattr(solution_type, method_name):
        raise AttributeError("Solution.%s is not defined." % method_name)
    solution = solution_type()
    method = getattr(solution, method_name)
    if tracer:
        sys.settrace(tracer)
    try:
        returned = method(*arguments)
    finally:
        sys.settrace(None)
    return_type = (metadata.get("return") or {}).get("type", "")
    output_spec = metadata.get("output") or {}
    if return_type == "void" and "paramindex" in output_spec:
        return arguments[output_spec["paramindex"]]
    return returned

def __duel_call_design(namespace, lines, metadata, tracer):
    if len(lines) < 2:
        raise ValueError("Design problems need two input lines: operations and arguments.")
    operations = __duel_parse_value(lines[0])
    arguments = __duel_parse_value(lines[1])
    class_name = metadata.get("classname")
    cls = namespace.get(class_name)
    if cls is None:
        raise NameError("class %s is not defined." % class_name)
    methods = {m.get("name"): m for m in metadata.get("methods", [])}
    ctor_params = (metadata.get("constructor") or {}).get("params", [])
    outputs = []
    instance = None
    if tracer:
        sys.settrace(tracer)
    try:
        for index, op in enumerate(operations):
            args = arguments[index] if index < len(arguments) else []
            if index == 0 and op == class_name:
                converted = [__duel_convert(a, p.get("type", "")) for a, p in zip(args, ctor_params)] if ctor_params else list(args)
                instance = cls(*converted)
                outputs.append(None)
                continue
            if instance is None:
                raise ValueError("The first operation must construct %s." % class_name)
            spec = methods.get(op, {})
            params = spec.get("params", [])
            converted = [__duel_convert(a, p.get("type", "")) for a, p in zip(args, params)] if params else list(args)
            if not hasattr(instance, op):
                raise AttributeError("%s.%s is not defined." % (class_name, op))
            returned = getattr(instance, op)(*converted)
            if (spec.get("return") or {}).get("type") == "void":
                outputs.append(None)
            else:
                outputs.append(returned)
    finally:
        sys.settrace(None)
    return outputs

def __duel_run_case(compiled, input_text, metadata, mode):
    started = time.perf_counter()
    stdout_buffer = io.StringIO()
    trace_rows = []
    result = {"stdout": "", "trace": [], "actual": None, "error": None, "durationMs": 0}

    def tracer(frame, event, arg):
        if frame.f_code.co_filename == "solution.py" and event == "line" and len(trace_rows) < 300:
            trace_rows.append({"line": frame.f_lineno, "locals": __duel_safe_locals(frame.f_locals)})
        return tracer

    try:
        lines = [line.strip() for line in (input_text or "").split("\n") if line.strip() != ""]
        namespace = dict(__DUEL_HELPERS)
        namespace["__name__"] = "solution"
        namespace["__builtins__"] = __builtins__
        with contextlib.redirect_stdout(stdout_buffer):
            exec(compiled, namespace, namespace)
            if metadata.get("classname"):
                actual = __duel_call_design(namespace, lines, metadata, tracer if mode == "debug" else None)
            else:
                actual = __duel_call_function(namespace, lines, metadata, tracer if mode == "debug" else None)
        result["actual"] = __duel_serialize(actual)
    except RecursionError as exc:
        result["error"] = "RecursionError: maximum recursion depth exceeded"
    except BaseException as exc:
        result["error"] = __duel_format_error(exc)
    finally:
        sys.settrace(None)
    result["stdout"] = stdout_buffer.getvalue()[:20000]
    result["trace"] = trace_rows
    result["durationMs"] = round((time.perf_counter() - started) * 1000, 2)
    return result

def __duel_run(code, inputs_json, metadata_json, mode):
    inputs = json.loads(inputs_json)
    try:
        metadata = json.loads(metadata_json or "{}")
    except Exception:
        metadata = {}
    try:
        compiled = compile(code, "solution.py", "exec")
    except SyntaxError as exc:
        message = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        return json.dumps([{"stdout": "", "trace": [], "actual": None, "error": message, "durationMs": 0} for _ in inputs])
    results = []
    for index, input_text in enumerate(inputs):
        results.append(__duel_run_case(compiled, input_text, metadata, mode if index == 0 else "run"))
    return json.dumps(results)
`;

// Tries each base URL in turn (CDN first, then fallbacks) until Pyodide loads.
async function init(bases) {
  if (!loading) {
    loading = (async () => {
      const candidates = (Array.isArray(bases) ? bases : [bases]).filter(Boolean);
      const problems = [];
      for (const base of candidates) {
        try {
          const { loadPyodide } = await import(/* @vite-ignore */ `${base}pyodide.mjs`);
          const instance = await loadPyodide({ indexURL: base });
          instance.runPython(HARNESS);
          pyodide = instance;
          return;
        } catch (error) {
          problems.push(`${base}: ${error && error.message ? error.message : error}`);
        }
      }
      throw new Error(problems.join(" | ") || "no Pyodide source configured");
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    try {
      await init(message.pyodideBases || message.pyodideBase);
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({ type: "error", error: `Python failed to load: ${error && error.message ? error.message : error}` });
    }
    return;
  }
  if (message.type === "run") {
    try {
      if (!pyodide) await init(message.pyodideBases || message.pyodideBase);
      pyodide.globals.set("__duel_code", String(message.code || ""));
      pyodide.globals.set("__duel_inputs", JSON.stringify(message.inputs || []));
      pyodide.globals.set("__duel_metadata", JSON.stringify(message.metadata || {}));
      pyodide.globals.set("__duel_mode", message.mode === "debug" ? "debug" : "run");
      const raw = pyodide.runPython("__duel_run(__duel_code, __duel_inputs, __duel_metadata, __duel_mode)");
      self.postMessage({ type: "result", id: message.id, results: JSON.parse(raw) });
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      self.postMessage({
        type: "result",
        id: message.id,
        results: (message.inputs || [""]).map(() => ({ stdout: "", trace: [], actual: null, error: text, durationMs: 0 })),
      });
    }
  }
};
