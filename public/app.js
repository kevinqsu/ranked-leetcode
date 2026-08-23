// 1v1 — LeetCode duels. Vanilla JS, no build step.
import { parseLiteral, outputsMatch, formatValue, classifyError } from "./judge.js";

const CONFIG = window.CODEDUEL_CONFIG || {};
const pyodideOverride = new URLSearchParams(location.search).get("pyodide");
const PYODIDE_BASES = pyodideOverride ? pyodideOverride.split(",") : CONFIG.pyodideBases || [CONFIG.pyodideBase];
const DIFFICULTIES = ["easy", "medium", "hard"];
const RUN_TIMEOUT = 12000;
const JUDGE_TIMEOUT = 25000;

// ---------------------------------------------------------------------------
// persistent bits

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function sessionId() {
  let id = storageGet("duel-session");
  if (!id || !/^[a-zA-Z0-9-]{12,64}$/.test(id)) {
    id = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    storageSet("duel-session", id);
  }
  return id;
}

function loadSettings() {
  try {
    const saved = JSON.parse(storageGet("duel-settings") || "{}");
    return {
      difficulty: DIFFICULTIES.includes(saved.difficulty) ? saved.difficulty : "medium",
      mode: saved.mode === "practice" ? "practice" : "duel",
      judging: saved.judging === "leetcode" ? "leetcode" : "examples",
      problem: typeof saved.problem === "string" ? saved.problem : "",
    };
  } catch {
    return { difficulty: "medium", mode: "duel", judging: "examples", problem: "" };
  }
}

// ---------------------------------------------------------------------------
// state

const state = {
  session: sessionId(),
  name: storageGet("duel-name") || "",
  settings: loadSettings(),
  view: null,
  mode: "home", // home | practice | duel | spectate
  duelId: null,
  problem: null,
  testInput: "",
  results: { tab: "testcase", run: null, debug: null, running: false, selectedCase: 0 },
  cases: [],
  activeCase: 0,
  submissions: [],
  activeSubmission: null,
  leftTab: "description",
  metric: "runtime",
  submitting: false,
  bannerDismissed: null,
  busy: false,
  lookup: { query: "", status: "", text: "", ok: null, timer: null, summary: null },
  notice: "",
  pythonStatus: "idle", // idle | loading | ready | error
  connection: "connecting",
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const displayName = () => (state.name.trim() || "Guest").slice(0, 20);
const me = () => state.view?.me?.id || state.session;

function saveSettings() {
  storageSet("duel-settings", JSON.stringify(state.settings));
}

function setName(name) {
  state.name = String(name || "").slice(0, 20);
  storageSet("duel-name", state.name);
  const input = $("name");
  if (input && input.value !== state.name) input.value = state.name;
  wsSend({ type: "name", name: displayName() });
}

function toast(message, kind = "error", ms = 4500) {
  const el = $("toast");
  if (!message) {
    el.hidden = true;
    return;
  }
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON */
  }
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
  return payload;
}

function duelAction(action, extra = {}) {
  return api("/api/duels", {
    method: "POST",
    body: JSON.stringify({ action, sessionId: state.session, name: displayName(), ...extra }),
  });
}

// ---------------------------------------------------------------------------
// live connection (WebSocket with polling fallback)

const live = { ws: null, pollTimer: null, retryTimer: null, failures: 0 };

function connect() {
  if (live.ws) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let ws;
  try {
    ws = new WebSocket(`${protocol}//${location.host}/ws?sessionId=${encodeURIComponent(state.session)}&name=${encodeURIComponent(displayName())}`);
  } catch {
    return startPolling();
  }
  live.ws = ws;
  const openTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) ws.close();
  }, 5000);
  ws.onopen = () => {
    clearTimeout(openTimer);
    live.failures = 0;
    stopPolling();
    state.connection = "live";
  };
  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "view") applyView(message.view);
  };
  ws.onclose = () => {
    clearTimeout(openTimer);
    if (live.ws === ws) live.ws = null;
    live.failures += 1;
    state.connection = "reconnecting";
    if (live.failures >= 2) startPolling();
    clearTimeout(live.retryTimer);
    live.retryTimer = setTimeout(connect, Math.min(15000, 1000 * live.failures));
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function wsSend(message) {
  if (live.ws && live.ws.readyState === WebSocket.OPEN) live.ws.send(JSON.stringify(message));
}

async function pollOnce() {
  try {
    const view = await api(`/api/view?sessionId=${encodeURIComponent(state.session)}`);
    applyView(view);
  } catch {
    /* try again later */
  }
}

function startPolling() {
  if (live.pollTimer) return;
  pollOnce();
  live.pollTimer = setInterval(pollOnce, 2500);
}

function stopPolling() {
  clearInterval(live.pollTimer);
  live.pollTimer = null;
}

// ---------------------------------------------------------------------------
// Python runner (Pyodide in a worker)

const py = {
  worker: null,
  ready: null,
  pending: new Map(),
  ensure() {
    if (this.worker) return this.ready;
    state.pythonStatus = "loading";
    updateBar();
    const worker = new Worker("python-worker.js?v=2", { type: "module" });
    this.worker = worker;
    this.ready = new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (message.type === "ready") {
          state.pythonStatus = "ready";
          updateBar();
          resolve();
        } else if (message.type === "error") {
          state.pythonStatus = "error";
          updateBar();
          reject(new Error(message.error));
          this.reset();
        } else if (message.type === "result") {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(message.id);
          entry.resolve(message.results);
        }
      };
      worker.onerror = (event) => {
        state.pythonStatus = "error";
        updateBar();
        reject(new Error(event.message || "Python failed to load."));
        this.reset();
      };
    });
    worker.postMessage({ type: "init", pyodideBases: PYODIDE_BASES });
    return this.ready;
  },
  reset() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Python runtime was reset."));
    }
    this.pending.clear();
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.ready = null;
    if (state.pythonStatus !== "error") state.pythonStatus = "idle";
  },
  async run({ code, metadata, inputs, mode, timeout }) {
    await this.ensure();
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.reset();
        resolve(inputs.map(() => ({ stdout: "", trace: [], actual: null, error: "Time Limit Exceeded (the run was stopped)", durationMs: timeout })));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: "run", id, code, metadata, inputs, mode, pyodideBases: PYODIDE_BASES });
    });
  },
};

// ---------------------------------------------------------------------------
// editor (CodeMirror with a textarea fallback)

const editor = {
  view: null,
  textarea: null,
  themeCompartment: null,
  create(container, doc) {
    const CM = window.CM;
    if (CM && CM.EditorView) {
      this.themeCompartment = new CM.Compartment();
      const runKeymap = CM.keymap.of([
        { key: "Mod-Enter", run: () => (runCode("run"), true) },
        { key: "Mod-Shift-Enter", run: () => (submitCode(), true) },
        CM.indentWithTab,
      ]);
      this.view = new CM.EditorView({
        state: CM.EditorState.create({
          doc,
          extensions: [
            runKeymap,
            CM.basicSetup,
            CM.python(),
            CM.indentUnit.of("    "),
            this.themeCompartment.of(currentTheme() === "dark" ? CM.oneDark : []),
            CM.EditorView.updateListener.of((update) => {
              if (update.docChanged) scheduleCodeSave();
            }),
          ],
        }),
        parent: container,
      });
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.className = "editor-fallback";
    textarea.spellcheck = false;
    textarea.value = doc;
    textarea.addEventListener("input", scheduleCodeSave);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = `${textarea.value.slice(0, start)}    ${textarea.value.slice(end)}`;
        textarea.selectionStart = textarea.selectionEnd = start + 4;
        scheduleCodeSave();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) submitCode();
        else runCode("run");
      }
    });
    container.appendChild(textarea);
    this.textarea = textarea;
  },
  getCode() {
    if (this.view) return this.view.state.doc.toString();
    return this.textarea ? this.textarea.value : "";
  },
  setCode(code) {
    if (this.view) {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: code } });
    } else if (this.textarea) this.textarea.value = code;
  },
  setTheme(theme) {
    if (this.view && this.themeCompartment) {
      this.view.dispatch({ effects: this.themeCompartment.reconfigure(theme === "dark" ? window.CM.oneDark : []) });
    }
  },
  destroy() {
    if (this.view) this.view.destroy();
    this.view = null;
    this.textarea = null;
  },
  focus() {
    if (this.view) this.view.focus();
    else if (this.textarea) this.textarea.focus();
  },
};

let codeSaveTimer = null;
function scheduleCodeSave() {
  clearTimeout(codeSaveTimer);
  codeSaveTimer = setTimeout(() => {
    if (state.problem) storageSet(`duel-code:${state.problem.titleSlug}`, editor.getCode());
  }, 400);
}

function savedCode(slug) {
  return storageGet(`duel-code:${slug}`);
}

// ---------------------------------------------------------------------------
// theme

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  storageSet("duel-theme", theme);
  $("theme-button").textContent = theme === "dark" ? "Light" : "Dark";
  editor.setTheme(theme);
}

// ---------------------------------------------------------------------------
// view reconciliation

function myDuel() {
  return state.view?.duel || null;
}

