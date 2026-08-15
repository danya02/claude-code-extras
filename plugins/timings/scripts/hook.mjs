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
  // Past this, a tool call is worth pinning to the wall clock: "took 4m" is
  // hard to line up with anything, "12:30:00->12:34:00" is not.
  clockPairMs: num("CLOCK_PAIR_SECONDS", 60) * 1000,
  // Past this, an interrupt would lose real output, so the call should have
  // been writing to a log.
  scratchpadHintMs: num("SCRATCHPAD_HINT_SECONDS", 45) * 1000,
  sessionGapMs: num("SESSION_GAP_SECONDS", 600) * 1000,
  showClock: bool("SHOW_CLOCK", true),
  visibleIdle: bool("VISIBLE_IDLE", true),
  showHookOverhead: bool("SHOW_HOOK_OVERHEAD", false),
  eventLog: bool("EVENT_LOG", true),
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

    // Every event is logged before it is dispatched, including events this
    // plugin has no handler for. Which events a given build actually fires is
    // not something the docs settle -- the log is how you find out, and it is
    // what `events` in the MCP-less debug story reads back.
    logEvent(dir, event, now);

    switch (event.hook_event_name) {
      case "SessionStart": return onSessionStart(dir, event, now);
      case "SessionEnd": return onSessionEnd(dir);
      case "UserPromptSubmit": return onUserPromptSubmit(dir, now);
      case "Stop": return onStop(dir, now);
      case "PreCompact": return onPreCompact(dir, now);
      case "PermissionRequest": return onPermissionRequest(dir, event, now);
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

function onSessionStart(dir, event, now) {
  mkdirSync(join(dir, "tools"), { recursive: true });
  const state = readState(dir);
  writeState(dir, { ...state, sessionStartAt: state.sessionStartAt ?? now, source: event.source ?? null });
  sweepStaleSessions(now);

  // A resumed or forked session is the case where my sense of time is worst:
  // the transcript reads as if it happened just now, and the repo may have
  // moved on for days. A plain startup with no prior state has nothing to say.
  const source = event.source ?? "startup";
  const gapMs = state.updatedAt ? now - state.updatedAt : null;
  if (source === "startup" && gapMs === null) return;
  if (gapMs !== null && gapMs < config.sessionGapMs && source === "startup") return;

  const parts = [`source=${source}`];
  if (gapMs !== null && gapMs >= config.sessionGapMs) parts.push(`idle for ${fmt(gapMs)}, last active ${stamp(state.updatedAt, now)}`);
  emit({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `<timing-session>${parts.join(" ")}</timing-session>` },
  });
}

// Compaction itself is fast; what matters is how long the compacted context
// then sat unattended, which is only known at the next prompt. So this records
// the moment and onUserPromptSubmit reports the gap.
function onPreCompact(dir, now) {
  const state = readState(dir);
  writeState(dir, { ...state, compactedAt: now });
}

