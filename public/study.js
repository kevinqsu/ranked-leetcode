const MAX_FILES = 4;
const MAX_FILE_SIZE = 3 * 1024 * 1024;
const MAX_TOTAL_SIZE = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  "c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "html", "java", "js", "jsx", "json", "kt", "md", "mjs", "php", "py", "rb", "rs",
  "sh", "sql", "swift", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
]);

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

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
  const chunks = String(text || "").split("```");
  return chunks
    .map((chunk, index) => {
      if (index % 2) {
        const newline = chunk.indexOf("\n");
        const language = newline > -1 ? chunk.slice(0, newline).trim() : "";
        const code = newline > -1 ? chunk.slice(newline + 1) : chunk;
        return `<pre><div class="study-code-label">${escapeHtml(language || "code")}</div><code>${escapeHtml(code)}</code></pre>`;
      }
      return `<div class="study-prose">${escapeHtml(chunk)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br />")}</div>`;
    })
    .join("");
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
  }

  async open() {
    this.mount();
    await this.loadHistory();
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
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    this.renderAll();
  }

  async loadHistory() {
    this.loading = true;
    this.error = "";
    this.renderAll();
    try {
      const result = await this.api(`/api/study?sessionId=${encodeURIComponent(this.session())}`);
      this.conversations = result.conversations || [];
      if (!this.activeId && this.conversations.length) this.activeId = this.conversations[0].id;
      if (this.activeId) await this.selectConversation(this.activeId, { rerenderHistory: false });
    } catch (error) {
      this.error = error.message;
      this.onError(error);
    } finally {
      this.loading = false;
      this.renderAll();
    }
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