function applyView(view) {
  state.view = view;
  $("online-pill").textContent = `${view.online} online`;
  updateLcButton();
  if (view.me?.linked && view.me.leetcodeUser && !state.name.trim()) setName(view.me.leetcodeUser);

  if (state.mode === "spectate") {
    if (!view.watch) return goHome("That duel is over.");
    renderSpectate();
    return;
  }

  const duel = view.duel;
  if (duel && (duel.status === "active" || duel.status === "starting")) {
    if (state.mode !== "duel" || state.duelId !== duel.id) {
      state.mode = "duel";
      state.duelId = duel.id;
      state.problem = null;
    }
    if (duel.status === "starting") {
      renderHome();
    } else if (duel.problem && (!state.problem || state.problem.titleSlug !== duel.problem.slug)) {
      openProblem({ slug: duel.problem.slug });
    } else {
      updateBar();
      updateGameOver();
    }
    return;
  }
  if (duel && duel.status === "open") {
    if (state.mode !== "duel" || state.duelId !== duel.id) {
      state.mode = "duel";
      state.duelId = duel.id;
      state.problem = null;
    }
    renderHome();
    return;
  }
  if (duel && duel.status === "complete" && state.mode === "duel" && state.duelId === duel.id) {
    if (duel.problem && (!state.problem || state.problem.titleSlug !== duel.problem.slug)) openProblem({ slug: duel.problem.slug });
    else {
      updateBar();
      updateGameOver();
    }
    return;
  }
  if (state.mode === "duel") {
    const expired = duel && duel.status === "cancelled" && duel.endReason === "expired";
    return goHome(expired ? "Your challenge expired without an opponent." : "");
  }
  if (state.mode === "home") renderHome();
  else updateBar();
}

// ---------------------------------------------------------------------------
// screens: home (setup + lobby sidebar)

function renderHome() {
  const screen = $("screen");
  if (!screen.querySelector(".home")) {
    editor.destroy();
    screen.innerHTML = `
      <div class="home">
        <aside class="side">
          <div><h2>Challenges</h2><div class="list" id="challenge-list"></div></div>
          <div><h2>Spectate</h2><div class="list" id="game-list"></div></div>
          <div class="side-foot">First to pass the examples wins.<br />Python 3 runs in your browser.</div>
        </aside>
        <section class="main" id="home-main"></section>
      </div>`;
  }
  updateSidebar();
  updateHomeMain();
  updateBar();
  updateGameOver();
}

function updateSidebar() {
  const view = state.view;
  const challenges = $("challenge-list");
  const games = $("game-list");
  if (!challenges || !games) return;
  const list = view?.challenges || [];
  challenges.innerHTML = list.length
    ? list
        .map(
          (c) => `
          <button type="button" data-accept="${escapeHtml(c.id)}" ${state.busy ? "disabled" : ""} title="Accept this challenge">
            <div class="row"><strong>${escapeHtml(c.creatorName)}</strong><span>${escapeHtml(c.difficulty)}</span></div>
            <div class="sub">${c.problem ? `#${escapeHtml(c.problem.id)} ${escapeHtml(c.problem.title)}` : "Random problem"}${c.judging === "leetcode" ? " · LeetCode judged" : ""}</div>
          </button>`,
        )
        .join("")
    : `<div class="empty-list">No open challenges</div>`;
  const active = view?.games || [];
  games.innerHTML = active.length
    ? active
        .map(
          (g) => `
          <button type="button" data-watch="${escapeHtml(g.id)}" title="Watch this duel">
            <div class="row"><strong>${escapeHtml(g.creatorName)} vs ${escapeHtml(g.opponentName)}</strong><span>${escapeHtml(g.difficulty)}</span></div>
            <div class="sub">#${escapeHtml(g.problem.id)} ${escapeHtml(g.problem.title)}</div>
          </button>`,
        )
        .join("")
    : `<div class="empty-list">No duels in progress</div>`;
  challenges.querySelectorAll("[data-accept]").forEach((button) => button.addEventListener("click", () => acceptChallenge(button.dataset.accept)));
  games.querySelectorAll("[data-watch]").forEach((button) => button.addEventListener("click", () => watchDuel(button.dataset.watch)));
}

function updateHomeMain() {
  const main = $("home-main");
  if (!main) return;
  const duel = myDuel();
  if (state.mode === "duel" && duel && (duel.status === "open" || duel.status === "starting")) {
    const starting = duel.status === "starting";
    const what = duel.requestedProblem ? `#${escapeHtml(duel.requestedProblem.id)} ${escapeHtml(duel.requestedProblem.title)}` : `a ${escapeHtml(duel.difficulty.toLowerCase())} problem`;
    main.innerHTML = `
      <div class="waiting">
        <div class="waiting-line">
          <span class="spinner"></span>
          <span>${starting ? "Opponent found — picking a problem…" : `Waiting for someone to accept your challenge (${what})…`}</span>
          ${starting ? "" : `<button type="button" class="small-button" id="cancel-challenge">Cancel</button>`}
        </div>
        <div class="waiting-sub">${escapeHtml(displayName())} · ${duel.judging === "leetcode" ? "judged on LeetCode submissions" : "first to pass all examples wins"}<br />Anyone who posts a matching challenge gets paired with you automatically.</div>
      </div>`;
    $("cancel-challenge")?.addEventListener("click", () => leaveDuel());
    return;
  }
  if (main.querySelector(".setup")) {
    syncSetupForm();
    return;
  }
  const s = state.settings;
  main.innerHTML = `
    <form class="setup" id="setup-form" autocomplete="off">
      <h1>LeetCode 1v1</h1>
      <p class="lead">Same problem, same clock. First accepted solution wins.</p>
      <label class="control-label" for="name">Name</label>
      <input id="name" class="text-input" maxlength="20" placeholder="Guest" value="${escapeHtml(state.name)}" />
      <fieldset class="control-group">
        <legend>Difficulty</legend>
        <div class="segments three" id="difficulty-segments">
          ${DIFFICULTIES.map((d) => `<button type="button" class="${d} ${s.difficulty === d ? "selected" : ""}" data-difficulty="${d}">${d[0].toUpperCase()}${d.slice(1)}</button>`).join("")}
        </div>
      </fieldset>
      <fieldset class="control-group">
        <legend>Problem</legend>
        <input id="problem-query" class="text-input" placeholder="Random — or a problem number, slug or URL" value="${escapeHtml(s.problem)}" />
        <p class="hint" id="problem-hint"></p>
      </fieldset>
      <fieldset class="control-group">
        <legend>Mode</legend>
        <div class="segments two" id="mode-segments">
          <button type="button" data-mode="practice" class="${s.mode === "practice" ? "selected" : ""}">Practice</button>
          <button type="button" data-mode="duel" class="${s.mode === "duel" ? "selected" : ""}">Duel</button>
        </div>
      </fieldset>
      <fieldset class="control-group" id="judging-group">
        <legend>Judging</legend>
        <div class="segments two" id="judging-segments">
          <button type="button" data-judging="examples" class="${s.judging === "examples" ? "selected" : ""}">Examples in browser</button>
          <button type="button" data-judging="leetcode" class="${s.judging === "leetcode" ? "selected" : ""}">LeetCode account</button>
        </div>
        <p class="hint" id="judging-hint"></p>
      </fieldset>
      <p class="form-error" id="form-error" hidden></p>
      <button class="play-button" type="submit" id="play-button">Play</button>
    </form>`;

  $("name").addEventListener("input", (event) => {
    state.name = event.target.value;
    storageSet("duel-name", state.name);
    clearTimeout(updateHomeMain.nameTimer);
    updateHomeMain.nameTimer = setTimeout(() => wsSend({ type: "name", name: displayName() }), 500);
  });
  $("difficulty-segments").addEventListener("click", (event) => {
    const button = event.target.closest("[data-difficulty]");
    if (!button) return;
    state.settings.difficulty = button.dataset.difficulty;
    saveSettings();
    syncSetupForm();
  });
  $("mode-segments").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (!button) return;
    state.settings.mode = button.dataset.mode;
    saveSettings();
    syncSetupForm();
  });
  $("judging-segments").addEventListener("click", (event) => {
    const button = event.target.closest("[data-judging]");
    if (!button || button.disabled) return;
    state.settings.judging = button.dataset.judging;
    saveSettings();
    syncSetupForm();
  });
  const problemInput = $("problem-query");
  problemInput.addEventListener("input", () => {
    state.settings.problem = problemInput.value.trim();
    saveSettings();
    scheduleLookup();
  });
  problemInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("play-button").click();
    }
  });
  $("setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    play();
  });
  syncSetupForm();
  if (state.settings.problem) scheduleLookup(0);
}

function syncSetupForm() {
  const s = state.settings;
  const form = $("setup-form");
  if (!form) return;
  form.querySelectorAll("[data-difficulty]").forEach((b) => b.classList.toggle("selected", b.dataset.difficulty === s.difficulty));
  form.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("selected", b.dataset.mode === s.mode));
  const linked = !!state.view?.me?.linked;
  const leetButton = form.querySelector('[data-judging="leetcode"]');
  leetButton.disabled = !linked;
  if (!linked && s.judging === "leetcode") s.judging = "examples";
  form.querySelectorAll("[data-judging]").forEach((b) => b.classList.toggle("selected", b.dataset.judging === s.judging));
  $("judging-hint").textContent = linked
    ? s.judging === "leetcode"
      ? `Submissions go to LeetCode as ${state.view.me.leetcodeUser || "your account"} — hidden tests count. Opponents must link an account too.`
      : "The problem's example tests run in your browser; first to pass them all wins."
    : "Link a LeetCode account (top right) to judge on real submissions instead of the examples.";
  const hint = $("problem-hint");
  const lookup = state.lookup;
  hint.textContent = lookup.text;
  hint.className = `hint ${lookup.ok === true ? "ok" : lookup.ok === false ? "bad" : ""}`;
  $("play-button").disabled = state.busy;
  $("play-button").textContent = state.busy ? "Loading…" : s.mode === "duel" ? "Find a duel" : "Practice";
  form.querySelectorAll("[data-difficulty]").forEach((b) => (b.disabled = !!(lookup.ok && lookup.summary)));
}

