// Duel engine: lobby (open challenges), quick match, shared problem, veto,
// submissions, presence, rematch and expiry. State is persisted through Store.

import crypto from "node:crypto";
import { LeetCodeError, getProblem, lookupProblem, normalizeDifficulty, randomProblem } from "./leetcode.js";

const OPEN_MAX_AGE = 30 * 60 * 1000;
const OPEN_OFFLINE_GRACE = 45 * 1000;
const STARTING_MAX_AGE = 90 * 1000;
const ACTIVE_MAX_AGE = 3 * 60 * 60 * 1000;
const ACTIVE_BOTH_OFFLINE = 10 * 60 * 1000;
const FINISHED_RETENTION = 3 * 60 * 60 * 1000;
const USER_RETENTION = 60 * 24 * 60 * 60 * 1000;
const POLL_PRESENCE_WINDOW = 8 * 1000;
const MAX_REROLLS = 5;

export class DuelError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function cleanName(value) {
  const text = String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
  return text || "Guest";
}

export function isValidSessionId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{12,64}$/.test(value);
}

export class DuelEngine {
  constructor(store) {
    this.store = store;
    this.state = store.data;
    this.state.users ||= {};
    this.state.duels ||= {};
    this.connections = new Map(); // sessionId -> Set<WsConnection>
    this.lastSeen = new Map(); // sessionId -> timestamp (polling clients)
    this.watching = new Map(); // sessionId -> duelId
    this.liveCode = new Map(); // duelId -> Map<sessionId, {code, at, lastRun}> (spectator feed, memory only)
    this.broadcastTimer = null;
    this.bootedAt = Date.now();
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 1000);
    this.cleanup();
  }

  // ----------------------------------------------------------------------- users

  touch(sessionId, name) {
    if (!isValidSessionId(sessionId)) throw new DuelError("Invalid session.", 400);
    const users = this.state.users;
    const user = (users[sessionId] ||= { name: "Guest", createdAt: Date.now() });
    if (name !== undefined) user.name = cleanName(name);
    user.lastSeen = Date.now();
    this.lastSeen.set(sessionId, Date.now());
    this.store.save();
    return user;
  }

  user(sessionId) {
    return this.state.users[sessionId] || null;
  }

  isLinked(sessionId) {
    const user = this.user(sessionId);
    return !!(user && user.leetcode && user.leetcode.session);
  }

  // -------------------------------------------------------------------- presence

  addConnection(sessionId, conn) {
    if (!this.connections.has(sessionId)) this.connections.set(sessionId, new Set());
    this.connections.get(sessionId).add(conn);
    conn.on("close", () => {
      const set = this.connections.get(sessionId);
      if (set) {
        set.delete(conn);
        if (!set.size) this.connections.delete(sessionId);
      }
      this.lastSeen.set(sessionId, Date.now());
      this.changed();
    });
    this.changed();
  }

  isOnline(sessionId) {
    if (this.connections.has(sessionId)) return true;
    const seen = this.lastSeen.get(sessionId) || 0;
    return Date.now() - seen < POLL_PRESENCE_WINDOW;
  }

  onlineCount() {
    const ids = new Set(this.connections.keys());
    for (const [id, seen] of this.lastSeen) if (Date.now() - seen < POLL_PRESENCE_WINDOW) ids.add(id);
    return ids.size;
  }

  watch(sessionId, duelId) {
    const duel = duelId ? this.state.duels[duelId] : null;
    if (duel && duel.creatorId !== sessionId && duel.opponentId !== sessionId) this.watching.set(sessionId, duelId);
    else this.watching.delete(sessionId);
    this.changed();
  }

  watchersOf(duelId) {
    const ids = [];
    for (const [sessionId, id] of this.watching) if (id === duelId && this.isOnline(sessionId)) ids.push(sessionId);
    return ids;
  }

  spectatorNames(duel) {
    return this.watchersOf(duel.id)
      .slice(0, 12)
      .map((id) => this.user(id)?.name || "Guest");
  }

  codesFor(duel) {
    const entries = this.liveCode.get(duel.id);
    const codes = {};
    if (!entries) return codes;
    for (const [playerId, entry] of entries) codes[playerId] = entry;
    return codes;
  }

  // A player's editor contents (debounced client-side, only sent while someone watches).
  setLiveCode({ sessionId, duelId, code, lastRun }) {
    const duel = typeof duelId === "string" ? this.state.duels[duelId] : null;
    if (!duel || (duel.creatorId !== sessionId && duel.opponentId !== sessionId)) return false;
    if (duel.status !== "active" && duel.status !== "complete") return false;
    if (!this.liveCode.has(duel.id)) this.liveCode.set(duel.id, new Map());
    const entry = {
      code: String(code || "").slice(0, 64 * 1024),
      at: Date.now(),
      lastRun: lastRun && typeof lastRun === "object" ? {
        kind: lastRun.kind === "submit" ? "submit" : "run",
        verdict: String(lastRun.verdict || "").slice(0, 40),
        passed: Number(lastRun.passed) || 0,
        total: Number(lastRun.total) || 0,
        at: Number(lastRun.at) || Date.now(),
      } : null,
    };
    this.liveCode.get(duel.id).set(sessionId, entry);
    const payload = JSON.stringify({ type: "code", duelId: duel.id, playerId: sessionId, ...entry });
    for (const watcherId of this.watchersOf(duel.id)) {
      for (const conn of this.connections.get(watcherId) || []) conn.send(payload);
    }
    return true;
  }

  // ------------------------------------------------------------------- views

  duelsOf(sessionId) {
    return Object.values(this.state.duels).filter((d) => d.creatorId === sessionId || d.opponentId === sessionId);
  }

  currentDuel(sessionId) {
    const mine = this.duelsOf(sessionId).filter((d) => !(d.dismissed && d.dismissed[sessionId]));
    const rank = { active: 0, starting: 1, open: 2, complete: 3, cancelled: 4 };
    mine.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.updatedAt - a.updatedAt);
    const best = mine[0];
    if (!best) return null;
    if (best.status === "cancelled" && best.endReason !== "forfeit" && best.endReason !== "expired") return null;
    return best;
  }

  publicDuel(duel, { forWatcher = false } = {}) {
    if (!duel) return null;
    const players = [];
    for (const [role, id, name] of [
      ["creator", duel.creatorId, duel.creatorName],
      ["opponent", duel.opponentId, duel.opponentName],
    ]) {
      if (!id) continue;
      const stats = (duel.stats && duel.stats[id]) || {};
      players.push({
        id,
        name,
        role,
        online: this.isOnline(id),
        attempts: stats.attempts || 0,
        bestPassed: stats.bestPassed || 0,
        total: stats.total || 0,
        lastVerdict: stats.lastVerdict || "",
        lastAt: stats.lastAt || 0,
        vetoed: role === "creator" ? !!duel.vetoCreator : !!duel.vetoOpponent,
        wantsRematch: !!(duel.rematch && duel.rematch[id]),
        left: !!(duel.dismissed && duel.dismissed[id]),
      });
    }
    return {
      id: duel.id,
      status: duel.status,
      difficulty: duel.difficulty,
      judging: duel.judging,
      createdAt: duel.createdAt,
      startedAt: duel.startedAt || 0,
      endedAt: duel.endedAt || 0,
      problem: duel.problemSlug ? { slug: duel.problemSlug, id: duel.problemId, title: duel.problemTitle } : null,
      requestedProblem: duel.requestedSlug ? { slug: duel.requestedSlug, id: duel.requestedId, title: duel.requestedTitle } : null,
      rerolls: duel.rerolls || 0,
      players,
      winnerId: duel.winnerId || null,
      winnerName: duel.winnerName || null,
      endReason: duel.endReason || null,
      rematchDuelId: duel.rematchDuelId || null,
      spectators: this.spectatorNames(duel),
      codes: forWatcher ? this.codesFor(duel) : undefined,
    };
  }

  view(sessionId) {
    const user = this.user(sessionId);
    const duels = Object.values(this.state.duels);
    const challenges = duels
      .filter((d) => d.status === "open" && d.creatorId !== sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((d) => ({
        id: d.id,
        creatorName: d.creatorName,
        difficulty: d.difficulty,
        judging: d.judging,
        problem: d.requestedSlug ? { id: d.requestedId, title: d.requestedTitle } : null,
        createdAt: d.createdAt,
        online: this.isOnline(d.creatorId),
      }));
    const games = duels
      .filter((d) => d.status === "active")
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 30)
      .map((d) => ({
        id: d.id,
        creatorName: d.creatorName,
        opponentName: d.opponentName,
        difficulty: d.difficulty,
        problem: { id: d.problemId, title: d.problemTitle },
        startedAt: d.startedAt,
      }));
    const watchId = this.watching.get(sessionId);
    return {
      now: Date.now(),
      me: {
        id: sessionId,
        name: user ? user.name : "Guest",
        linked: this.isLinked(sessionId),
        leetcodeUser: user?.leetcode?.username || null,
      },
      online: this.onlineCount(),
      challenges,
      games,
      duel: this.publicDuel(this.currentDuel(sessionId)),
      watch: watchId ? this.publicDuel(this.state.duels[watchId], { forWatcher: true }) : null,
    };
  }

  changed() {
    this.store.save();
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      for (const [sessionId, conns] of this.connections) {
        let payload;
        try {
          payload = JSON.stringify({ type: "view", view: this.view(sessionId) });
        } catch (error) {
          console.error("[duels] view failed:", error);
          continue;
        }
        for (const conn of conns) conn.send(payload);
      }
    }, 30);
  }

  // ------------------------------------------------------------------ actions

  get(duelId) {
    const duel = typeof duelId === "string" ? this.state.duels[duelId] : null;
    if (!duel) throw new DuelError("Duel not found.", 404);
    return duel;
  }

  async createChallenge({ sessionId, name, difficulty, judging, problemQuery }) {
    const user = this.touch(sessionId, name);
    const level = normalizeDifficulty(difficulty);
    if (!level) throw new DuelError("Pick a difficulty.");
    const mode = judging === "leetcode" ? "leetcode" : "examples";
    if (mode === "leetcode" && !this.isLinked(sessionId)) throw new DuelError("Link a LeetCode account to use LeetCode judging.");

    let requested = null;
    if (problemQuery) {
      requested = await lookupProblem(problemQuery);
      if (mode === "examples" && !requested.judgeable) {
        throw new DuelError(`#${requested.id} ${requested.title} cannot be auto-judged: ${requested.judgeNote}`);
      }
    }
    const effectiveDifficulty = requested ? requested.difficulty : level;

    // Leave anything else first.
    for (const duel of this.duelsOf(sessionId)) {
      if (duel.status === "open") this.finish(duel, "cancelled", "left");
      if (duel.status === "active") throw new DuelError("You are already in a duel.", 409);
    }

    // Quick match: pair with the oldest compatible open challenge.
    const waiting = Object.values(this.state.duels)
      .filter((d) => d.status === "open" && d.creatorId !== sessionId && this.isOnline(d.creatorId))
      .filter((d) => d.difficulty === effectiveDifficulty && d.judging === mode)
      .filter((d) => !(d.requestedSlug && requested && d.requestedSlug !== requested.titleSlug))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (waiting.length) {
      const preferred = waiting[0].requestedSlug || (requested ? requested.titleSlug : null);
      return this.acceptChallenge({ sessionId, name: user.name, duelId: waiting[0].id, preferredSlug: preferred });
    }

    const now = Date.now();
    const duel = {
      id: crypto.randomUUID(),
      status: "open",
      difficulty: effectiveDifficulty,
      judging: mode,
      creatorId: sessionId,
      creatorName: user.name,
      opponentId: null,
      opponentName: null,
      requestedSlug: requested ? requested.titleSlug : null,
      requestedId: requested ? requested.id : null,
      requestedTitle: requested ? requested.title : null,
      problemSlug: null,
      problemId: null,
      problemTitle: null,
      problemHistory: [],
      vetoCreator: 0,
      vetoOpponent: 0,
      rerolls: 0,
      stats: {},
      winnerId: null,
      winnerName: null,
      endReason: null,
      rematch: {},
      rematchDuelId: null,
      dismissed: {},
      createdAt: now,
      startedAt: 0,
      endedAt: 0,
      updatedAt: now,
    };
    this.state.duels[duel.id] = duel;
    this.changed();
    return this.publicDuel(duel);
  }

  async acceptChallenge({ sessionId, name, duelId, preferredSlug = null }) {
    const user = this.touch(sessionId, name);
    const duel = this.get(duelId);
    if (duel.status !== "open") throw new DuelError("That challenge is no longer available.", 409);
    if (duel.creatorId === sessionId) throw new DuelError("You cannot accept your own challenge.", 409);
    if (duel.judging === "leetcode" && !this.isLinked(sessionId)) {
      throw new DuelError("That duel is judged on LeetCode submissions; link your LeetCode account first.", 403);
    }
    for (const other of this.duelsOf(sessionId)) {
      if (other.status === "open") this.finish(other, "cancelled", "left");
      if (other.status === "active") throw new DuelError("You are already in a duel.", 409);
    }

    duel.status = "starting";
    duel.opponentId = sessionId;
    duel.opponentName = user.name;
    duel.updatedAt = Date.now();
    this.changed();

    let problem;
    try {
      const slug = preferredSlug || duel.requestedSlug;
      problem = slug ? await getProblem(slug) : await this.pickProblem(duel);
    } catch (error) {
      if (this.state.duels[duel.id] && duel.status === "starting") {
        duel.status = "open";
        duel.opponentId = null;
        duel.opponentName = null;
        duel.updatedAt = Date.now();
        this.changed();
      }
      throw error instanceof LeetCodeError ? new DuelError(error.message, 502) : error;
    }
    if (duel.status !== "starting") throw new DuelError("That challenge is no longer available.", 409);
    this.startDuel(duel, problem);
    return this.publicDuel(duel);
  }

  async pickProblem(duel) {
    return randomProblem(duel.difficulty, {
      exclude: duel.problemHistory,
      requireJudgeable: duel.judging === "examples",
    });
  }

  startDuel(duel, problem) {
    const now = Date.now();
    duel.status = "active";
    duel.problemSlug = problem.titleSlug;
    duel.problemId = problem.id;
    duel.problemTitle = problem.title;
    duel.problemHistory = [...(duel.problemHistory || []), problem.titleSlug];
    duel.vetoCreator = 0;
    duel.vetoOpponent = 0;
    duel.stats = {};
    duel.startedAt = now;
    duel.updatedAt = now;
    this.changed();
  }

  finish(duel, status, reason, winnerId = null) {
    if (duel.status === "complete" || duel.status === "cancelled") return;
    const now = Date.now();
    duel.status = status;
    duel.endReason = reason;
    duel.endedAt = now;
    duel.updatedAt = now;
    if (winnerId) {
      duel.winnerId = winnerId;
      duel.winnerName = winnerId === duel.creatorId ? duel.creatorName : duel.opponentName;
    }
    this.changed();
  }

  leave({ sessionId, duelId, forfeit = false }) {
    this.touch(sessionId);
    const duel = duelId ? this.state.duels[duelId] : this.currentDuel(sessionId);
    if (!duel) return null;
    const isPlayer = duel.creatorId === sessionId || duel.opponentId === sessionId;
    if (!isPlayer) throw new DuelError("You are not in this duel.", 403);
    if (duel.status === "open" || duel.status === "starting") {
      this.finish(duel, "cancelled", "left");
    } else if (duel.status === "active") {
      if (!forfeit) throw new DuelError("Leaving an active duel forfeits it.", 409);
      const other = duel.creatorId === sessionId ? duel.opponentId : duel.creatorId;
      this.finish(duel, "complete", "forfeit", other);
    }
    duel.dismissed ||= {};
    duel.dismissed[sessionId] = true;
    duel.updatedAt = Date.now();
    this.changed();
    return null;
  }

  async veto({ sessionId, duelId }) {
    this.touch(sessionId);
    const duel = this.get(duelId);
    if (duel.status !== "active") throw new DuelError("The duel is not active.", 409);
    const isCreator = duel.creatorId === sessionId;
    if (!isCreator && duel.opponentId !== sessionId) throw new DuelError("You are not in this duel.", 403);
    if ((duel.rerolls || 0) >= MAX_REROLLS) throw new DuelError("No more vetoes for this duel.", 409);
    if (isCreator) duel.vetoCreator = 1;
    else duel.vetoOpponent = 1;
    duel.updatedAt = Date.now();
    this.changed();

    if (duel.vetoCreator && duel.vetoOpponent) {
      const previous = duel.problemSlug;
      let problem;
      try {
        problem = await this.pickProblem(duel);
      } catch (error) {
        duel.vetoCreator = 0;
        duel.vetoOpponent = 0;
        this.changed();
        throw error instanceof LeetCodeError ? new DuelError(error.message, 502) : error;
      }
      if (duel.status === "active" && duel.problemSlug === previous) {
        duel.rerolls = (duel.rerolls || 0) + 1;
        this.startDuel(duel, problem);
      }
    }
    return this.publicDuel(duel);
  }

  // Called after a submission was judged (examples or LeetCode).
  recordSubmission({ sessionId, duelId, verdict }) {
    this.touch(sessionId);
    const duel = duelId ? this.state.duels[duelId] : null;
    if (!duel) return null;
    if (duel.creatorId !== sessionId && duel.opponentId !== sessionId) throw new DuelError("You are not in this duel.", 403);
    if (duel.status !== "active") return this.publicDuel(duel);
    if (duel.problemSlug !== verdict.slug) throw new DuelError("That submission is for a different problem.", 409);

    duel.stats ||= {};
    const stats = (duel.stats[sessionId] ||= { attempts: 0, bestPassed: 0, total: 0, lastVerdict: "", lastAt: 0 });
    stats.attempts += 1;
    stats.total = verdict.total || stats.total;
    stats.bestPassed = Math.max(stats.bestPassed, verdict.passed || 0);
    stats.lastVerdict = verdict.verdict || "";
    stats.lastAt = Date.now();
    duel.updatedAt = Date.now();
    if (verdict.accepted) {
      duel.solvedMs = Date.now() - duel.startedAt;
      this.finish(duel, "complete", "solved", sessionId);
    } else {
      this.changed();
    }
    return this.publicDuel(duel);
  }

  async rematch({ sessionId, duelId }) {
    this.touch(sessionId);
    const duel = this.get(duelId);
    if (duel.status !== "complete") throw new DuelError("The duel is not over yet.", 409);
    if (duel.creatorId !== sessionId && duel.opponentId !== sessionId) throw new DuelError("You are not in this duel.", 403);
    if (duel.rematchDuelId) return this.publicDuel(this.state.duels[duel.rematchDuelId] || duel);
    const other = duel.creatorId === sessionId ? duel.opponentId : duel.creatorId;
    if (!other || !this.isOnline(other) || (duel.dismissed && duel.dismissed[other])) {
      throw new DuelError("Your opponent has left.", 409);
    }
    duel.rematch ||= {};
    duel.rematch[sessionId] = true;
    duel.updatedAt = Date.now();
    this.changed();
    if (!duel.rematch[other]) return this.publicDuel(duel);

    // Both agreed: spin up a fresh duel between the same two players.
    const now = Date.now();
    const next = {
      ...duel,
      id: crypto.randomUUID(),
      status: "starting",
      requestedSlug: null,
      requestedId: null,
      requestedTitle: null,
      problemSlug: null,
      problemId: null,
      problemTitle: null,
      problemHistory: [...(duel.problemHistory || [])],
      vetoCreator: 0,
      vetoOpponent: 0,
      rerolls: 0,
      stats: {},
      winnerId: null,
      winnerName: null,
      endReason: null,
      rematch: {},
      rematchDuelId: null,
      dismissed: {},
      solvedMs: 0,
      createdAt: now,
      startedAt: 0,
      endedAt: 0,
      updatedAt: now,
    };
    this.state.duels[next.id] = next;
    duel.rematchDuelId = next.id;
    this.changed();
    try {
      const problem = await this.pickProblem(next);
      this.startDuel(next, problem);
    } catch (error) {
      delete this.state.duels[next.id];
      duel.rematchDuelId = null;
      duel.rematch = {};
      this.changed();
      throw error instanceof LeetCodeError ? new DuelError(error.message, 502) : error;
    }
    return this.publicDuel(next);
  }

  // ------------------------------------------------------------------ cleanup

  cleanup() {
    const now = Date.now();
    const justBooted = now - this.bootedAt < 60 * 1000; // let clients reconnect after a restart
    let dirty = false;
    for (const duel of Object.values(this.state.duels)) {
      if (duel.status === "open") {
        const creatorSeen = Math.max(this.lastSeen.get(duel.creatorId) || 0, duel.updatedAt || 0);
        const creatorGone = !justBooted && !this.connections.has(duel.creatorId) && now - creatorSeen > OPEN_OFFLINE_GRACE;
        if (now - duel.createdAt > OPEN_MAX_AGE || creatorGone) {
          this.finish(duel, "cancelled", creatorGone ? "left" : "expired");
          dirty = true;
        }
      } else if (duel.status === "starting") {
        if (now - duel.updatedAt > STARTING_MAX_AGE) {
          duel.status = "open";
          duel.opponentId = null;
          duel.opponentName = null;
          duel.updatedAt = now;
          dirty = true;
        }
      } else if (duel.status === "active") {
        const bothGone = !justBooted && !this.isOnline(duel.creatorId) && !this.isOnline(duel.opponentId);
        const lastSeen = Math.max(
          this.lastSeen.get(duel.creatorId) || 0,
          this.lastSeen.get(duel.opponentId) || 0,
          duel.updatedAt || 0,
        );
        if (now - duel.startedAt > ACTIVE_MAX_AGE || (bothGone && now - lastSeen > ACTIVE_BOTH_OFFLINE)) {
          this.finish(duel, "complete", "expired");
          dirty = true;
        }
      } else if (now - (duel.endedAt || duel.updatedAt) > FINISHED_RETENTION) {
        delete this.state.duels[duel.id];
        this.liveCode.delete(duel.id);
        dirty = true;
      }
    }
    for (const [id, user] of Object.entries(this.state.users)) {
      if (!user.leetcode && now - (user.lastSeen || user.createdAt || 0) > USER_RETENTION) {
        delete this.state.users[id];
        dirty = true;
      }
    }
    for (const [id, seen] of this.lastSeen) if (now - seen > 24 * 60 * 60 * 1000) this.lastSeen.delete(id);
    if (dirty) this.changed();
  }
}