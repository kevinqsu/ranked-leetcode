const MAX_FILES = 4;
const MAX_FILE_SIZE = 3 * 1024 * 1024;
const MAX_TOTAL_SIZE = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  "c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "html", "java", "js", "jsx", "json", "kt", "md", "mjs", "php", "py", "rb", "rs",
  "sh", "sql", "swift", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
]);

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const TOKEN_START = "\uE000";
const TOKEN_END = "\uE001";
const MATHJAX_SOURCE = "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js";
let mathJaxPromise = null;
const typesetPending = new WeakMap();
let tokenSerial = 0;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenContext(source) {
  let prefix;
  do {
    prefix = `${TOKEN_START}${(tokenSerial++).toString(36)}${TOKEN_START}`;
  } while (source.includes(prefix));
  const pattern = new RegExp(`${escapeRegExp(prefix)}([mcl])(\\d+)${escapeRegExp(TOKEN_END)}`, "g");
  return { make: (kind, index) => `${prefix}${kind}${index}${TOKEN_END}`, pattern };
}

function likelyMath(value) {
  return /[A-Za-z\\^_{}=]|[+*/-]\s*[A-Za-z0-9]/.test(value) && !/^\s*[\d.,]+\s*$/.test(value);
}

function extractMath(source, math, makeToken) {
  const addMath = (body, display) => {
    math.push((display ? "\\[" : "\\(") + body + (display ? "\\]" : "\\)"));
    return makeToken("m", math.length - 1);
  };
  let value = source;
  value = value.replace(/\$\$([\s\S]*?)\$\$/g, (_, body) => addMath(body, true));
  value = value.replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => addMath(body, true));
  value = value.replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => addMath(body, false));
  return value.replace(/(^|[^\\$])\$([^$\n]+)\$(?!\$)/g, (match, prefix, body) =>
    likelyMath(body) ? prefix + addMath(body, false) : match);
}

function renderInline(text) {
  const code = [];
  const math = [];
  const links = [];
  let source = String(text ?? "");
  const context = tokenContext(source);
  source = source.replace(/`([^`\n]+)`/g, (_, value) => context.make("c", code.push(value) - 1));
  source = extractMath(source, math, context.make);
  source = source.replace(/\[([^\]\n]+)\]\(([^\s)]+)(?:\s+["'][^)]*["'])?\)/g, (_, label, href) => {
    if (!/^(?:https?:|mailto:)/i.test(href)) return _;
    return context.make("l", links.push({ label, href }) - 1);
  });
  let html = escapeHtml(source)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br />");
  html = html.replace(context.pattern, (_, kind, index) => {
    const item = Number(index);
    if (kind === "c") return code[item] !== undefined ? `<code>${escapeHtml(code[item])}</code>` : escapeHtml(context.make(kind, item));
    if (kind === "m") return math[item] !== undefined ? `<span class="study-math">${escapeHtml(math[item])}</span>` : escapeHtml(context.make(kind, item));
    const link = links[item];
    if (!link) return escapeHtml(context.make(kind, item));
    return `<a href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`;
  });
  return html;
}

function renderCodeBlock(language, code) {
  const label = String(language || "code").trim().toLowerCase() || "code";
  return `<pre><div class="study-code-label">${escapeHtml(label)}</div><code>${escapeHtml(code)}</code></pre>`;
}

function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s]*)\s*$/);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      const close = new RegExp(`^\\s{0,3}${marker}{${fence[1].length},}\\s*$`);
      const code = [];
      index += 1;
      while (index < lines.length && !close.test(lines[index])) code.push(lines[index++]);
      output.push(renderCodeBlock(fence[2], code.join("\n")));
      continue;
    }
    const display = line.match(/^\s{0,3}(\$\$|\\\[)\s*$/);
    if (display) {
      flushParagraph();
      const closing = display[1] === "$$" ? /^\s{0,3}\$\$\s*$/ : /^\s{0,3}\\\]\s*$/;
      const body = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index])) body.push(lines[index++]);
      output.push(`<div class="study-math study-math-display">${escapeHtml(`\\[${body.join("\n")}\\]`)}</div>`);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      output.push("<hr />");
      continue;
    }
    const quote = line.match(/^\s{0,3}> ?(.*)$/);
    if (quote) {
      flushParagraph();
      const quoted = [quote[1]];
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^\s{0,3}> ?(.*)$/);
        if (!next) break;
        quoted.push(next[1]);
        index += 1;
      }
      output.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }
    const list = line.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
    if (list) {
      flushParagraph();
      const ordered = /^\d/.test(list[1]);
      const items = [list[2]];
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        items.push(next[2]);
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      output.push(`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return output.join("");
}