function scheduleLookup(delay = 450) {
  clearTimeout(state.lookup.timer);
  const query = state.settings.problem.trim();
  if (!query) {
    state.lookup = { ...state.lookup, query: "", text: "", ok: null, summary: null };
    syncSetupForm();
    return;
  }
  state.lookup = { ...state.lookup, query, text: "Looking up…", ok: null, summary: null };
  syncSetupForm();
  state.lookup.timer = setTimeout(async () => {
    try {
      const { problem } = await api(`/api/problem/lookup?q=${encodeURIComponent(query)}`);
      if (state.settings.problem.trim() !== query) return;
      const judged = problem.judgeable ? "" : ` — ${problem.judgeNote} Practice only.`;
      state.lookup = { ...state.lookup, text: `#${problem.id} ${problem.title} · ${problem.difficulty}${judged}`, ok: problem.judgeable, summary: problem };
    } catch (error) {
      if (state.settings.problem.trim() !== query) return;
      state.lookup = { ...state.lookup, text: error.message, ok: false, summary: null };
    }
    syncSetupForm();
  }, delay);
}

function showFormError(message) {
  const el = $("form-error");
  if (!el) return toast(message);
  el.textContent = message;
  el.hidden = !message;
}

async function play() {
  if (state.busy) return;
  const s = state.settings;
  const query = s.problem.trim();
  if (query && state.lookup.ok === null) {
    showFormError("Still looking up that problem — try again in a second.");
    return;
  }
  if (query && state.lookup.ok === false && !state.lookup.summary) {
    showFormError("That problem could not be found. Clear the box for a random one.");
    return;
  }
  showFormError("");
  setBusy(true);
  try {
    if (s.mode === "practice") {
      const problem = query
        ? (await api(`/api/problem?q=${encodeURIComponent(query)}`)).problem
        : (await api(`/api/problem/random?difficulty=${s.difficulty}`)).problem;
      state.mode = "practice";
      state.duelId = null;
      loadProblem(problem);
    } else {
      if (query && state.lookup.summary && !state.lookup.summary.judgeable && s.judging !== "leetcode") {
        throw new Error(`#${state.lookup.summary.id} cannot be auto-judged, so it can only be used for practice (or with LeetCode-account judging).`);
      }
      const { duel } = await duelAction("create", { difficulty: s.difficulty, judging: s.judging, problem: query });
      state.mode = "duel";
      state.duelId = duel.id;
      state.problem = null;
      if (duel.status === "active" && duel.problem) await openProblem({ slug: duel.problem.slug });
      else renderHome();
    }
  } catch (error) {
    showFormError(error.message);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  state.busy = busy;
  syncSetupForm();
  updateSidebar();
}

async function acceptChallenge(duelId) {
  if (state.busy) return;
  setBusy(true);
  try {
    const { duel } = await duelAction("accept", { duelId });
    state.mode = "duel";
    state.duelId = duel.id;
    state.problem = null;
    if (duel.problem) await openProblem({ slug: duel.problem.slug });
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function watchDuel(duelId) {
  try {
    await duelAction("watch", { duelId });
    state.mode = "spectate";
    state.duelId = duelId;
    state.problem = null;
    wsSend({ type: "watch", duelId });
    pollOnce();
  } catch (error) {
    toast(error.message);
  }
}

function goHome(message) {
  const wasDuel = state.mode === "duel" || state.mode === "spectate";
  if (state.mode === "spectate") {
    duelAction("watch", { duelId: null }).catch(() => {});
    wsSend({ type: "watch", duelId: null });
  }
  state.mode = "home";
  state.duelId = null;
  state.problem = null;
  state.results = { tab: "testcase", run: null, debug: null, running: false, selectedCase: 0 };
  state.activeSubmission = null;
  state.bannerDismissed = null;
  closeModal();
  renderHome();
  if (message) toast(message, "info");
  if (wasDuel) updateGameOver();
}

async function leaveDuel({ forfeit = false } = {}) {
  const duel = myDuel();
  try {
    if (duel && state.mode === "duel") await duelAction("leave", { duelId: duel.id, forfeit });
  } catch (error) {
    toast(error.message);
    return;
  }
  goHome();
}

function homeButton() {
  const duel = myDuel();
  if (state.mode === "duel" && duel && duel.status === "active") {
    const opponent = duel.players.find((p) => p.id !== me());
    openModal(`
      <h2>Leave the duel?</h2>
      <p>Leaving now forfeits the duel${opponent ? ` to ${escapeHtml(opponent.name)}` : ""}.</p>
      <div class="actions">
        <button type="button" class="small-button" data-close>Stay</button>
        <button type="button" class="small-button danger" id="confirm-forfeit">Forfeit and leave</button>
      </div>`);
    $("confirm-forfeit").addEventListener("click", () => {
      closeModal();
      leaveDuel({ forfeit: true });
    });
    return;
  }
  if (state.mode === "duel") return leaveDuel();
  goHome();
}

// ---------------------------------------------------------------------------
// screens: workspace

const ICONS = {
  play: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4.5 2.8v10.4a.5.5 0 0 0 .76.43l8.2-5.2a.5.5 0 0 0 0-.86l-8.2-5.2a.5.5 0 0 0-.76.43z" fill="currentColor"/></svg>',
  upload: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.8l3.6 3.6-1.1 1.1-1.7-1.7V10H6.2V4.8L4.5 6.5 3.4 5.4 8 1.8zM3 12.2h10V14H3z" fill="currentColor"/></svg>',
  bug: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5.5 4.5a2.5 2.5 0 0 1 5 0V5h-5v-.5zM4 6.5h8v3a4 4 0 0 1-8 0v-3z" fill="currentColor"/><path d="M2 7h2M12 7h2M2.5 11l1.6-.8M13.5 11l-1.6-.8M8 9.5v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  chip: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="6" y="6" width="4" height="4" fill="currentColor"/><path d="M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2" stroke="currentColor" stroke-width="1.3"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const paneSizes = {
  left: clamp(Number(storageGet("duel-pane-left")) || 44, 25, 70),
  editor: clamp(Number(storageGet("duel-pane-editor")) || 60, 20, 85),
};

async function openProblem({ slug }) {
  if (openProblem.inflight === slug) return;
  openProblem.inflight = slug;
  try {
    const { problem } = await api(`/api/problem?slug=${encodeURIComponent(slug)}`);
    if (state.mode === "duel" && myDuel()?.problem?.slug !== slug && myDuel()?.status !== "complete") return;
    loadProblem(problem);
  } catch (error) {
    toast(`Could not load the problem: ${error.message}`);
  } finally {
    if (openProblem.inflight === slug) openProblem.inflight = null;
  }
}

function paramLabels(problem) {
  const meta = problem?.metaData || {};
  if (meta.classname) return ["operations", "arguments"];
  const names = (meta.params || []).map((p, i) => p.name || `arg${i + 1}`);
  return names.length ? names : ["input"];
}

function splitInput(problem, input) {
  const count = paramLabels(problem).length;
  const lines = String(input || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  while (lines.length < count) lines.push("");
  return lines.slice(0, count);
}

function loadCases(problem) {
  const examples = problem.examples.map((example, index) => ({ lines: splitInput(problem, example.input), example: index }));
  let custom = [];
  try {
    custom = JSON.parse(storageGet(`duel-cases:${problem.titleSlug}`) || "[]");
  } catch {
    custom = [];
  }
  const extras = (Array.isArray(custom) ? custom : [])
    .filter((entry) => entry && Array.isArray(entry.lines))
    .map((entry) => ({ lines: entry.lines.map(String), example: null }));
  const cases = [...examples, ...extras];
  return cases.length ? cases : [{ lines: splitInput(problem, problem.sampleTestCase || ""), example: null }];
}

function saveCustomCases() {
  if (!state.problem) return;
  storageSet(`duel-cases:${state.problem.titleSlug}`, JSON.stringify(state.cases.filter((c) => c.example === null).map((c) => ({ lines: c.lines }))));
}

const caseInput = (testCase) => testCase.lines.join("\n");

function loadSubmissions(slug) {
  try {
    const list = JSON.parse(storageGet(`duel-subs:${slug}`) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveSubmissions() {
  if (!state.problem) return;
  storageSet(`duel-subs:${state.problem.titleSlug}`, JSON.stringify(state.submissions.slice(0, 15)));
}

function loadProblem(problem) {
  state.problem = problem;
  state.cases = loadCases(problem);
  state.activeCase = 0;
  state.results = { tab: "testcase", run: null, debug: null, running: false, selectedCase: 0 };
  state.submissions = loadSubmissions(problem.titleSlug);
  state.activeSubmission = null;
  state.leftTab = "description";
  state.metric = "runtime";
  renderWorkspace();
  py.ensure().catch(() => {});
}

function renderWorkspace() {
  const problem = state.problem;
  const screen = $("screen");
  editor.destroy();
  screen.innerHTML = `
    <div class="workspace" id="workspace" style="--left-pct:${paneSizes.left}%;--editor-pct:${paneSizes.editor}%">
      <section class="problem-pane">
        <div class="pane-title tabs" id="left-tabs">
          <button type="button" data-left="description" class="tab">Description</button>
          <button type="button" data-left="result" class="tab" hidden>Result</button>
          <button type="button" data-left="submissions" class="tab">Submissions</button>
          <span class="grow"></span>
          ${state.mode === "practice" ? `<button type="button" class="link-button" id="new-problem">New problem</button>` : ""}
          <a class="link-button" href="${escapeHtml(problem.sourceUrl)}" target="_blank" rel="noopener">LeetCode ↗</a>
        </div>
        <div class="problem-scroll" id="left-body"></div>
      </section>
      <div class="gutter vertical" id="gutter-v" title="Drag to resize"></div>
      <section class="code-pane">
        <div class="editor-panel">
          <div class="pane-title editor-title"><span class="tab active">&lt;/&gt; Code</span><span class="grow"></span>
            <button type="button" class="link-button" id="reset-code" title="Restore the starter code">Reset</button>
            <span class="muted">Python3</span>
          </div>
          <div class="editor-wrap" id="editor-wrap"></div>
        </div>
        <div class="gutter horizontal" id="gutter-h" title="Drag to resize"></div>
        <div class="result-panel">
          <div class="pane-title result-tabs" id="result-tabs">
            <button type="button" data-tab="testcase" class="tab">${ICONS.check} Testcase</button>
            <button type="button" data-tab="result" class="tab">${ICONS.play} Test Result</button>
            <button type="button" data-tab="debug" class="tab">${ICONS.bug} Debug</button>
          </div>
          <div id="result-body" class="result-body"></div>
        </div>
      </section>
    </div>`;

  const starter = problem.starterCode.trimEnd().endsWith(":") ? `${problem.starterCode.trimEnd()}\n        pass` : problem.starterCode;
  editor.create($("editor-wrap"), savedCode(problem.titleSlug) ?? starter);
  $("reset-code").addEventListener("click", () => {
    editor.setCode(starter);
    scheduleCodeSave();
    editor.focus();
  });
  $("new-problem")?.addEventListener("click", newPracticeProblem);
  $("left-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-left]");
    if (!button) return;
    state.leftTab = button.dataset.left;
    renderLeft();
  });
  $("result-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    state.results.tab = button.dataset.tab;
    renderResults();
  });
  installGutters();
  renderLeft();
  renderResults();
  updateBar();
  updateGameOver();
  if (window.innerWidth > 860) editor.focus();
}

function installGutters() {
  const workspace = $("workspace");
  const codePane = workspace.querySelector(".code-pane");
  const bind = (gutter, axis) => {
    if (!gutter) return;
    gutter.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      gutter.setPointerCapture(event.pointerId);
      gutter.classList.add("dragging");
      document.body.classList.add("resizing");
      const move = (e) => {
        if (axis === "x") {
          const rect = workspace.getBoundingClientRect();
          paneSizes.left = clamp(((e.clientX - rect.left) / rect.width) * 100, 25, 70);
          workspace.style.setProperty("--left-pct", `${paneSizes.left}%`);
        } else {
          const rect = codePane.getBoundingClientRect();
          paneSizes.editor = clamp(((e.clientY - rect.top) / rect.height) * 100, 20, 85);
          workspace.style.setProperty("--editor-pct", `${paneSizes.editor}%`);
        }
      };
      const stop = () => {
        gutter.removeEventListener("pointermove", move);
        gutter.removeEventListener("pointerup", stop);
        gutter.removeEventListener("pointercancel", stop);
        gutter.classList.remove("dragging");
        document.body.classList.remove("resizing");
        storageSet("duel-pane-left", String(Math.round(paneSizes.left)));
        storageSet("duel-pane-editor", String(Math.round(paneSizes.editor)));
        const sub = state.activeSubmission !== null ? state.submissions[state.activeSubmission] : null;
        if (state.leftTab === "result" && sub) renderLeft();
      };
      gutter.addEventListener("pointermove", move);
      gutter.addEventListener("pointerup", stop);
      gutter.addEventListener("pointercancel", stop);
    });
  };
  bind($("gutter-v"), "x");
  bind($("gutter-h"), "y");
}

async function newPracticeProblem() {
  if (state.busy) return;
  state.busy = true;
  updateBar();
  try {
    const exclude = state.problem ? state.problem.titleSlug : "";
    const { problem } = await api(`/api/problem/random?difficulty=${state.settings.difficulty}&exclude=${encodeURIComponent(exclude)}`);
    loadProblem(problem);
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
    updateBar();
  }
}

// ------------------------------------------------------------- left pane

function renderLeft() {
  const body = $("left-body");
  if (!body || !state.problem) return;
  const hasResult = state.activeSubmission !== null && state.submissions[state.activeSubmission];
  const resultTab = document.querySelector('[data-left="result"]');
  if (resultTab) {
    resultTab.hidden = !hasResult;
    if (hasResult) {
      const sub = state.submissions[state.activeSubmission];
      resultTab.innerHTML = `<span class="dot ${sub.accepted ? "good" : "bad"}"></span>${sub.accepted ? "Accepted" : escapeHtml(sub.verdict)}`;
    }
  }
  if (state.leftTab === "result" && !hasResult) state.leftTab = "description";
  document.querySelectorAll("#left-tabs [data-left]").forEach((b) => b.classList.toggle("active", b.dataset.left === state.leftTab));
  body.scrollTop = 0;
  if (state.leftTab === "submissions") body.innerHTML = renderSubmissionsList();
  else if (state.leftTab === "result") {
    body.innerHTML = renderSubmissionPanel(state.submissions[state.activeSubmission]);
    mountSubmissionPanel(state.submissions[state.activeSubmission]);
  } else body.innerHTML = renderDescription();
  if (state.leftTab === "submissions") {
    body.querySelectorAll("[data-sub]").forEach((row) =>
      row.addEventListener("click", () => {
        state.activeSubmission = Number(row.dataset.sub);
        state.leftTab = "result";
        renderLeft();
      }),
    );
  }
}

function renderDescription() {
  const problem = state.problem;
  const stats = problem.stats;
  return `
    <div class="problem-heading">
      <h1>${escapeHtml(problem.id)}. ${escapeHtml(problem.title)}</h1>
      <div class="problem-meta">
        <span class="difficulty ${problem.difficulty.toLowerCase()}">${escapeHtml(problem.difficulty)}</span>
        ${(problem.tags || []).slice(0, 5).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
      </div>
    </div>
    ${problem.judgeable ? "" : `<p class="judge-note">Auto-judging is unavailable for this problem: ${escapeHtml(problem.judgeNote)} You can still run code against custom inputs.</p>`}
    <div class="problem-content">${problem.content}</div>
    ${(problem.hints || []).length ? `<div class="hints">${problem.hints.map((h, i) => `<details class="problem-hint"><summary>Hint ${i + 1}</summary><div class="hint-body">${h}</div></details>`).join("")}</div>` : ""}
    ${stats && stats.accepted ? `<div class="problem-stats"><span>Accepted <strong>${escapeHtml(stats.accepted)}</strong></span><span>Submissions <strong>${escapeHtml(stats.submissions)}</strong></span><span>Acceptance Rate <strong>${escapeHtml(stats.acRate)}</strong></span></div>` : ""}`;
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function renderSubmissionsList() {
  if (!state.submissions.length) {
    return `<div class="empty-pane">No submissions yet for this problem.<br /><span class="muted">Submit to see runtime, memory and the verdict here.</span></div>`;
  }
  return `<table class="subs-table">
    <thead><tr><th>Status</th><th>Judge</th><th>Runtime</th><th>Memory</th><th>When</th></tr></thead>
    <tbody>${state.submissions
      .map(
        (sub, index) => `<tr data-sub="${index}" tabindex="0">
          <td><span class="verdict-text ${sub.accepted ? "accepted" : "rejected"}">${escapeHtml(sub.verdict)}</span><div class="muted small">${sub.passed}/${sub.total} ${sub.source === "leetcode" ? "testcases" : "examples"}</div></td>
          <td class="muted">${sub.source === "leetcode" ? "LeetCode" : "Examples"}</td>
          <td>${escapeHtml(sub.runtimeDisplay || (sub.durationMs ? `${Math.round(sub.durationMs)} ms` : "–"))}</td>
          <td>${escapeHtml(sub.memoryDisplay || "–")}</td>
          <td class="muted">${escapeHtml(formatTime(sub.at))}</td>
        </tr>`,
      )
      .join("")}</tbody></table>`;
}

function formatBeats(value) {
  return value === null || value === undefined ? "—" : `${Number(value).toFixed(2)}%`;
}

function renderSubmissionPanel(sub) {
  const problem = state.problem;
  const leet = sub.source === "leetcode";
  const unitNote = leet ? `${sub.passed} / ${sub.total} testcases passed` : `${sub.passed} / ${sub.total} example${sub.total === 1 ? "" : "s"} passed`;
  let body = "";
  if (sub.accepted && leet) {
    const pending = sub.runtimePercentile === null || sub.memoryPercentile === null;
    body += `
      <div class="metric-cards">
        <button type="button" class="metric-card ${state.metric === "runtime" ? "active" : ""}" data-metric="runtime" aria-pressed="${state.metric === "runtime"}">
          <div class="metric-label">${ICONS.clock} Runtime</div>
          <div class="metric-value">${escapeHtml(sub.runtimeDisplay || sub.runtime || "–")}</div>
          <div class="metric-beats">Beats <strong>${formatBeats(sub.runtimePercentile)}</strong>${sub.runtimePercentile === null && sub.statsPending ? ' <span class="muted">calculating…</span>' : ""}</div>
        </button>
        <button type="button" class="metric-card ${state.metric === "memory" ? "active" : ""}" data-metric="memory" aria-pressed="${state.metric === "memory"}">
          <div class="metric-label">${ICONS.chip} Memory</div>
          <div class="metric-value">${escapeHtml(sub.memoryDisplay || sub.memory || "–")}</div>
          <div class="metric-beats">Beats <strong>${formatBeats(sub.memoryPercentile)}</strong>${sub.memoryPercentile === null && sub.statsPending ? ' <span class="muted">calculating…</span>' : ""}</div>
        </button>
      </div>
      <div class="chart-mount" id="chart-mount">${pending && !(sub.runtimeDistribution || []).length ? `<div class="chart-placeholder muted">${sub.statsPending ? "Waiting for LeetCode to compute the distribution…" : sub.statsError ? `Distribution unavailable: ${escapeHtml(sub.statsError)}` : "Distribution unavailable for this submission."}</div>` : ""}</div>`;
  } else if (sub.accepted) {
    body += `
      <div class="metric-cards">
        <div class="metric-card static">
          <div class="metric-label">${ICONS.clock} Runtime</div>
          <div class="metric-value">${escapeHtml(sub.runtimeDisplay || `${Math.round(sub.durationMs || 0)} ms`)}</div>
          <div class="metric-beats muted">examples, in your browser</div>
        </div>
        <div class="metric-card static">
          <div class="metric-label">${ICONS.check} Judge</div>
          <div class="metric-value">Examples</div>
          <div class="metric-beats muted">${state.view?.me?.linked ? "this duel was judged on examples" : "link a LeetCode account for hidden tests"}</div>
        </div>
      </div>`;
  } else {
    const d = sub.detail || {};
    if (d.error) body += `<pre class="error-output">${escapeHtml(d.error)}</pre>`;
    if (d.input !== undefined && d.input !== "") body += renderLabeledInput("Input", splitInput(problem, d.input), problem);
    if (d.output !== undefined && d.output !== "") body += `<div class="block-label">Output</div><pre class="value-box">${escapeHtml(d.output)}</pre>`;
    if (d.expected !== undefined && d.expected !== "") body += `<div class="block-label">Expected</div><pre class="value-box">${escapeHtml(d.expected)}</pre>`;
    if (d.stdout) body += `<div class="block-label">Stdout</div><pre class="value-box">${escapeHtml(d.stdout)}</pre>`;
  }
  return `
    <div class="submission-panel">
      <div class="submission-head">
        <div>
          <div class="verdict-big ${sub.accepted ? "accepted" : "rejected"}">${escapeHtml(sub.verdict)}</div>
          <div class="muted">${unitNote}${sub.note ? ` · ${escapeHtml(sub.note)}` : ""}</div>
        </div>
        <div class="muted small submission-when">${leet ? "Judged by LeetCode" : "Judged in browser"}<br />${escapeHtml(formatTime(sub.at))}</div>
      </div>
      ${body}
      <div class="code-head"><span>Code</span><span class="muted">Python3</span><span class="grow"></span><button type="button" class="link-button" id="restore-code">Load into editor</button></div>
      <pre class="code-snapshot">${escapeHtml(sub.code || "")}</pre>
    </div>`;
}

function renderLabeledInput(title, lines, problem) {
  const labels = paramLabels(problem);
  return `<div class="block-label">${escapeHtml(title)}</div><div class="param-list readonly">${lines
    .map((line, i) => `<div class="param-name">${escapeHtml(labels[i] || `arg${i + 1}`)} =</div><pre class="value-box">${escapeHtml(line)}</pre>`)
    .join("")}</div>`;
}

function mountSubmissionPanel(sub) {
  const body = $("left-body");
  body.querySelectorAll("[data-metric]").forEach((card) =>
    card.addEventListener("click", () => {
      state.metric = card.dataset.metric;
      body.querySelectorAll("[data-metric]").forEach((c) => {
        c.classList.toggle("active", c.dataset.metric === state.metric);
        c.setAttribute("aria-pressed", String(c.dataset.metric === state.metric));
      });
      drawChart(sub);
    }),
  );
  $("restore-code")?.addEventListener("click", () => {
    editor.setCode(sub.code || "");
    scheduleCodeSave();
    editor.focus();
  });
  drawChart(sub);
}

function drawChart(sub) {
  const mount = $("chart-mount");
  if (!mount) return;
  const runtime = state.metric === "runtime";
  const distribution = runtime ? sub.runtimeDistribution : sub.memoryDistribution;
  if (!Array.isArray(distribution) || distribution.length < 2) {
    if (!mount.querySelector(".chart-placeholder")) {
      mount.innerHTML = `<div class="chart-placeholder muted">${sub.statsPending ? "Waiting for LeetCode to compute the distribution…" : "No distribution data for this metric."}</div>`;
    }
    return;
  }
  renderDistributionChart(mount, {
    distribution,
    mine: runtime ? sub.runtimeMs : sub.memoryMb,
    unit: runtime ? "ms" : "MB",
    title: runtime ? "Runtime distribution" : "Memory distribution",
    beats: runtime ? sub.runtimePercentile : sub.memoryPercentile,
  });
}

// Single-series histogram: percentage of accepted submissions per bucket,
// with the player's own bucket highlighted. Hand-rolled SVG, theme-aware.
function renderDistributionChart(mount, { distribution, mine, unit, title, beats }) {
  const width = Math.max(320, mount.clientWidth || 480);
  const height = 190;
  const margin = { top: 26, right: 10, bottom: 28, left: 38 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const data = distribution.filter((d) => Number.isFinite(d[0]) && Number.isFinite(d[1]));
  const n = data.length;
  const maxPct = Math.max(...data.map((d) => d[1]), 0.1);
  const niceMax = niceCeil(maxPct);
  const slot = plotW / n;
  const barW = Math.max(1.5, Math.min(24, slot - 2));
  const yFor = (pct) => margin.top + plotH - (pct / niceMax) * plotH;
  const xFor = (i) => margin.left + i * slot + (slot - barW) / 2;
  const fmt = (v) => (unit === "MB" ? `${Number(v).toFixed(1)} MB` : `${Math.round(v)} ms`);

  let mineIndex = -1;
  if (Number.isFinite(mine)) {
    let best = Infinity;
    data.forEach((d, i) => {
      const dist = Math.abs(d[0] - mine);
      if (dist < best) {
        best = dist;
        mineIndex = i;
      }
    });
  }

  const ticks = [0, niceMax / 2, niceMax];
  const grid = ticks
    .map((t) => `<line class="grid" x1="${margin.left}" x2="${width - margin.right}" y1="${yFor(t).toFixed(1)}" y2="${yFor(t).toFixed(1)}"></line>
      <text class="axis" x="${margin.left - 6}" y="${(yFor(t) + 3.5).toFixed(1)}" text-anchor="end">${t % 1 === 0 ? t : t.toFixed(1)}%</text>`)
    .join("");
  const xTickCount = Math.min(6, n);
  const xTicks = [];
  for (let k = 0; k < xTickCount; k += 1) {
    const i = Math.round((k / (xTickCount - 1 || 1)) * (n - 1));
    if (!xTicks.includes(i)) xTicks.push(i);
  }
  const xAxis = xTicks
    .map((i) => `<text class="axis" x="${(xFor(i) + barW / 2).toFixed(1)}" y="${height - 8}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${fmt(data[i][0])}</text>`)
    .join("");
  const bars = data
    .map((d, i) => {
      const x = xFor(i);
      const y = yFor(d[1]);
      const h = Math.max(0, margin.top + plotH - y);
      const r = Math.min(4, barW / 2, h);
      const path = h <= 0.5
        ? `M${x.toFixed(1)},${(margin.top + plotH).toFixed(1)}h${barW.toFixed(1)}v-0.5h-${barW.toFixed(1)}z`
        : `M${x.toFixed(1)},${(margin.top + plotH).toFixed(1)}v-${(h - r).toFixed(1)}a${r},${r} 0 0 1 ${r},-${r}h${(barW - 2 * r).toFixed(1)}a${r},${r} 0 0 1 ${r},${r}v${(h - r).toFixed(1)}z`;
      return `<path class="dist-bar ${i === mineIndex ? "mine" : ""}" d="${path}"></path>
        <rect class="hit" data-i="${i}" x="${(margin.left + i * slot).toFixed(1)}" y="${margin.top}" width="${slot.toFixed(2)}" height="${plotH}" fill="transparent"></rect>`;
    })
    .join("");
  let youLabel = "";
  if (mineIndex >= 0) {
    const cx = xFor(mineIndex) + barW / 2;
    const anchor = cx > width - 90 ? "end" : cx < margin.left + 70 ? "start" : "middle";
    youLabel = `<line class="you-line" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${margin.top - 4}" y2="${(margin.top + plotH).toFixed(1)}"></line>
      <text class="you-label" x="${cx.toFixed(1)}" y="${margin.top - 9}" text-anchor="${anchor}">You · ${fmt(mine)}${beats !== null && beats !== undefined ? ` · beats ${Number(beats).toFixed(2)}%` : ""}</text>`;
  }
  mount.innerHTML = `
    <div class="chart-title">${escapeHtml(title)} <span class="muted">· share of accepted Python3 submissions</span></div>
    <div class="chart-wrap">
      <svg class="dist-chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(title)}">${grid}${bars}${youLabel}${xAxis}</svg>
      <div class="chart-tip" hidden></div>
    </div>
    <details class="chart-table"><summary>View as table</summary><table><thead><tr><th>${unit === "MB" ? "Memory" : "Runtime"}</th><th>Submissions</th></tr></thead><tbody>${data
      .map((d, i) => `<tr class="${i === mineIndex ? "mine" : ""}"><td>${fmt(d[0])}${i === mineIndex ? " (you)" : ""}</td><td>${d[1].toFixed(2)}%</td></tr>`)
      .join("")}</tbody></table></details>`;

  const tip = mount.querySelector(".chart-tip");
  const svg = mount.querySelector("svg");
  const show = (i, clientX) => {
    const d = data[i];
    if (!d) return;
    tip.textContent = `${d[1].toFixed(2)}% of submissions · ${fmt(d[0])}${i === mineIndex ? " · you" : ""}`;
    tip.hidden = false;
    const rect = svg.getBoundingClientRect();
    const left = clamp(clientX - rect.left, 60, rect.width - 60);
    tip.style.left = `${left}px`;
    svg.querySelectorAll(".dist-bar").forEach((bar, j) => bar.classList.toggle("hover", j === i));
  };
  svg.addEventListener("pointermove", (event) => {
    const hit = event.target.closest(".hit");
    if (!hit) return;
    show(Number(hit.dataset.i), event.clientX);
  });
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    svg.querySelectorAll(".dist-bar.hover").forEach((bar) => bar.classList.remove("hover"));
  });
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * power;
}

// ------------------------------------------------------------- bottom panel

function renderResults() {
  const body = $("result-body");
  if (!body || !state.problem) return;
  const { tab } = state.results;
  document.querySelectorAll("#result-tabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "testcase") renderTestcaseTab(body);
  else if (tab === "debug") renderDebugTab(body);
  else renderRunTab(body);
}

function chipRow(cases, selected, { onSelect, statuses = null, addable = false }) {
  const html = `<div class="case-chips">${cases
    .map((c, i) => {
      const status = statuses ? statuses[i] : null;
      const dot = status ? `<span class="dot ${status}"></span>` : "";
      const removable = addable && c.example === null && cases.length > 1;
      return `<button type="button" class="chip ${i === selected ? "active" : ""}" data-case="${i}">${dot}Case ${i + 1}${removable ? `<span class="chip-x" data-remove="${i}" title="Remove this case">×</span>` : ""}</button>`;
    })
    .join("")}${addable ? `<button type="button" class="chip add" data-add title="Add a testcase">+</button>` : ""}</div>`;
  return { html, onSelect };
}

function renderTestcaseTab(body) {
  const problem = state.problem;
  const cases = state.cases;
  const active = clamp(state.activeCase, 0, cases.length - 1);
  state.activeCase = active;
  const labels = paramLabels(problem);
  const chips = chipRow(cases, active, { addable: true });
  body.innerHTML = `
    <div class="result-scroll">
      ${chips.html}
      <div class="param-list">${labels
        .map(
          (label, i) => `<label class="param-name" for="param-${i}">${escapeHtml(label)} =</label>
          <textarea id="param-${i}" class="param-input" data-param="${i}" rows="${rowsFor(cases[active].lines[i])}" spellcheck="false">${escapeHtml(cases[active].lines[i] ?? "")}</textarea>`,
        )
        .join("")}</div>
    </div>`;
  body.querySelectorAll("[data-case]").forEach((chip) =>
    chip.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove]");
      if (remove) {
        const index = Number(remove.dataset.remove);
        state.cases.splice(index, 1);
        state.activeCase = clamp(active >= index ? active - 1 : active, 0, state.cases.length - 1);
        saveCustomCases();
        renderTestcaseTab(body);
        return;
      }
      state.activeCase = Number(chip.dataset.case);
      renderTestcaseTab(body);
    }),
  );
  body.querySelector("[data-add]")?.addEventListener("click", () => {
    state.cases.push({ lines: [...cases[active].lines], example: null });
    state.activeCase = state.cases.length - 1;
    saveCustomCases();
    renderTestcaseTab(body);
    body.querySelector(".param-input")?.focus();
  });
  body.querySelectorAll(".param-input").forEach((input) =>
    input.addEventListener("input", () => {
      const i = Number(input.dataset.param);
      state.cases[state.activeCase].lines[i] = input.value;
      input.rows = rowsFor(input.value);
      if (state.cases[state.activeCase].example === null) saveCustomCases();
    }),
  );
}

function rowsFor(text) {
  return clamp(String(text || "").split("\n").length, 1, 6);
}

function runVerdict(run) {
  if (!run) return null;
  const errorCase = run.results.find((r) => r.error);
  if (errorCase) return classifyError(errorCase.error);
  const judged = run.statuses.filter((s) => s !== "neutral");
  if (judged.length && judged.some((s) => s === "bad")) return "Wrong Answer";
  return "Accepted";
}

function renderRunTab(body) {
  const { run, running } = state.results;
  if (running && !run) {
    body.innerHTML = `<div class="result-scroll"><span class="muted">${state.pythonStatus === "loading" ? "Loading Python…" : "Running…"}</span></div>`;
    return;
  }
  if (!run) {
    body.innerHTML = `<div class="result-scroll"><span class="muted">You must run your code first. (Ctrl/⌘+Enter)</span></div>`;
    return;
  }
  const problem = state.problem;
  const verdict = runVerdict(run);
  const totalMs = run.results.reduce((sum, r) => sum + (r.durationMs || 0), 0);
  const selected = clamp(state.results.selectedCase, 0, run.cases.length - 1);
  const chips = chipRow(run.cases, selected, { statuses: run.statuses });
  const r = run.results[selected] || {};
  const testCase = run.cases[selected];
  const expected = testCase.example !== null ? problem.examples[testCase.example]?.expectedText : null;
  let detail = "";
  if (r.error) detail += `<pre class="error-output">${escapeHtml(r.error)}</pre>`;
  detail += renderLabeledInput("Input", testCase.lines, problem);
  if (!r.error) detail += `<div class="block-label">Output</div><pre class="value-box">${escapeHtml(formatValue(r.actual))}</pre>`;
  if (expected !== null && expected !== undefined) detail += `<div class="block-label">Expected</div><pre class="value-box">${escapeHtml(expected)}</pre>`;
  else if (!r.error) detail += `<div class="block-label muted">Expected output is only known for the problem's examples.</div>`;
  if (r.stdout) detail += `<div class="block-label">Stdout</div><pre class="value-box">${escapeHtml(r.stdout)}</pre>`;
  body.innerHTML = `
    <div class="result-scroll">
      <div class="run-head"><span class="verdict-text ${verdict === "Accepted" ? "accepted" : "rejected"}">${escapeHtml(verdict)}</span><span class="muted">Runtime: ${totalMs.toFixed(totalMs < 10 ? 1 : 0)} ms</span></div>
      ${chips.html}
      ${detail}
    </div>`;
  body.querySelectorAll("[data-case]").forEach((chip) =>
    chip.addEventListener("click", () => {
      state.results.selectedCase = Number(chip.dataset.case);
      renderRunTab(body);
    }),
  );
}

function renderDebugTab(body) {
  const { debug, running } = state.results;
  if (running && state.results.tab === "debug") {
    body.innerHTML = `<div class="result-scroll"><span class="muted">Tracing…</span></div>`;
    return;
  }
  if (!debug) {
    body.innerHTML = `<div class="result-scroll"><span class="muted">Click Debug to trace the selected testcase line by line.</span></div>`;
    return;
  }
  const trace = debug.result;
  if (trace.error) {
    body.innerHTML = `<div class="result-scroll"><pre class="error-output">${escapeHtml(trace.error)}</pre></div>`;
    return;
  }
  if (!trace.trace.length) {
    body.innerHTML = `<div class="result-scroll"><span class="muted">No lines were traced.</span></div>`;
    return;
  }
  body.innerHTML = `<div class="result-output debug-output">${trace.trace
    .map(
      (row) => `<div class="trace-row"><span>Line ${row.line}</span><code>${escapeHtml(
        Object.entries(row.locals)
          .map(([k, v]) => `${k}=${v}`)
          .join("  ") || "—",
      )}</code></div>`,
    )
    .join("")}<div class="trace-row"><span>Result</span><code>${escapeHtml(formatValue(trace.actual))}</code></div></div>`;
}

function isNodeReturn(problem) {
  const type = String(problem?.metaData?.return?.type || "").toLowerCase();
  return !problem?.metaData?.classname && (type === "treenode" || type === "listnode");
}

async function runCode(mode) {
  const problem = state.problem;
  if (!problem || state.results.running) return;
  const code = editor.getCode();
  state.results.running = true;
  if (mode === "debug") {
    state.results.tab = "debug";
    state.results.debug = null;
  } else {
    state.results.tab = "result";
  }
  renderResults();
  updateBar();
  try {
    if (mode === "debug") {
      const testCase = state.cases[clamp(state.activeCase, 0, state.cases.length - 1)];
      const results = await py.run({ code, metadata: problem.metaData, inputs: [caseInput(testCase)], mode: "debug", timeout: RUN_TIMEOUT });
      state.results.debug = { result: results[0], caseIndex: state.activeCase };
    } else {
      const cases = state.cases.map((c) => ({ lines: [...c.lines], example: c.example }));
      const results = await py.run({ code, metadata: problem.metaData, inputs: cases.map(caseInput), mode: "run", timeout: RUN_TIMEOUT + 4000 * cases.length });
      const statuses = cases.map((c, i) => {
        const r = results[i] || {};
        if (r.error) return "bad";
        if (c.example === null) return "neutral";
        const expected = parseLiteral(problem.examples[c.example]?.expectedText ?? "");
        return expected.ok && outputsMatch(expected.value, r.actual, { anyOrder: problem.anyOrder, nodeReturn: isNodeReturn(problem) }) ? "good" : "bad";
      });
      const firstBad = statuses.findIndex((s) => s === "bad");
      state.results.run = { results, cases, statuses, at: Date.now() };
      state.results.selectedCase = firstBad >= 0 ? firstBad : clamp(state.activeCase, 0, cases.length - 1);
    }
  } catch (error) {
    const failure = { stdout: "", trace: [], actual: null, error: error.message, durationMs: 0 };
    if (mode === "debug") state.results.debug = { result: failure, caseIndex: state.activeCase };
    else state.results.run = { results: [failure], cases: [state.cases[0]], statuses: ["bad"], at: Date.now() };
  } finally {
    state.results.running = false;
    renderResults();
    updateBar();
  }
}

async function submitCode() {
  const problem = state.problem;
  if (!problem || state.results.running) return;
  const duel = state.mode === "duel" ? myDuel() : null;
  const useLeetCode = duel ? duel.judging === "leetcode" : state.settings.judging === "leetcode" && state.view?.me?.linked;
  if (!useLeetCode && !problem.judgeable) {
    toast(`This problem cannot be auto-judged: ${problem.judgeNote}`);
    return;
  }
  const code = editor.getCode();
  state.results.running = true;
  state.submitting = true;
  updateBar();
  let record;
  try {
    let results = [];
    const payload = { sessionId: state.session, name: displayName(), slug: problem.titleSlug, duelId: duel?.id, code };
    if (useLeetCode) payload.mode = "leetcode";
    else {
      results = await py.run({ code, metadata: problem.metaData, inputs: problem.examples.map((e) => e.input), mode: "run", timeout: JUDGE_TIMEOUT });
      payload.results = results.map((r) => ({ actual: r.actual, error: r.error, durationMs: r.durationMs }));
    }
    const response = await api("/api/submit", { method: "POST", body: JSON.stringify(payload) });
    const v = response.verdict;
    record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      source: v.source,
      accepted: !!v.accepted,
      verdict: v.verdict,
      passed: v.passed,
      total: v.total,
      code,
      durationMs: results.reduce((sum, r) => sum + (r.durationMs || 0), 0),
      runtimeDisplay: v.runtime || "",
      memoryDisplay: v.memory || "",
      runtimePercentile: v.runtimePercentile ?? null,
      memoryPercentile: v.memoryPercentile ?? null,
      runtimeMs: null,
      memoryMb: null,
      runtimeDistribution: [],
      memoryDistribution: [],
      submissionId: v.submissionId || null,
      statsPending: !!(v.accepted && v.source === "leetcode"),
      detail: {},
      note: duel && response.duel && response.duel.status === "complete" && response.duel.winnerId !== me() ? "the duel was already over" : "",
    };
    if (v.source === "leetcode") record.detail = v.detail || {};
    else if (!v.accepted) {
      const failing = v.details.find((d) => !d.passed);
      if (failing) {
        const example = problem.examples[failing.index];
        record.detail = {
          input: example ? example.input : "",
          output: failing.error ? "" : formatValue(failing.actual),
          expected: example ? example.expectedText : "",
          error: failing.error || "",
          stdout: results[failing.index]?.stdout || "",
        };
      }
    }
  } catch (error) {
    record = {
      id: `${Date.now()}`,
      at: Date.now(),
      source: useLeetCode ? "leetcode" : "examples",
      accepted: false,
      verdict: "Submission failed",
      passed: 0,
      total: 0,
      code,
      durationMs: 0,
      detail: { error: error.message },
      note: "",
    };
    toast(error.message);
  } finally {
    state.results.running = false;
    state.submitting = false;
  }
  state.submissions.unshift(record);
  state.submissions = state.submissions.slice(0, 15);
  saveSubmissions();
  state.activeSubmission = 0;
  state.leftTab = "result";
  state.metric = "runtime";
  renderLeft();
  updateBar();
  if (record.statsPending) pollSubmissionStats(record);
}