// PermissionRequest carries the tool_use_id, so approval wait can be attributed
// to the exact call rather than guessed from a time window. Without this, a
// tool that waited three minutes for approval reports as a three-minute tool.
function onPermissionRequest(dir, event, now) {
  const id = safeId(event.tool_use_id);
  if (!id) return;
  const path = join(dir, "tools", `${id}.json`);
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...stamp, askedAt: now }));
  } catch {
    // No stamp yet, or it is already consumed: approval time is simply unknown.
  }
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

  // Stamps with no PostToolUse are calls that never finished. By prompt time
  // nothing is still in flight, so an orphan means the call was interrupted.
  const orphans = takeOrphans(dir, now);
  const interrupted = orphans.length > 0;

  const parts = [];
  if (config.showClock) parts.push(`now=${clock(now)}`);
  // The date is noise on every prompt and essential across a midnight or an
  // overnight gap, so it appears only when the day is not the one last seen.
  const today = dayOf(now);
  if (config.showClock && state.lastDay !== today) parts.push(`date=${today}`);

  // Idle is measured from the last Stop -- but an interrupted turn never
  // reaches Stop, so that gap would span my own working time and read as the
  // user being away. Better to say nothing than to say the opposite.
  const idleMs = state.lastStopAt ? now - state.lastStopAt : null;
  const idleKnown = idleMs !== null && !interrupted;
  if (idleKnown && idleMs >= config.idleThresholdMs) {
    parts.push(`idle=${fmt(idleMs)}`);
  }

  if (previous && previous.durationMs !== null && previous.durationMs >= config.turnThresholdMs) {
    parts.push(`prev_turn=${describeTurn(previous)}`);
  } else if (interrupted && previous && previous.toolMs) {
    // The turn has no duration (no Stop), but its tool time is still the best
    // evidence of how much work was thrown away.
    parts.push(`prev_turn=interrupted (${describeTools(previous)})`);
  }

  const blocks = [];
  if (parts.length) blocks.push(`<timing-prompt>${parts.join(" ")}</timing-prompt>`);
  for (const orphan of orphans) blocks.push(`<timing-interrupt>${describeInterrupt(orphan, now)}</timing-interrupt>`);
  if (state.compactedAt) blocks.push(`<timing-compaction>compacted ${fmt(now - state.compactedAt)} ago, at ${stamp(state.compactedAt, now)}</timing-compaction>`);

  writeState(dir, {
    ...state,
    turnStartAt: now,
    lastTurn: null,
    lastPromptAt: now,
    lastDay: today,
    compactedAt: null,
  });

  if (!blocks.length) return;

  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: blocks.join("\n"),
    },
  };

  if (config.visibleIdle && idleKnown && idleMs >= config.idleThresholdMs) {
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

  // Time spent waiting for the user to approve is not time the tool ran, and
  // counting it as such is how a `cat` reports as a 40-second command.
  const approvalMs = Number.isFinite(stamp.askedAt) ? Math.max(0, stamp.askedAt - stamp.at) : 0;
  const ranMs = Math.max(0, elapsedMs - approvalMs);

  appendTurnLog(dir, { t: "tool", name, ms: ranMs, waitMs: approvalMs, failed });
  recordHookCost(dir);

  if (ranMs < config.toolThresholdMs) return;

  const detail = [];
  if (ranMs >= config.clockPairMs) detail.push(`${clock(now - ranMs)}→${clock(now)}`);
  if (approvalMs >= 1000) detail.push(`plus ${fmt(approvalMs)} waiting for approval`);

  let text = `${name} ${failed ? "ran for" : "took"} ${fmt(ranMs)}`;
  if (detail.length) text += ` (${detail.join(", ")})`;

  // A call this long has real output to lose, and an interrupt loses all of it:
  // the harness hands back a rejection, never the partial stdout.
  if (ranMs >= config.scratchpadHintMs && name === "Bash") {
    text += ". Next time a command runs this long, tee it to a scratchpad log or run it in the background, so an interrupt does not throw the output away";
  }

  emit({
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: `<timing-tool>${text}.</timing-tool>`,
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
  let waitMs = 0;
  for (const entry of entries) {
    const current = byTool.get(entry.name) ?? { ms: 0, calls: 0 };
    current.ms += entry.ms;
    current.calls += 1;
    byTool.set(entry.name, current);
    toolMs += entry.ms;
    waitMs += entry.waitMs ?? 0;
  }

  return {
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    toolMs,
    waitMs,
    hookMs,
    hookCount,
    tools: [...byTool.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 4),
  };
}

function describeTools(turn) {
  const tools = turn.tools
    .map((t) => `${t.name}${t.calls > 1 ? `×${t.calls}` : ""} ${fmt(t.ms)}`)
    .join(", ");
  // Parallel calls make the tool total exceed wall time, so it is reported as
  // busy time rather than subtracted blindly.
  return `tools ${fmt(turn.toolMs)}: ${tools}`;
}

function describeTurn(turn) {
  const detail = [];

  if (turn.tools.length) detail.push(describeTools(turn));
  if (turn.waitMs >= 1000) detail.push(`your approvals ${fmt(turn.waitMs)}`);

  const modelMs = turn.durationMs - turn.toolMs - turn.waitMs;
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

// Stamps left behind at prompt time: nothing is in flight then, so each one is
// a call that was interrupted. The span is deliberately described as a bound --
// it runs from PreToolUse, which fires *before* the permission prompt, to the
// moment the user's next message arrives, so it also contains any approval wait
// and the time they spent typing. Presenting it as "how long they waited" would
// be wrong, and it is precisely the number I would otherwise reason from.
function takeOrphans(dir, now) {
  const toolsDir = join(dir, "tools");
  const orphans = [];
  try {
    for (const name of readdirSync(toolsDir)) {
      const path = join(toolsDir, name);
      try {
        const stamp = JSON.parse(readFileSync(path, "utf8"));
        rmSync(path, { force: true });
        if (Number.isFinite(stamp.at) && now - stamp.at < STALE_STAMP_MS) orphans.push(stamp);
      } catch {
        // Unreadable or already gone; nothing to report.
      }
    }
  } catch {
    // No tools directory yet.
  }
  return orphans.sort((a, b) => a.at - b.at);
}

function describeInterrupt(stamp, now) {
  const name = stamp.name ?? "tool";
  const spanMs = now - stamp.at;
  // Approval time is known when PermissionRequest fired, so it can be taken
  // out of the bound rather than left to inflate it.
  const from = Number.isFinite(stamp.askedAt) ? stamp.askedAt : stamp.at;
  const bound = fmt(now - from);
  return (
    `${name} was started ${fmt(spanMs)} before this message and never finished, so it was interrupted. ` +
    `At most ${bound} of that was the call running -- the span also covers your typing` +
    (Number.isFinite(stamp.askedAt) ? "" : " and any wait for approval") +
    `, so treat it as an upper bound, not a measurement`
  );
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

// Local clock only. A full ISO datetime on every prompt is a field that never
// changes a decision, and one that is skimmed teaches the whole block to be
// skimmed. The date is emitted separately, only when the day turns over.
function clock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dayOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A past instant: the clock alone if it was today, with the date if it was not.
// The overnight case is the whole reason these fields exist.
function stamp(ms, now) {
  return dayOf(ms) === dayOf(now) ? clock(ms) : `${clock(ms)} on ${dayOf(ms)}`;
}

// One line per hook event, whatever it is. This is the plugin's own instrument:
// which events a build fires, in what order, and how far apart, is not
// something the documentation settles.
function logEvent(dir, event, now) {
  if (!config.eventLog) return;
  try {
    mkdirSync(dir, { recursive: true });
    const record = { at: now, clock: clock(now), ev: event.hook_event_name ?? "?" };
    for (const [key, field] of [["tool", "tool_name"], ["id", "tool_use_id"], ["src", "source"], ["type", "notification_type"], ["agent", "agent_type"]]) {
      if (event[field] !== undefined) record[key] = event[field];
    }
    appendFileSync(join(dir, "events.ndjson"), `${JSON.stringify(record)}\n`);
  } catch (err) {
    logError("logEvent", err);
  }
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