function ensureMathJax() {
  if (typeof window === "undefined") return Promise.reject(new Error("Math rendering is unavailable."));
  if (window.MathJax?.typesetPromise) return Promise.resolve(window.MathJax);
  if (mathJaxPromise) return mathJaxPromise;
  window.MathJax = {
    ...(window.MathJax || {}),
    loader: { ...(window.MathJax?.loader || {}), load: [...new Set([...(window.MathJax?.loader?.load || []), "ui/safe"])] },
    tex: { ...(window.MathJax?.tex || {}), inlineMath: [["\\(", "\\)"], ["$", "$"]], displayMath: [["\\[", "\\]"], ["$$", "$$"]] },
    svg: { ...(window.MathJax?.svg || {}), fontCache: "global" },
    options: {
      ...(window.MathJax?.options || {}),
      safeOptions: {
        ...(window.MathJax?.options?.safeOptions || {}),
        allow: { ...(window.MathJax?.options?.safeOptions?.allow || {}), URLs: "none", styles: "none" },
      },
    },
    startup: { ...(window.MathJax?.startup || {}), typeset: false },
  };
  mathJaxPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = MATHJAX_SOURCE;
    script.async = true;
    script.onload = () => (window.MathJax.startup?.promise || Promise.resolve()).then(() => resolve(window.MathJax), reject);
    script.onerror = () => reject(new Error("Math rendering is unavailable."));
    document.head.append(script);
  });
  return mathJaxPromise;
}

function typesetMath(root) {
  if (!root?.querySelector(".study-math")) return;
  const html = root.innerHTML;
  const pending = typesetPending.get(root);
  if (pending?.html === html) return;
  const promise = ensureMathJax()
    .then((mathJax) => {
      if (root.innerHTML !== html) return;
      return mathJax.typesetPromise([root]);
    })
    .catch(() => {})
    .finally(() => {
      if (typesetPending.get(root)?.promise === promise) typesetPending.delete(root);
    });
  typesetPending.set(root, { html, promise });
}

function readableSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readableDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function supportedFile(file) {
  const extension = file.name.toLowerCase().split(".").pop();
  return TEXT_EXTENSIONS.has(extension) || file.type.startsWith("text/") || file.type === "application/pdf" ||
    ["application/json", "application/javascript", "application/xml", "image/gif", "image/jpeg", "image/png", "image/webp"].includes(file.type);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function renderMessageText(text) {
  return renderMarkdown(text);
}

function renderFilePills(files) {
  if (!files?.length) return "";
  return `<div class="study-message-files">${files
    .map((file) => `<span title="${escapeHtml(file.type || "")}"><span aria-hidden="true">↗</span>${escapeHtml(file.name)}<small>${readableSize(file.size)}</small></span>`)
    .join("")}</div>`;
}

export class StudyPage {
  constructor({ api, session, root, onError }) {
    this.api = api;
    this.session = session;
    this.root = root;
    this.onError = onError;
    this.conversations = [];
    this.activeId = null;
    this.messages = [];
    this.files = [];
    this.loading = false;
    this.sending = false;
    this.error = "";
    this.config = null;
    this.configError = "";
    this.options = {
      model: "",
      thinkingLevel: "",
      webSearch: false,
      codeExecution: true,
      urlContext: true,
    };
  }

  async open({ fresh = true } = {}) {
    if (fresh) {
      this.activeId = null;
      this.messages = [];
      this.files = [];
    }
    this.mount();
    await Promise.all([this.loadConfig(), this.loadHistory({ fresh })]);
  }

  close() {
    this.files = [];
    this.sending = false;
    this.error = "";
  }

  mount() {
    this.root().innerHTML = `
      <div class="study-page">
        <aside class="study-sidebar">
          <div class="study-sidebar-top">
            <strong>Sessions</strong>
            <button type="button" class="study-new" id="study-new">New session</button>
          </div>
          <details class="study-options" id="study-options">
            <summary>options</summary>
            <div class="study-options-body" id="study-options-body"></div>
          </details>
          <div class="study-history" id="study-history"></div>
        </aside>
        <section class="study-main">
          <div class="study-messages" id="study-messages" aria-live="polite"></div>
          <div class="study-composer-wrap">
            <div class="study-error" id="study-error" hidden></div>
            <div class="study-pending-files" id="study-pending-files"></div>
            <form class="study-composer" id="study-composer">
              <input id="study-file-input" type="file" multiple hidden
                accept=".c,.cc,.cpp,.cs,.css,.go,.h,.hpp,.html,.java,.js,.jsx,.json,.kt,.md,.mjs,.php,.py,.rb,.rs,.sh,.sql,.swift,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,application/pdf,image/png,image/jpeg,image/webp,image/gif" />
              <button class="study-attach" id="study-attach" type="button" title="Attach files" aria-label="Attach files">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 12.5l6.7-6.7a3 3 0 0 1 4.2 4.2l-8.8 8.8a5 5 0 0 1-7.1-7.1l8.5-8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              </button>
              <textarea id="study-input" rows="1" maxlength="24000" placeholder="Message" aria-label="Study message"></textarea>
              <button class="study-send" id="study-send" type="submit" aria-label="Send message">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0L6.5 10.5M12 5l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </form>
          </div>
        </section>
      </div>`;
    document.getElementById("study-new").addEventListener("click", () => this.newStudy());
    document.getElementById("study-attach").addEventListener("click", () => document.getElementById("study-file-input").click());
    document.getElementById("study-file-input").addEventListener("change", (event) => this.addFiles([...event.target.files]));
    document.getElementById("study-composer").addEventListener("submit", (event) => {
      event.preventDefault();
      this.send();
    });
    const input = document.getElementById("study-input");
    input.addEventListener("input", () => this.resizeComposer());
    input.addEventListener("paste", (event) => this.handlePaste(event));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    this.renderAll();
  }

  async loadConfig() {
    this.configError = "";
    try {
      const config = await this.api(`/api/study/config?sessionId=${encodeURIComponent(this.session())}`);
      if (!Array.isArray(config?.models) || !config.models.length) throw new Error("tutor options unavailable.");
      this.config = config;
      const model = config.models.find((item) => item.id === this.options.model) || config.models.find((item) => item.id === config.defaultModel) || config.models[0];
      this.options.model = model.id;
      this.options.thinkingLevel = model.thinkingLevels.includes(this.options.thinkingLevel)
        ? this.options.thinkingLevel
        : model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0] || "";
      this.renderOptions();
    } catch (error) {
      this.configError = error.message;
      this.renderOptions();
    }
  }

  async loadHistory({ fresh = false } = {}) {
    this.loading = true;
    this.error = "";
    this.renderAll();
    try {
      const result = await this.api(`/api/study?sessionId=${encodeURIComponent(this.session())}`);
      this.conversations = result.conversations || [];
      if (!fresh && !this.activeId && this.conversations.length) this.activeId = this.conversations[0].id;
      if (this.activeId) await this.selectConversation(this.activeId, { rerenderHistory: false });
    } catch (error) {
      this.error = error.message;
      this.onError(error);
    } finally {
      this.loading = false;
      this.renderAll();
    }
  }

  handlePaste(event) {
    if (this.sending) return;
    const items = [...(event.clipboardData?.items || [])];
    const files = [];
    const seen = new Set();
    const addImage = (file) => {
      if (!file) return;
      const normalized = file.name ? file : new File([file], "pasted-image.png", { type: file.type });
      const key = `${normalized.name}\u0000${normalized.size}\u0000${normalized.type}\u0000${normalized.lastModified || 0}`;
      if (seen.has(key)) return;
      seen.add(key);
      files.push(normalized);
    };
    for (const item of items) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile?.();
      addImage(file);
    }
    if (!files.length) {
      for (const file of [...(event.clipboardData?.files || [])]) {
        if (file.type.startsWith("image/")) addImage(file);
      }
    }
    if (!files.length) return;
    this.addFiles(files);
    if (!items.some((item) => item.kind === "string" && item.type === "text/plain")) event.preventDefault();
  }

  updateOption(name, value) {
    if (name === "model") {
      const model = this.config?.models?.find((item) => item.id === value);
      if (!model) return;
      this.options.model = model.id;
      if (!model.thinkingLevels.includes(this.options.thinkingLevel)) {
        this.options.thinkingLevel = model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0] || "";
      }
    } else if (name === "thinkingLevel") {
      this.options.thinkingLevel = value;
    } else if (["webSearch", "codeExecution", "urlContext"].includes(name)) {
      this.options[name] = Boolean(value);
    }
    this.renderOptions();
  }

  renderOptions() {
    const root = document.getElementById("study-options-body");
    if (!root) return;
    if (!this.config) {
      root.innerHTML = this.configError ? `<span class="study-options-error">${escapeHtml(this.configError)}</span>` : `<span class="study-options-loading">loading…</span>`;
      return;
    }
    const model = this.config.models.find((item) => item.id === this.options.model) || this.config.models[0];
    const thinking = model.thinkingLevels || [];
    root.innerHTML = `
      <label>model<select id="study-model" aria-label="model">${this.config.models.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === model.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label>
      <label>thinking<select id="study-thinking" aria-label="thinking">${thinking.map((level) => `<option value="${escapeHtml(level)}" ${level === this.options.thinkingLevel ? "selected" : ""}>${escapeHtml(level)}</option>`).join("")}</select></label>
      <label class="study-check"><input id="study-web-search" type="checkbox" ${this.options.webSearch ? "checked" : ""} /> web search <small>may require billing</small></label>
      <label class="study-check"><input id="study-code-execution" type="checkbox" ${this.options.codeExecution ? "checked" : ""} /> code execution</label>
      <label class="study-check"><input id="study-url-context" type="checkbox" ${this.options.urlContext ? "checked" : ""} /> url context</label>`;
    document.getElementById("study-model").addEventListener("change", (event) => this.updateOption("model", event.target.value));
    document.getElementById("study-thinking").addEventListener("change", (event) => this.updateOption("thinkingLevel", event.target.value));
    document.getElementById("study-web-search").addEventListener("change", (event) => this.updateOption("webSearch", event.target.checked));
    document.getElementById("study-code-execution").addEventListener("change", (event) => this.updateOption("codeExecution", event.target.checked));
    document.getElementById("study-url-context").addEventListener("change", (event) => this.updateOption("urlContext", event.target.checked));
  }

  newStudy() {
    if (this.sending) return;
    this.activeId = null;
    this.messages = [];
    this.files = [];
    this.error = "";
    this.renderAll();
    document.getElementById("study-input")?.focus();
  }

  async selectConversation(id, { rerenderHistory = true } = {}) {
    if (this.sending || !id) return;
    this.activeId = id;
    this.loading = true;
    this.error = "";
    if (rerenderHistory) this.renderAll();
    try {
      const result = await this.api(`/api/study/conversations/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(this.session())}`);
      if (this.activeId !== id) return;
      this.messages = result.conversation?.messages || [];
    } catch (error) {
      this.error = error.message;
    } finally {
      this.loading = false;
      this.renderAll();
    }
  }

  addFiles(incoming) {
    this.error = "";
    for (const file of incoming) {
      if (this.files.length >= MAX_FILES) {
        this.error = `Attach at most ${MAX_FILES} files at a time.`;
        break;
      }
      if (!supportedFile(file)) {
        this.error = `${file.name} is not a supported code, text, image, or PDF file.`;
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        this.error = `${file.name} must be smaller than 3 MB.`;
        continue;
      }
      if (this.files.reduce((sum, item) => sum + item.size, 0) + file.size > MAX_TOTAL_SIZE) {
        this.error = "Attachments must total less than 5 MB.";
        break;
      }
      this.files.push(file);
    }
    document.getElementById("study-file-input").value = "";
    this.renderPendingFiles();
    this.renderError();
  }

  removeFile(index) {
    this.files.splice(index, 1);
    this.error = "";
    this.renderPendingFiles();
    this.renderError();
  }

  async send() {
    if (this.sending) return;
    const input = document.getElementById("study-input");
    const text = input.value.trim();
    if (!text && !this.files.length) return;
    this.sending = true;
    this.error = "";
    const selectedFiles = [...this.files];
    const optimistic = {
      id: "pending-user",
      role: "user",
      text,
      files: selectedFiles.map((file, index) => ({ id: `pending-${index}`, name: file.name, type: file.type, size: file.size })),
      createdAt: Date.now(),
    };
    this.messages = [...this.messages, optimistic];
    input.value = "";
    this.files = [];
    this.resizeComposer();
    this.renderAll();
    try {
      const files = await Promise.all(selectedFiles.map(async (file) => ({
        name: file.name,
        type: file.type,
        data: await fileToBase64(file),
      })));
      const result = await this.api("/api/study/message", {
        method: "POST",
        body: JSON.stringify({
          sessionId: this.session(),
          conversationId: this.activeId,
          text,
          files,
          options: { ...this.options },
        }),
      });
      this.activeId = result.conversation.id;
      this.messages = result.conversation.messages || [];
      this.conversations = result.conversations || [];
    } catch (error) {
      this.messages = this.messages.filter((message) => message.id !== optimistic.id);
      input.value = text;
      this.files = selectedFiles;
      this.error = error.message;
    } finally {
      this.sending = false;
      this.renderAll();
      if (!this.error) input.focus();
    }
  }

  resizeComposer() {
    const input = document.getElementById("study-input");
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  renderHistory() {
    const root = document.getElementById("study-history");
    if (!root) return;
    root.innerHTML = this.conversations.length
      ? this.conversations.map((conversation) => `
          <button type="button" data-study-id="${escapeHtml(conversation.id)}" class="${conversation.id === this.activeId ? "active" : ""}">
            <span>${escapeHtml(conversation.title)}</span>
            <small>${readableDate(conversation.updatedAt)}</small>
          </button>`).join("")
      : `<div class="study-history-empty">Your conversations will appear here.</div>`;
    root.querySelectorAll("[data-study-id]").forEach((button) =>
      button.addEventListener("click", () => this.selectConversation(button.dataset.studyId)));
  }

  renderMessages() {
    const root = document.getElementById("study-messages");
    if (!root) return;
    if (this.loading && !this.messages.length) {
      root.innerHTML = `<div class="study-loading"><span></span><span></span><span></span></div>`;
      return;
    }
    if (!this.messages.length) {
      root.innerHTML = `
        <div class="study-empty">
          <div class="study-mark">✦</div>
          <h1>What are you working on?</h1>
        </div>`;
      return;
    }
    root.innerHTML = `<div class="study-thread">${this.messages.map((message) => `
      <article class="study-message ${message.role === "response" ? "response" : "user"}">
        <div class="study-message-role">${message.role === "response" ? "Response" : "You"}</div>
        <div class="study-message-body">${renderFilePills(message.files)}${renderMessageText(message.text)}</div>
      </article>`).join("")}
      ${this.sending ? `<article class="study-message response pending"><div class="study-message-role">Response</div><div class="study-loading"><span></span><span></span><span></span></div></article>` : ""}
    </div>`;
    typesetMath(root);
    requestAnimationFrame(() => root.scrollTo({ top: root.scrollHeight, behavior: this.sending ? "smooth" : "auto" }));
  }

  renderPendingFiles() {
    const root = document.getElementById("study-pending-files");
    if (!root) return;
    root.innerHTML = this.files.map((file, index) => `
      <span><span>${escapeHtml(file.name)}</span><small>${readableSize(file.size)}</small>
        <button type="button" data-remove-file="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button>
      </span>`).join("");
    root.querySelectorAll("[data-remove-file]").forEach((button) =>
      button.addEventListener("click", () => this.removeFile(Number(button.dataset.removeFile))));
  }

  renderError() {
    const root = document.getElementById("study-error");
    if (!root) return;
    root.textContent = this.error;
    root.hidden = !this.error;
  }

  renderAll() {
    this.renderOptions();
    this.renderHistory();
    this.renderMessages();
    this.renderPendingFiles();
    this.renderError();
    const input = document.getElementById("study-input");
    const send = document.getElementById("study-send");
    const attach = document.getElementById("study-attach");
    if (input) input.disabled = this.sending;
    if (send) send.disabled = this.sending;
    if (attach) attach.disabled = this.sending;
    this.resizeComposer();
  }
}