async function pollSubmissionStats(record) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1200 : 2000));
    if (!state.submissions.includes(record)) return;
    try {
      const { submission } = await api(`/api/leetcode/submission?sessionId=${encodeURIComponent(state.session)}&id=${encodeURIComponent(record.submissionId)}`);
      Object.assign(record, {
        runtimeMs: submission.runtimeMs,
        runtimeDisplay: submission.runtimeDisplay || record.runtimeDisplay,
        runtimePercentile: submission.runtimePercentile,
        runtimeDistribution: submission.runtimeDistribution || [],
        memoryMb: submission.memoryMb,
        memoryDisplay: submission.memoryDisplay || record.memoryDisplay,
        memoryPercentile: submission.memoryPercentile,
        memoryDistribution: submission.memoryDistribution || [],
      });
      const done = record.runtimePercentile !== null && record.memoryPercentile !== null;
      record.statsPending = !done;
      saveSubmissions();
      if (state.leftTab === "result" && state.submissions[state.activeSubmission] === record) renderLeft();
      if (done) return;
    } catch (error) {
      record.statsPending = false;
      record.statsError = error.message;
      if (state.leftTab === "result" && state.submissions[state.activeSubmission] === record) renderLeft();
      return;
    }
  }
  record.statsPending = false;
  if (state.leftTab === "result" && state.submissions[state.activeSubmission] === record) renderLeft();
}

