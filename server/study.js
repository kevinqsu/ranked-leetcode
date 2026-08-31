import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ENGINE = "gemini-3.7-flash";
const STUDY_MODELS = Object.freeze([
  Object.freeze({
    id: "gemini-3.7-flash",
    label: "gemini 3.7 flash",
    thinkingLevels: Object.freeze(["low", "medium", "high"]),
    tools: Object.freeze(["webSearch", "codeExecution", "urlContext"]),
  }),
  Object.freeze({
    id: "gemini-3.6-flash",
    label: "gemini 3.6 flash",
    thinkingLevels: Object.freeze(["minimal", "low", "medium", "high"]),
    tools: Object.freeze(["webSearch", "codeExecution", "urlContext"]),
  }),
  Object.freeze({
    id: "gemini-3.5-flash",
    label: "gemini 3.5 flash",
    thinkingLevels: Object.freeze(["minimal", "low", "medium", "high"]),
    tools: Object.freeze(["webSearch", "codeExecution", "urlContext"]),
  }),
  Object.freeze({
    id: "gemini-3.5-flash-lite",
    label: "gemini 3.5 flash-lite",
    thinkingLevels: Object.freeze(["minimal", "low", "medium", "high"]),
    tools: Object.freeze(["webSearch", "codeExecution", "urlContext"]),
  }),
  Object.freeze({
    id: "gemini-3.1-flash-lite",
    label: "gemini 3.1 flash-lite",
    thinkingLevels: Object.freeze(["minimal", "low", "medium", "high"]),
    tools: Object.freeze(["webSearch", "codeExecution", "urlContext"]),
  }),
]);
const STUDY_MODELS_BY_ID = new Map(STUDY_MODELS.map((model) => [model.id, model]));
const ENV_ENGINE = process.env.STUDY_ENGINE || DEFAULT_ENGINE;
const DEFAULT_MODEL = STUDY_MODELS_BY_ID.has(ENV_ENGINE) ? ENV_ENGINE : DEFAULT_ENGINE;
const STUDY_TOOL_REQUESTS = Object.freeze({
  webSearch: { googleSearch: {} },
  codeExecution: { codeExecution: {} },
  urlContext: { urlContext: {} },
});
const MAX_CONVERSATIONS = 24;
const MAX_MESSAGES = 60;
const MAX_CONTEXT_MESSAGES = 30;
const MAX_TEXT = 24_000;
const MAX_FILES = 4;
const MAX_FILE = 3 * 1024 * 1024;
const MAX_FILES_TOTAL = 5 * 1024 * 1024;
const MAX_CONTEXT_FILES = 7 * 1024 * 1024;
const MAX_ACCOUNT_FILES = 64 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".json", ".kt",
  ".md", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const MEDIA_TYPES = new Set(["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp"]);

export const MAX_STUDY_BODY = 7 * 1024 * 1024;

export class StudyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "StudyError";
    this.status = status;
  }
}

function cleanOptionString(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeOptions(input, defaultModel = DEFAULT_MODEL) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const requestedModel = cleanOptionString(raw.model || raw.engine) || defaultModel;
  const model = STUDY_MODELS_BY_ID.get(requestedModel);
  if (!model) throw new StudyError("That study model is not available.");

  const requestedThinking = cleanOptionString(raw.thinkingLevel || raw.thinking || raw.reasoning);
  if (requestedThinking && !model.thinkingLevels.includes(requestedThinking)) {
    throw new StudyError(`That model does not support ${requestedThinking} thinking.`);
  }

  const tools = Object.fromEntries(model.tools.map((name) => [name, raw[name] === true]));
  return {
    model: model.id,
    thinkingLevel: requestedThinking || "",
    ...tools,
  };
}

function publicConfig(defaultModel) {
  return {
    defaultModel,
    models: STUDY_MODELS.map(({ id, label, thinkingLevels, tools }) => ({
      id,
      label,
      thinkingLevels: [...thinkingLevels],
      tools: [...tools],
    })),
  };
}

function requestFor(account, messages, options, buildContents) {
  const body = { contents: buildContents(account, messages) };
  const tools = Object.entries(STUDY_TOOL_REQUESTS)
    .filter(([name]) => options[name])
    .map(([, tool]) => tool);
  if (tools.length) {
    body.tools = tools;
    body.toolConfig = { includeServerSideToolInvocations: true };
  }
  if (options.thinkingLevel) {
    body.generationConfig = { thinkingConfig: { thinkingLevel: options.thinkingLevel } };
  }
  return body;
}

function atomicWrite(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function cleanText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > MAX_TEXT) throw new StudyError(`Messages can be at most ${MAX_TEXT.toLocaleString()} characters.`);
  return text;
}

function cleanName(value) {
  const name = String(value || "file").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
  return name || "file";
}

