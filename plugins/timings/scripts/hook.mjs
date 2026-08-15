#!/usr/bin/env node
// Single entry point for every hook event this plugin registers. Claude Code
// runs one process per event, so the dispatch below is cheaper than eight
// scripts sharing code through a module -- there is nothing to import.
//
// Two rules hold everywhere in this file:
//   1. Never block. Any failure exits 0 with no output; a timing plugin that
//      can break the session is worse than no timing plugin.
//   2. Never do a read-modify-write on state that concurrent hooks also touch.
//      Parallel tool calls mean PreToolUse/PostToolUse can overlap, so those
//      events use one file per tool_use_id plus an append-only log.

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE_VERSION = 1;
const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000; // session dirs swept at SessionStart
const STALE_STAMP_MS = 6 * 60 * 60 * 1000; // tool stamps whose PostToolUse never came

const dataDir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "claude-code-timings");
const sessionsDir = join(dataDir, "sessions");

const config = {
  toolThresholdMs: num("TOOL_THRESHOLD_SECONDS", 10) * 1000,
  idleThresholdMs: num("IDLE_THRESHOLD_SECONDS", 10) * 1000,
  turnThresholdMs: num("TURN_THRESHOLD_SECONDS", 20) * 1000,
  showClock: bool("SHOW_CLOCK", true),
  visibleIdle: bool("VISIBLE_IDLE", true),
  showHookOverhead: bool("SHOW_HOOK_OVERHEAD", false),
  debugLog: bool("DEBUG_LOG", false),
};

function num(key, fallback) {
  const raw = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  const parsed = Number(raw);
  return raw === undefined || raw === "" || !Number.isFinite(parsed) || parsed < 0 ? fallback : parsed;
}

function bool(key, fallback) {
  const raw = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  if (raw === undefined || raw === "") return fallback;
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

main();

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return; // no stdin, or not JSON: nothing to time
  }

  try {
    const sessionId = safeId(event.session_id) || "unknown";
    const dir = join(sessionsDir, sessionId);
    const now = Date.now();

    switch (event.hook_event_name) {
      case "SessionStart": return onSessionStart(dir, now);
      case "SessionEnd": return onSessionEnd(dir);
      case "UserPromptSubmit": return onUserPromptSubmit(dir, now);
      case "Stop": return onStop(dir, now);
      case "PreToolUse": return onPreToolUse(dir, event, now);
      case "PostToolUse":
      case "PostToolUseFailure": return onPostToolUse(dir, event, now);
      case "PermissionDenied": return dropStamp(dir, event);
      default: return;
    }
  } catch (err) {
    logError(event.hook_event_name, err);
  }
}

/* ------------------------------------------------------------------ events */

function onSessionStart(dir, now) {
  mkdirSync(join(dir, "tools"), { recursive: true });
  const state = readState(dir);
  writeState(dir, { ...state, sessionStartAt: state.sessionStartAt ?? now });
  sweepStaleSessions(now);
}

function onSessionEnd(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function onUserPromptSubmit(dir, now) {
  const state = readState(dir);

  // The previous turn's totals were computed at Stop. Drain anything still in
  // the log too: a turn that ended without a Stop (interrupted, or ended on a
  // tool error) would otherwise carry its tool time into the next turn.
  const leftover = drainTurnLog(dir);
  const previous = state.lastTurn ?? (leftover.entries.length ? summarize(leftover, null) : null);

  const parts = [];
  if (config.showClock) parts.push(`now=${localTimestamp(now)}`);

  const idleMs = state.lastStopAt ? now - state.lastStopAt : null;
  if (idleMs !== null && idleMs >= config.idleThresholdMs) {
    parts.push(`idle=${fmt(idleMs)}`);
  }

  if (previous && previous.durationMs !== null && previous.durationMs >= config.turnThresholdMs) {
    parts.push(`prev_turn=${describeTurn(previous)}`);
  }

  writeState(dir, {
    ...state,
    turnStartAt: now,
    lastTurn: null,
    lastPromptAt: now,
  });

  if (!parts.length) return;

  const context = `<timing>${parts.join(" ")}</timing>`;
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };

  if (config.visibleIdle && idleMs !== null && idleMs >= config.idleThresholdMs) {
    output.systemMessage = `[after ${fmt(idleMs)}]`;
  }

  emit(output);
}

function onStop(dir, now) {
  const state = readState(dir);
  const turnStartAt = state.turnStartAt ?? null;

  const drained = drainTurnLog(dir);
  const lastTurn = summarize(drained, turnStartAt === null ? null : now - turnStartAt);

  writeState(dir, {
    ...state,
    turnStartAt: null, // a second Stop without an intervening prompt times nothing
    lastStopAt: now,
    lastTurn,
  });

  sweepStaleStamps(dir, now);
}

function onPreToolUse(dir, event, now) {
  const id = safeId(event.tool_use_id);
  if (!id) return; // nothing to correlate the PostToolUse against
  const toolsDir = join(dir, "tools");
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, `${id}.json`), JSON.stringify({ name: event.tool_name ?? "tool", at: now }));
  recordHookCost(dir);
}