async function vetoProblem() {
  const duel = myDuel();
  if (!duel || duel.status !== "active") return;
  try {
    await duelAction("veto", { duelId: duel.id });
  } catch (error) {
    toast(error.message);
  }
}

// ---------------------------------------------------------------------------
// top bar, timer, game over

function playerStatus(player) {
  if (!player) return "";
  if (player.lastVerdict === "Accepted") return "solved";
  if (!player.attempts) return "no attempts yet";
  const attempts = `${player.attempts} attempt${player.attempts === 1 ? "" : "s"}`;
  return player.total ? `${attempts} · best ${player.bestPassed}/${player.total}` : attempts;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function duelElapsed(duel) {
  if (!duel || !duel.startedAt) return 0;
  const end = duel.status === "complete" ? duel.endedAt || Date.now() : Date.now();
  return end - duel.startedAt;
}

function updateBar() {
  const center = $("bar-center");
  const actions = $("bar-actions");
  const duel = state.mode === "spectate" ? state.view?.watch : myDuel();
  const problem = state.problem;
  const inWorkspace = !!problem && (state.mode === "practice" || state.mode === "duel" || state.mode === "spectate");

  if (!inWorkspace) {
    center.innerHTML = "";
    actions.innerHTML = "";
    return;
  }
  let centerHtml = `<span class="bar-problem">${escapeHtml(problem.id)}. ${escapeHtml(problem.title)}</span>`;
  if (duel && (state.mode === "duel" || state.mode === "spectate") && duel.players) {
    if (state.mode === "duel") {
      const opponent = duel.players.find((p) => p.id !== me());
      if (opponent) {
        centerHtml += `<span class="status-line"><span class="dot ${opponent.online ? "online" : ""}" title="${opponent.online ? "online" : "offline"}"></span><strong>${escapeHtml(opponent.name)}</strong><span>${escapeHtml(playerStatus(opponent))}</span></span>`;
      }
    }
    centerHtml += `<span class="timer" id="duel-timer">${formatDuration(duelElapsed(duel))}</span>`;
  }
  center.innerHTML = centerHtml;

  if (state.mode === "spectate") {
    actions.innerHTML = `<button type="button" class="bar-button" id="stop-watching">Stop spectating</button>`;
    $("stop-watching").addEventListener("click", () => goHome());
    return;
  }
  const running = state.results.running;
  const pyLabel = state.pythonStatus === "loading" ? "Loading Python…" : state.pythonStatus === "error" ? "Python unavailable" : "";
  const canVeto = duel && duel.status === "active" && state.mode === "duel";
  const meVetoed = canVeto && duel.players.find((p) => p.id === me())?.vetoed;
  const vetoCount = canVeto ? duel.players.filter((p) => p.vetoed).length : 0;
  const useLeetCode = duel ? duel.judging === "leetcode" : state.settings.judging === "leetcode" && state.view?.me?.linked;
  const finished = state.mode === "duel" && duel && duel.status === "complete" && state.bannerDismissed === duel.id;
  const winnerText = finished ? (duel.winnerId === me() ? "You won" : duel.endReason === "expired" ? "Duel expired" : `${duel.winnerName || "Opponent"} won`) : "";
  actions.innerHTML = `
    ${finished ? `<button type="button" class="bar-button result-pill" id="show-result" title="Show the duel result">${escapeHtml(winnerText)} · Rematch?</button>` : ""}
    ${canVeto ? `<button type="button" class="bar-button" id="veto-button" ${meVetoed || running ? "disabled" : ""} title="If both players veto, a new problem is picked">Veto ${vetoCount}/2</button>` : ""}
    ${pyLabel ? `<span class="online-pill" style="font-size:12px">${pyLabel}</span>` : ""}
    <span class="button-group">
      <button type="button" class="bar-button" id="run-button" ${running ? "disabled" : ""} title="Run all testcases (Ctrl/⌘+Enter)">${ICONS.play} Run</button>
      <button type="button" class="bar-button" id="debug-button" ${running ? "disabled" : ""} title="Trace the selected testcase line by line">${ICONS.bug} Debug</button>
      <button type="button" class="bar-button primary" id="submit-button" ${running ? "disabled" : ""} title="${useLeetCode ? "Submit to LeetCode with your linked account" : "Judge on the example tests (Ctrl/⌘+Shift+Enter)"}">${ICONS.upload} ${state.submitting ? "Judging…" : useLeetCode ? "Submit to LeetCode" : "Submit"}</button>
    </span>`;
  $("show-result")?.addEventListener("click", () => {
    state.bannerDismissed = null;
    updateBar();
    updateGameOver();
  });
  $("veto-button")?.addEventListener("click", vetoProblem);
  $("run-button").addEventListener("click", () => runCode("run"));
  $("debug-button").addEventListener("click", () => runCode("debug"));
  $("submit-button").addEventListener("click", submitCode);
}

setInterval(() => {
  const timer = $("duel-timer");
  if (!timer) return;
  const duel = state.mode === "spectate" ? state.view?.watch : myDuel();
  if (duel) timer.textContent = formatDuration(duelElapsed(duel));
}, 500);

function updateGameOver() {
  const existing = document.querySelector(".game-over");
  const duel = myDuel();
  const show = state.mode === "duel" && duel && duel.status === "complete" && state.duelId === duel.id && state.bannerDismissed !== duel.id;
  if (!show) {
    existing?.remove();
    return;
  }
  const mine = duel.winnerId === me();
  const opponent = duel.players.find((p) => p.id !== me());
  let headline;
  let sub = "";
  if (duel.endReason === "forfeit") {
    headline = mine ? `${escapeHtml(opponent?.name || "Your opponent")} forfeited — you win` : "You forfeited";
  } else if (duel.endReason === "expired") {
    headline = "Duel expired — no winner";
  } else {
    headline = mine ? "You won!" : `${escapeHtml(duel.winnerName || "Opponent")} won`;
    sub = `Solved in ${formatDuration(duelElapsed(duel))}`;
  }
  const iWant = duel.players.find((p) => p.id === me())?.wantsRematch;
  const theyWant = opponent?.wantsRematch;
  const opponentGone = !opponent || !opponent.online || opponent.left;
  let rematchLabel = "Rematch";
  if (iWant) rematchLabel = `Waiting for ${opponent?.name || "opponent"}…`;
  else if (theyWant) rematchLabel = `${opponent?.name || "Opponent"} wants a rematch — accept`;
  const html = `
    <span class="headline">${headline}</span>
    <button type="button" class="small-button ${theyWant && !iWant ? "accent" : ""}" id="rematch-button" ${iWant || opponentGone ? "disabled" : ""} title="${opponentGone ? "Your opponent left" : ""}">${escapeHtml(rematchLabel)}</button>
    <button type="button" class="small-button" id="menu-button">Main menu</button>
    <button type="button" class="banner-close" id="banner-close" title="Keep working on the problem">×</button>
    ${sub || opponentGone ? `<span class="sub">${escapeHtml(sub)}${opponentGone ? (sub ? " · " : "") + "Opponent left" : ""}</span>` : ""}`;
  let banner = existing;
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "game-over";
    banner.setAttribute("role", "status");
    $("app").appendChild(banner);
  }
  banner.innerHTML = html;
  $("rematch-button").addEventListener("click", async () => {
    try {
      await duelAction("rematch", { duelId: duel.id });
    } catch (error) {
      toast(error.message);
    }
  });
  $("menu-button").addEventListener("click", () => leaveDuel());
  $("banner-close").addEventListener("click", () => {
    state.bannerDismissed = duel.id;
    updateGameOver();
    updateBar();
    if (state.problem) editor.focus();
  });
}

