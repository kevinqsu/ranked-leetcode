// Tiny JSON-file persistence. State is small (open/active duels, a few users),
// so a single file with atomic writes is plenty. Nothing here is served over HTTP.

import fs from "node:fs";
import path from "node:path";

export class Store {
  constructor(dir, name = "state.json") {
    this.dir = dir;
    this.file = path.join(dir, name);
    this.tmp = path.join(dir, name + ".tmp");
    this.timer = null;
    this.data = null;
  }

  load(defaults) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.data = { ...defaults, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch (error) {
      if (error.code !== "ENOENT") console.error("[store] could not read state, starting fresh:", error.message);
      this.data = { ...defaults };
    }
    return this.data;
  }

  // Debounced save; many mutations in quick succession produce one write.
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 150);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.data) return;
    try {
      fs.writeFileSync(this.tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(this.tmp, this.file);
    } catch (error) {
      console.error("[store] save failed:", error.message);
    }
  }
}