function onPostToolUse(dir, event, now) {
  const stamp = dropStamp(dir, event);
  if (!stamp) return; // PreToolUse never ran, or another hook already consumed it

  const elapsedMs = now - stamp.at;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;

  const name = event.tool_name ?? stamp.name ?? "tool";
  const failed = event.hook_event_name === "PostToolUseFailure";
  appendTurnLog(dir, { t: "tool", name, ms: elapsedMs, failed });
  recordHookCost(dir);

  if (elapsedMs < config.toolThresholdMs) return;

  emit({
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: `<timing>${name} ${failed ? "ran for" : "took"} ${fmt(elapsedMs)}.</timing>`,
    },
  });
}

/* ------------------------------------------------------------- turn totals */

// One append-only line per completed tool call. Appends of this size are atomic
// on the platforms Claude Code runs on, so parallel tool calls cannot clobber
// each other the way a shared JSON object would.
function appendTurnLog(dir, entry) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "turn.ndjson"), `${JSON.stringify(entry)}\n`);
  } catch (err) {
    logError("appendTurnLog", err);
  }
}

function drainTurnLog(dir) {
  const path = join(dir, "turn.ndjson");
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
    rmSync(path, { force: true });
  } catch {
    return { entries: [], hookMs: 0, hookCount: 0 };
  }

  const entries = [];
  let hookMs = 0;
  let hookCount = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.t === "hook") {
        hookMs += entry.ms ?? 0;
        hookCount += 1;
      } else if (entry.t === "tool" && Number.isFinite(entry.ms)) {
        entries.push(entry);
      }
    } catch {
      // A torn line means one lost measurement, not a lost turn.
    }
  }
  return { entries, hookMs, hookCount };
}

function summarize({ entries, hookMs, hookCount }, durationMs) {
  const byTool = new Map();
  let toolMs = 0;
  for (const entry of entries) {
    const current = byTool.get(entry.name) ?? { ms: 0, calls: 0 };
    current.ms += entry.ms;
    current.calls += 1;
    byTool.set(entry.name, current);
    toolMs += entry.ms;
  }

  return {
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    toolMs,
    hookMs,
    hookCount,
    tools: [...byTool.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 4),
  };
}

function describeTurn(turn) {
  const detail = [];

  if (turn.tools.length) {
    const tools = turn.tools
      .map((t) => `${t.name}${t.calls > 1 ? `×${t.calls}` : ""} ${fmt(t.ms)}`)
      .join(", ");
    // Parallel calls make the tool total exceed wall time, so it is reported as
    // busy time rather than subtracted blindly below.
    detail.push(`tools ${fmt(turn.toolMs)}: ${tools}`);
  }

  const modelMs = turn.durationMs - turn.toolMs;
  if (modelMs >= 1000) detail.push(`model ~${fmt(modelMs)}`);

  if (config.showHookOverhead && turn.hookCount) {
    detail.push(`timing hooks ${fmt(turn.hookMs)} over ${turn.hookCount} calls`);
  }

  return detail.length ? `${fmt(turn.durationMs)} (${detail.join("; ")})` : fmt(turn.durationMs);
}

// Wall time this process has been alive, which is what the turn actually paid:
// node's startup dominates the hook's own work. Logged before exit, so it
// misses only the final flush.
function recordHookCost(dir) {
  if (!config.showHookOverhead) return;
  appendTurnLog(dir, { t: "hook", ms: Math.round(process.uptime() * 1000) });
}

/* ------------------------------------------------------------------- state */

function readState(dir) {
  try {
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    return state.v === STATE_VERSION ? state : { v: STATE_VERSION };
  } catch {
    return { v: STATE_VERSION };
  }
}

// Only SessionStart, UserPromptSubmit and Stop write this, and those never
// overlap, so the rename is for crash-safety rather than concurrency.
function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `state.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ ...state, v: STATE_VERSION, updatedAt: Date.now() }));
  renameSync(tmp, join(dir, "state.json"));
}

function dropStamp(dir, event) {
  const id = safeId(event.tool_use_id);
  if (!id) return null;
  const path = join(dir, "tools", `${id}.json`);
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path, { force: true });
    return Number.isFinite(stamp.at) ? stamp : null;
  } catch {
    return null;
  }
}

// A tool call that is denied, interrupted or times out may leave its stamp
// behind. Cheap to sweep at Stop, and bounded by one turn's worth of calls.
function sweepStaleStamps(dir, now) {
  sweepDir(join(dir, "tools"), now, STALE_STAMP_MS, false);
}

function sweepStaleSessions(now) {
  sweepDir(sessionsDir, now, STALE_SESSION_MS, true);
}

function sweepDir(dir, now, maxAgeMs, recursive) {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { recursive, force: true });
      } catch {
        // Raced with another process removing it; nothing to do.
      }
    }
  } catch {
    // Directory does not exist yet.
  }
}

/* ------------------------------------------------------------------- utils */

// Session and tool-use ids come from the harness, but they are interpolated
// into a path, so anything that is not plainly id-shaped is rejected.
function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function fmt(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

// Local time with offset, so Claude can reason about the user's day rather than
// just about intervals.
function localTimestamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

function emit(output) {
  process.stdout.write(JSON.stringify(output));
}

function logError(event, err) {
  if (!config.debugLog) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(
      join(dataDir, "errors.ndjson"),
      `${JSON.stringify({ at: new Date().toISOString(), event, error: String(err?.stack ?? err) })}\n`,
    );
  } catch {
    // Logging must never be the thing that breaks a hook.
  }
}