// ---------------------------------------------------------------------------
// spectate

function renderSpectate() {
  const duel = state.view?.watch;
  if (!duel) return;
  if (duel.problem && (!state.problem || state.problem.titleSlug !== duel.problem.slug)) {
    api(`/api/problem?slug=${encodeURIComponent(duel.problem.slug)}`)
      .then(({ problem }) => {
        if (state.mode !== "spectate") return;
        state.problem = problem;
        renderSpectateShell(problem);
        renderSpectateCards();
      })
      .catch((error) => toast(error.message));
    return;
  }
  if (!document.querySelector(".workspace.spectating") && state.problem) renderSpectateShell(state.problem);
  renderSpectateCards();
  updateBar();
}

function renderSpectateShell(problem) {
  editor.destroy();
  $("screen").innerHTML = `
    <div class="workspace spectating">
      <section class="problem-pane">
        <div class="pane-title"><span>Description</span><span class="grow"></span><a class="link-button" href="${escapeHtml(problem.sourceUrl)}" target="_blank" rel="noopener">Open on LeetCode ↗</a></div>
        <div class="problem-scroll">
          <div class="problem-heading">
            <h1>${escapeHtml(problem.id)}. ${escapeHtml(problem.title)}</h1>
            <div class="problem-meta"><span class="difficulty ${problem.difficulty.toLowerCase()}">${escapeHtml(problem.difficulty)}</span></div>
          </div>
          <div class="problem-content">${problem.content}</div>
        </div>
      </section>
      <section class="spectate-panel">
        <div class="pane-title"><span>Spectating</span></div>
        <div class="player-cards" id="player-cards"></div>
      </section>
    </div>`;
  updateBar();
}