function normalizeMime(name, value) {
  let mime = String(value || "").toLowerCase().split(";")[0].trim();
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain";
  if (mime.startsWith("text/")) return "text/plain";
  if (mime === "application/json" || mime === "application/javascript" || mime === "application/xml") return "text/plain";
  if (MEDIA_TYPES.has(mime)) return mime;
  return "";
}

function decodeFile(input) {
  const name = cleanName(input?.name);
  const mime = normalizeMime(name, input?.type);
  if (!mime) throw new StudyError(`${name} is not a supported code, text, image, or PDF file.`);
  const encoded = typeof input?.data === "string" ? input.data : "";
  if (!encoded || encoded.length > Math.ceil(MAX_FILE * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new StudyError(`${name} is not a valid upload.`);
  }
  const body = Buffer.from(encoded, "base64");
  if (!body.length || body.length > MAX_FILE) throw new StudyError(`${name} must be smaller than 3 MB.`);
  return { name, mime, body };
}

function publicConversation(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      files: (message.files || []).map(({ id, name, mime, size }) => ({ id, name, type: mime, size })),
    })),
  };
}

function titleFor(text, files) {
  const source = text || files[0]?.name || "New study";
  const oneLine = source.replace(/\s+/g, " ").trim();
  return oneLine.length > 54 ? `${oneLine.slice(0, 53)}…` : oneLine || "New study";
}

