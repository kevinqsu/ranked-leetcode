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
  results: { tab: "testcase", last: null, running: false, selectedCase: 0 },
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
    const worker = new Worker("python-worker.js?v=1", { type: "module" });
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
  state.results = { tab: "testcase", last: null, running: false, selectedCase: 0 };
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

function loadProblem(problem) {
  state.problem = problem;
  state.testInput = problem.sampleTestCase || problem.examples[0]?.input || "";
  state.results = { tab: "testcase", last: null, running: false, selectedCase: 0 };
  renderWorkspace();
  py.ensure().catch(() => {});
}

function renderWorkspace() {
  const problem = state.problem;
  const screen = $("screen");
  editor.destroy();
  screen.innerHTML = `
    <div class="workspace" id="workspace">
      <section class="problem-pane">
        <div class="pane-title"><span>Description</span><span class="grow"></span>
          ${state.mode === "practice" ? `<button type="button" class="link-button" id="new-problem">New problem</button>` : ""}
          <a class="link-button" href="${escapeHtml(problem.sourceUrl)}" target="_blank" rel="noopener">Open on LeetCode ↗</a>
        </div>
        <div class="problem-scroll">
          <div class="problem-heading">
            <h1>${escapeHtml(problem.id)}. ${escapeHtml(problem.title)}</h1>
            <div class="problem-meta">
              <span class="difficulty ${problem.difficulty.toLowerCase()}">${escapeHtml(problem.difficulty)}</span>
              ${(problem.tags || []).slice(0, 5).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
            </div>
          </div>
          ${problem.judgeable ? "" : `<p class="judge-note">Auto-judging is unavailable for this problem: ${escapeHtml(problem.judgeNote)} You can still run code against custom inputs.</p>`}
          <div class="problem-content">${problem.content}</div>
        </div>
      </section>
      <section class="code-pane">
        <div class="editor-panel">
          <div class="pane-title editor-title"><span>Code</span><span class="grow"></span>
            <button type="button" class="link-button" id="reset-code" title="Restore the starter code">Reset</button>
            <span class="muted">Python3</span>
          </div>
          <div class="editor-wrap" id="editor-wrap"></div>
        </div>
        <div class="result-panel">
          <div class="pane-title result-tabs" id="result-tabs">
            <button type="button" data-tab="testcase">Testcase</button>
            <button type="button" data-tab="result">Test Result</button>
            <button type="button" data-tab="debug">Debug</button>
          </div>
          <div id="result-body" class="result-body-wrap" style="display:flex;flex:1;min-height:0;flex-direction:column"></div>
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
  $("result-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    state.results.tab = button.dataset.tab;
    renderResults();
  });
  renderResults();
  updateBar();
  updateGameOver();
  if (window.innerWidth > 860) editor.focus();
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

function renderResults() {
  const body = $("result-body");
  if (!body) return;
  const { tab, last, running, selectedCase } = state.results;
  document.querySelectorAll("#result-tabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));

  if (tab === "testcase") {
    body.innerHTML = `<textarea class="test-input" id="test-input" spellcheck="false" aria-label="Test case input"></textarea>`;
    const input = $("test-input");
    input.value = state.testInput;
    input.addEventListener("input", () => (state.testInput = input.value));
    return;
  }

  if (tab === "debug") {
    const trace = last?.kind === "debug" ? last.results[0] : null;
    if (running && last?.kind === "debug") body.innerHTML = `<div class="result-output"><span class="muted">Running Python…</span></div>`;
    else if (!trace) body.innerHTML = `<div class="result-output"><span class="muted">Click Debug to trace your code line by line on the testcase input.</span></div>`;
    else if (trace.error) body.innerHTML = `<div class="result-output"><pre class="error-output">${escapeHtml(trace.error)}</pre></div>`;
    else if (!trace.trace.length) body.innerHTML = `<div class="result-output"><span class="muted">No lines were traced.</span></div>`;
    else
      body.innerHTML = `<div class="result-output debug-output">${trace.trace
        .map(
          (row) => `<div class="trace-row"><span>Line ${row.line}</span><code>${escapeHtml(
            Object.entries(row.locals)
              .map(([k, v]) => `${k}=${v}`)
              .join("  ") || "—",
          )}</code></div>`,
        )
        .join("")}<div class="trace-row"><span>Result</span><code>${escapeHtml(formatValue(trace.actual))}</code></div></div>`;
    return;
  }

  // result tab
  if (running) {
    body.innerHTML = `<div class="result-output"><span class="muted">${last?.kind === "submit" ? "Judging…" : "Running…"}</span></div>`;
    return;
  }
  if (!last || last.kind === "debug") {
    body.innerHTML = `<div class="result-output"><span class="muted">Run your code first (Ctrl/⌘+Enter).</span></div>`;
    return;
  }
  if (last.kind === "run") {
    const r = last.results[0];
    const problem = state.problem;
    const example = problem.examples.find((e) => e.input.trim() === last.input.trim());
    let html = "";
    if (r.error) html += `<pre class="error-output">${escapeHtml(r.error)}</pre>`;
    else {
      let verdict = "";
      if (example) {
        const expected = parseLiteral(example.expectedText);
        const ok = expected.ok && outputsMatch(expected.value, r.actual, { anyOrder: problem.anyOrder, nodeReturn: isNodeReturn(problem) });
        verdict = `<div class="verdict ${ok ? "accepted" : "rejected"}">${ok ? "Matches expected output" : "Does not match expected output"}</div>`;
      }
      html += verdict;
      html += `<div class="label">Output</div><pre>${escapeHtml(formatValue(r.actual))}</pre>`;
      if (example) html += `<div class="label">Expected</div><pre>${escapeHtml(example.expectedText)}</pre>`;
    }
    if (r.stdout) html += `<div class="label">Stdout</div><pre>${escapeHtml(r.stdout)}</pre>`;
    if (r.durationMs > 0) html += `<div class="label">${r.durationMs} ms</div>`;
    body.innerHTML = `<div class="result-output">${html}</div>`;
    return;
  }
  if (last.kind === "submit") {
    const v = last.verdict;
    let html = `<div class="verdict ${v.accepted ? "accepted" : "rejected"}">${escapeHtml(v.verdict)}</div>`;
    if (v.source === "leetcode") {
      html += `<div class="verdict-sub">Judged by LeetCode · ${v.passed}/${v.total} testcases${v.runtime ? ` · ${escapeHtml(v.runtime)}` : ""}${v.memory ? ` · ${escapeHtml(v.memory)}` : ""}</div>`;
      const d = v.detail || {};
      if (d.error) html += `<pre class="error-output">${escapeHtml(d.error)}</pre>`;
      if (d.input) html += `<div class="label">Input</div><pre>${escapeHtml(d.input)}</pre>`;
      if (d.output !== undefined && d.output !== "") html += `<div class="label">Output</div><pre>${escapeHtml(d.output)}</pre>`;
      if (d.expected) html += `<div class="label">Expected</div><pre>${escapeHtml(d.expected)}</pre>`;
    } else {
      html += `<div class="verdict-sub">${v.passed}/${v.total} example${v.total === 1 ? "" : "s"} passed${last.note ? ` · ${escapeHtml(last.note)}` : ""}</div>`;
      html += `<div class="case-list">${v.details
        .map((d, i) => `<button type="button" data-case="${i}" class="${d.passed ? "pass" : "fail"} ${i === selectedCase ? "active" : ""}">Case ${i + 1} ${d.passed ? "✓" : "✗"}</button>`)
        .join("")}</div>`;
      const d = v.details[selectedCase] || v.details[0];
      if (d) {
        const result = last.results[d.index] || {};
        const example = state.problem.examples[d.index];
        if (d.error) html += `<pre class="error-output">${escapeHtml(d.error)}</pre>`;
        if (example) html += `<div class="label">Input</div><pre>${escapeHtml(example.input)}</pre>`;
        if (!d.error) html += `<div class="label">Output</div><pre>${escapeHtml(formatValue(d.actual))}</pre>`;
        if (example) html += `<div class="label">Expected</div><pre>${escapeHtml(example.expectedText)}</pre>`;
        if (result.stdout) html += `<div class="label">Stdout</div><pre>${escapeHtml(result.stdout)}</pre>`;
      }
    }
    body.innerHTML = `<div class="result-output">${html}</div>`;
    body.querySelectorAll("[data-case]").forEach((button) =>
      button.addEventListener("click", () => {
        state.results.selectedCase = Number(button.dataset.case);
        renderResults();
      }),
    );
  }
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
  state.results.last = { kind: mode === "debug" ? "debug" : "run", input: state.testInput, results: [] };
  state.results.tab = mode === "debug" ? "debug" : "result";
  renderResults();
  updateBar();
  try {
    const results = await py.run({ code, metadata: problem.metaData, inputs: [state.testInput], mode, timeout: RUN_TIMEOUT });
    state.results.last.results = results;
  } catch (error) {
    state.results.last.results = [{ stdout: "", trace: [], actual: null, error: error.message, durationMs: 0 }];
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
  state.results.last = { kind: "submit", results: [], verdict: null };
  state.results.tab = "result";
  state.results.selectedCase = 0;
  renderResults();
  updateBar();
  try {
    let results = [];
    const payload = { sessionId: state.session, name: displayName(), slug: problem.titleSlug, duelId: duel?.id, code };
    if (useLeetCode) payload.mode = "leetcode";
    else {
      results = await py.run({ code, metadata: problem.metaData, inputs: problem.examples.map((e) => e.input), mode: "run", timeout: JUDGE_TIMEOUT });
      payload.results = results.map((r) => ({ actual: r.actual, error: r.error, durationMs: r.durationMs }));
    }
    const response = await api("/api/submit", { method: "POST", body: JSON.stringify(payload) });
    const verdict = response.verdict;
    if (!useLeetCode) {
      const firstFail = verdict.details.findIndex((d) => !d.passed);
      state.results.selectedCase = firstFail >= 0 ? firstFail : 0;
    }
    state.results.last = { kind: "submit", results, verdict, note: duel && duel.status === "complete" ? "The duel was already over." : "" };
  } catch (error) {
    state.results.last = {
      kind: "submit",
      results: [],
      verdict: { source: "examples", accepted: false, verdict: classifyError(error.message) === "Runtime Error" ? "Submission failed" : classifyError(error.message), passed: 0, total: 0, details: [] },
      note: error.message,
    };
    toast(error.message);
  } finally {
    state.results.running = false;
    renderResults();
    updateBar();
  }
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
  actions.innerHTML = `
    ${canVeto ? `<button type="button" class="bar-button" id="veto-button" ${meVetoed || running ? "disabled" : ""} title="If both players veto, a new problem is picked">Veto ${vetoCount}/2</button>` : ""}
    ${pyLabel ? `<span class="online-pill" style="font-size:12px">${pyLabel}</span>` : ""}
    <button type="button" class="bar-button" id="run-button" ${running ? "disabled" : ""} title="Run on the testcase (Ctrl/⌘+Enter)">Run</button>
    <button type="button" class="bar-button" id="debug-button" ${running ? "disabled" : ""} title="Trace line by line">Debug</button>
    <button type="button" class="bar-button primary" id="submit-button" ${running ? "disabled" : ""} title="${useLeetCode ? "Submit to LeetCode with your linked account" : "Run all examples (Ctrl/⌘+Shift+Enter)"}">${useLeetCode ? "Submit to LeetCode" : "Submit"}</button>`;
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
  const show = state.mode === "duel" && duel && duel.status === "complete" && state.duelId === duel.id;
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