function renderSpectateCards() {
  const duel = state.view?.watch;
  const cards = $("player-cards");
  if (!duel || !cards) return;
  cards.innerHTML =
    duel.players
      .map(
        (p) => `
      <div class="player-card ${duel.winnerId === p.id ? "winner" : ""}">
        <h3><span class="dot ${p.online ? "online" : ""}"></span>${escapeHtml(p.name)}${duel.winnerId === p.id ? " · winner" : ""}</h3>
        <div class="meta">${escapeHtml(playerStatus(p))}${p.vetoed ? " · wants a new problem" : ""}</div>
      </div>`,
      )
      .join("") +
    (duel.status === "complete"
      ? `<div class="player-card"><h3>${duel.endReason === "expired" ? "Duel expired" : `${escapeHtml(duel.winnerName || "")} won`}</h3><div class="meta">${duel.endReason === "solved" ? `Solved in ${formatDuration(duelElapsed(duel))}` : duel.endReason === "forfeit" ? "By forfeit" : ""}</div></div>`
      : `<div class="player-card"><div class="meta">${duel.judging === "leetcode" ? "Judged on LeetCode submissions" : "First to pass all examples wins"} · ${escapeHtml(duel.difficulty)}</div></div>`);
}

// ---------------------------------------------------------------------------
// LeetCode account linking