export class StudyService {
  constructor(dataDir, { apiKey = process.env.STUDY_API_KEY || "", model = DEFAULT_MODEL, mock = process.env.STUDY_MOCK === "1" } = {}) {
    this.root = path.join(dataDir, "study");
    this.apiKey = apiKey;
    const requestedModel = cleanOptionString(model);
    this.model = STUDY_MODELS_BY_ID.has(requestedModel) ? requestedModel : DEFAULT_ENGINE;
    this.mock = mock;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  config() {
    return publicConfig(this.model);
  }

  account(username) {
    const key = crypto.createHash("sha256").update(String(username || "").trim().toLowerCase()).digest("hex");
    const dir = path.join(this.root, key);
    const conversations = path.join(dir, "conversations");
    const files = path.join(dir, "files");
    fs.mkdirSync(conversations, { recursive: true, mode: 0o700 });
    fs.mkdirSync(files, { recursive: true, mode: 0o700 });
    return { dir, conversations, files };
  }

  conversationFile(account, id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id || ""))) throw new StudyError("Invalid conversation.");
    return path.join(account.conversations, `${id}.json`);
  }

  read(account, id) {
    const file = this.conversationFile(account, id);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || parsed.id !== id || !Array.isArray(parsed.messages)) throw new Error("invalid conversation");
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") throw new StudyError("Conversation not found.", 404);
      if (error instanceof StudyError) throw error;
      throw new StudyError("Conversation could not be read.", 500);
    }
  }

  summaries(username) {
    const account = this.account(username);
    const summaries = [];
    for (const name of fs.readdirSync(account.conversations)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const conversation = JSON.parse(fs.readFileSync(path.join(account.conversations, name), "utf8"));
        summaries.push({ id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt });
      } catch {
        /* ignore a damaged history item */
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
  }

  get(username, id) {
    return publicConversation(this.read(this.account(username), id));
  }

  fileUsage(account) {
    let total = 0;
    for (const name of fs.readdirSync(account.files)) {
      try {
        total += fs.statSync(path.join(account.files, name)).size;
      } catch {
        /* file disappeared between listing and stat */
      }
    }
    return total;
  }

  removeConversationFiles(account, conversation) {
    for (const message of conversation.messages || []) {
      for (const file of message.files || []) {
        try {
          fs.unlinkSync(path.join(account.files, file.id));
        } catch {
          /* already gone */
        }
      }
    }
  }

  enforceRetention(account) {
    const items = [];
    for (const name of fs.readdirSync(account.conversations)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(account.conversations, name);
      try {
        const conversation = JSON.parse(fs.readFileSync(file, "utf8"));
        items.push({ file, conversation, updatedAt: conversation.updatedAt || 0 });
      } catch {
        /* leave unreadable files for an administrator to inspect */
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const item of items.slice(MAX_CONVERSATIONS)) {
      this.removeConversationFiles(account, item.conversation);
      try { fs.unlinkSync(item.file); } catch { /* already gone */ }
    }
  }

  writeUploads(account, inputs) {
    if (!Array.isArray(inputs)) return [];
    if (inputs.length > MAX_FILES) throw new StudyError(`Attach at most ${MAX_FILES} files at a time.`);
    const decoded = inputs.map(decodeFile);
    const total = decoded.reduce((sum, file) => sum + file.body.length, 0);
    if (total > MAX_FILES_TOTAL) throw new StudyError("Attachments must total less than 5 MB.");
    if (this.fileUsage(account) + total > MAX_ACCOUNT_FILES) throw new StudyError("This account's study file storage is full.", 413);
    const saved = [];
    try {
      for (const file of decoded) {
        const id = crypto.randomUUID();
        fs.writeFileSync(path.join(account.files, id), file.body, { mode: 0o600, flag: "wx" });
        saved.push({ id, name: file.name, mime: file.mime, size: file.body.length });
      }
      return saved;
    } catch (error) {
      for (const file of saved) {
        try { fs.unlinkSync(path.join(account.files, file.id)); } catch { /* already gone */ }
      }
      throw new StudyError("The upload could not be saved.", 500);
    }
  }

  buildContents(account, messages) {
    const selected = messages.slice(-MAX_CONTEXT_MESSAGES);
    let fileBytes = 0;
    return selected.map((message) => {
      if (message.role === "response" && Array.isArray(message.parts) && message.parts.length) {
        return { role: "model", parts: message.parts.filter((part) => part && typeof part === "object") };
      }
      const parts = [];
      if (message.text) parts.push({ text: message.text });
      if (message.role === "user") {
        for (const file of message.files || []) {
          if (fileBytes + file.size > MAX_CONTEXT_FILES) continue;
          try {
            const body = fs.readFileSync(path.join(account.files, file.id));
            fileBytes += body.length;
            parts.push({ inline_data: { mime_type: file.mime, data: body.toString("base64") } });
          } catch {
            /* a missing old attachment does not destroy the conversation */
          }
        }
      }
      if (message.role === "user" && !message.text && parts.some((part) => part.inline_data)) {
        parts.unshift({ text: "Analyze the attachment." });
      }
      return { role: message.role === "response" ? "model" : "user", parts: parts.length ? parts : [{ text: " " }] };
    });
  }

  async generate(account, messages, options) {
    options = normalizeOptions(options, this.model);
    if (this.mock) {
      const latest = [...messages].reverse().find((message) => message.role === "user");
      const text = `Mock reply: ${latest?.text || latest?.files?.[0]?.name || "message received"}`;
      return { text, parts: [{ text }] };
    }
    if (!this.apiKey) throw new StudyError("Study is temporarily unavailable.", 503);
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(requestFor(account, messages, options, this.buildContents.bind(this))),
        signal: AbortSignal.timeout(70_000),
      });
    } catch (error) {
      throw new StudyError(error?.name === "TimeoutError" ? "The response timed out. Try again." : "Could not reach the study service.", 502);
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* handled below */ }
    if (!response.ok) {
      const message = response.status === 429 ? "Study is busy right now. Try again shortly." : "The study service rejected the request.";
      throw new StudyError(message, response.status === 429 ? 429 : 502);
    }
    const parts = Array.isArray(payload?.candidates?.[0]?.content?.parts) ? payload.candidates[0].content.parts : [];
    const text = parts
      .filter((part) => part?.thought !== true)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (!text) throw new StudyError("The study service returned no response. Try rephrasing your message.", 502);
    return { text: text.slice(0, 80_000), parts };
  }

  async send(username, { conversationId, text: inputText, files: inputFiles, options: inputOptions }) {
    const text = cleanText(inputText);
    if (!text && (!Array.isArray(inputFiles) || !inputFiles.length)) throw new StudyError("Write a message or attach a file.");
    const options = normalizeOptions(inputOptions, this.model);
    const account = this.account(username);
    let conversation;
    if (conversationId) conversation = this.read(account, conversationId);
    else {
      const now = Date.now();
      conversation = { id: crypto.randomUUID(), title: "New study", createdAt: now, updatedAt: now, messages: [] };
    }
    const files = this.writeUploads(account, inputFiles);
    const now = Date.now();
    const userMessage = { id: crypto.randomUUID(), role: "user", text, files, createdAt: now };
    const nextMessages = [...conversation.messages, userMessage];
    let answer;
    try {
      answer = await this.generate(account, nextMessages, options);
    } catch (error) {
      for (const file of files) {
        try { fs.unlinkSync(path.join(account.files, file.id)); } catch { /* already gone */ }
      }
      throw error;
    }
    const answerText = typeof answer === "string" ? answer : answer.text;
    const answerParts = typeof answer === "string" ? [{ text: answer }] : answer.parts;
    nextMessages.push({ id: crypto.randomUUID(), role: "response", text: answerText, parts: answerParts, files: [], createdAt: Date.now() });
    if (conversation.messages.length === 0) conversation.title = titleFor(text, files);
    const trimmedMessages = nextMessages.slice(0, Math.max(0, nextMessages.length - MAX_MESSAGES));
    conversation.messages = nextMessages.slice(-MAX_MESSAGES);
    this.removeConversationFiles(account, { messages: trimmedMessages });
    conversation.updatedAt = Date.now();
    atomicWrite(this.conversationFile(account, conversation.id), conversation);
    this.enforceRetention(account);
    return { conversation: publicConversation(conversation), conversations: this.summaries(username) };
  }
}