function updateLcButton() {
  const button = $("lc-button");
  const linked = !!state.view?.me?.linked;
  button.classList.toggle("linked", linked);
  button.textContent = linked ? `✓ ${state.view.me.leetcodeUser || "LeetCode linked"}` : "Link LeetCode";
  if (document.querySelector(".setup")) syncSetupForm();
}

function openModal(html) {
  closeModal();
  const root = $("modal-root");
  root.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal" role="dialog">${html}</div></div>`;
  root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  $("modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") closeModal();
  });
}

function closeModal() {
  $("modal-root").innerHTML = "";
}

function openLinkModal() {
  const linked = !!state.view?.me?.linked;
  if (linked) {
    openModal(`
      <h2>LeetCode account</h2>
      <p>Linked as <strong>${escapeHtml(state.view.me.leetcodeUser || "your account")}</strong>. Submissions made with "LeetCode account" judging are sent to LeetCode under this account and count toward your real submission history.</p>
      <div class="actions">
        <button type="button" class="small-button" data-close>Close</button>
        <button type="button" class="small-button danger" id="unlink-button">Unlink</button>
      </div>`);
    $("unlink-button").addEventListener("click", async () => {
      try {
        await api("/api/leetcode/unlink", { method: "POST", body: JSON.stringify({ sessionId: state.session }) });
        closeModal();
        pollOnce();
      } catch (error) {
        toast(error.message);
      }
    });
    return;
  }
  openModal(`
    <h2>Link your LeetCode account</h2>
    <p>Optional. With an account linked, a duel can be judged on real LeetCode submissions (hidden tests, time limits) instead of the example tests.</p>
    <p class="warn">Your session cookie is stored on this server and lets it submit code as you. Only do this on a site you trust, and unlink when you're done. Logging out of LeetCode invalidates it.</p>
    <ol>
      <li>Log in at <a href="https://leetcode.com" target="_blank" rel="noopener">leetcode.com</a>.</li>
      <li>Open DevTools (F12) → <strong>Application</strong> (Chrome) or <strong>Storage</strong> (Firefox) → Cookies → leetcode.com.</li>
      <li>Copy the values of <code>LEETCODE_SESSION</code> and <code>csrftoken</code>.</li>
    </ol>
    <div class="field"><label class="control-label" for="lc-session">LEETCODE_SESSION</label><input id="lc-session" class="text-input" autocomplete="off" spellcheck="false" /></div>
    <div class="field"><label class="control-label" for="lc-csrf">csrftoken</label><input id="lc-csrf" class="text-input" autocomplete="off" spellcheck="false" /></div>
    <p class="form-error" id="lc-error" hidden></p>
    <div class="actions">
      <button type="button" class="small-button" data-close>Cancel</button>
      <button type="button" class="small-button accent" id="link-button">Link</button>
    </div>`);
  $("link-button").addEventListener("click", async () => {
    const button = $("link-button");
    button.disabled = true;
    button.textContent = "Checking…";
    $("lc-error").hidden = true;
    try {
      const { username } = await api("/api/leetcode/link", {
        method: "POST",
        body: JSON.stringify({ sessionId: state.session, name: displayName(), session: $("lc-session").value, csrf: $("lc-csrf").value }),
      });
      closeModal();
      if (username) setName(username);
      toast(`Linked as ${username}`, "info");
      pollOnce();
    } catch (error) {
      $("lc-error").textContent = error.message;
      $("lc-error").hidden = false;
      button.disabled = false;
      button.textContent = "Link";
    }
  });
  $("lc-session").focus();
}

// ---------------------------------------------------------------------------
// boot

$("home-button").addEventListener("click", homeButton);
$("theme-button").addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
$("lc-button").addEventListener("click", openLinkModal);
$("theme-button").textContent = currentTheme() === "dark" ? "Light" : "Dark";
window.addEventListener("beforeunload", (event) => {
  const duel = myDuel();
  if (state.mode === "duel" && duel && duel.status === "active") {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

window.__duel = { state, editor }; // handy for debugging and tests
renderHome();
connect();
setTimeout(() => {
  if (!state.view) startPolling();
}, 2500);
