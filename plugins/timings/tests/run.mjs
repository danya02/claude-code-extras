#!/usr/bin/env node
// End-to-end test: drives scripts/hook.mjs the way Claude Code does -- one
// process per event, JSON on stdin -- against a throwaway data directory.
// Run with `node plugins/timings/tests/run.mjs`. No dependencies, no network.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "hook.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "timings-test-"));

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

// `sleepMs` fakes elapsed time between a Pre and Post hook without the test
// actually waiting: the script reads the clock, so we shift it via faketime-free
// means -- a real sleep, kept to a few hundred ms.
function run(event, { env = {}, sleepMs = 0 } = {}) {
  if (sleepMs) spawnSync(process.execPath, ["-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${sleepMs})`]);
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, ...env },
  });
  check(`exit 0 for ${event.hook_event_name}`, result.status === 0, `status=${result.status} stderr=${result.stderr}`);
  let json = null;
  if (result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      check(`valid JSON from ${event.hook_event_name}`, false, result.stdout);
    }
  }
  return { json, stdout: result.stdout, elapsedMs: result.status === 0 ? 0 : 0 };
}

const S = { session_id: "test-session-1" };
const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";

console.log("timings plugin");

// --- a full turn: prompt -> slow tool -> fast tool -> stop -> next prompt ---
console.log("\n  full turn");
run({ ...S, hook_event_name: "SessionStart" });
const first = run({ ...S, hook_event_name: "UserPromptSubmit", user_input: "hi" });
check("first prompt carries clock time only", /<timing-prompt>now=\d{2}:\d{2}:\d{2}/.test(ctx(first)), ctx(first));
check("no ISO datetime is injected", !/\d{4}-\d{2}-\d{2}T/.test(ctx(first)), ctx(first));
check("the first prompt of a session carries the date", /date=\d{4}-\d{2}-\d{2}/.test(ctx(first)), ctx(first));
check("first prompt has no idle (no prior Stop)", !ctx(first).includes("idle="), ctx(first));

const sameDay = run({ ...S, hook_event_name: "UserPromptSubmit" });
check("the date is not repeated within the same day", !ctx(sameDay).includes("date="), ctx(sameDay));

run({ ...S, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_slow" });
const slow = run(
  { ...S, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_slow" },
  { sleepMs: 1200, env: { CLAUDE_PLUGIN_OPTION_TOOL_THRESHOLD_SECONDS: "1" } },
);
check("slow tool is reported", /<timing-tool>Bash took \d+s\.<\/timing-tool>/.test(ctx(slow)), ctx(slow));

run({ ...S, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_fast" });
const fast = run({ ...S, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_fast" });
check("fast tool stays silent (below threshold)", fast.stdout.trim() === "", fast.stdout);

run({ ...S, hook_event_name: "Stop", last_assistant_message: "done" });
const second = run({ ...S, hook_event_name: "UserPromptSubmit", user_input: "next" }, {
  sleepMs: 1100,
  env: { CLAUDE_PLUGIN_OPTION_IDLE_THRESHOLD_SECONDS: "1", CLAUDE_PLUGIN_OPTION_TURN_THRESHOLD_SECONDS: "1" },
});
check("idle gap reported", /idle=\d+s/.test(ctx(second)), ctx(second));
check("previous turn reported", /prev_turn=\d+s/.test(ctx(second)), ctx(second));
check("turn breakdown names the tools", /tools \d+s: Bash \d+s/.test(ctx(second)), ctx(second));
check("idle also shown to the user", /^\[after \d+s\]$/.test(second.json?.systemMessage ?? ""), second.json?.systemMessage);

// --- the leak your bash version swept for: Post never fires ---
console.log("\n  orphaned stamps");
run({ ...S, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_denied" });
run({ ...S, hook_event_name: "PermissionDenied", tool_name: "Bash", tool_use_id: "toolu_denied" });
const stamps = readdirSync(join(dataDir, "sessions", S.session_id, "tools"));
check("denied tool leaves no stamp behind", stamps.length === 0, stamps.join(", "));

const failed = run({ ...S, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_err" }) && run(
  { ...S, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu_err" },
  { sleepMs: 1200, env: { CLAUDE_PLUGIN_OPTION_TOOL_THRESHOLD_SECONDS: "1" } },
);
check("failed tool is still timed", /Bash ran for \d+s/.test(ctx(failed)), ctx(failed));

// --- a permission-gated call: the Write to /tmp that reported as 1m42s ---
// PermissionRequest lands with PreToolUse and says nothing about the user;
// Notification/permission_prompt is when the prompt actually reached them.
console.log("\n  permission-gated calls");
run({ ...S, hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "toolu_gated" });
run({ ...S, hook_event_name: "PermissionRequest", tool_name: "Write" });
run({ ...S, hook_event_name: "Notification", notification_type: "permission_prompt" }, { sleepMs: 1200 });
const gated = run({ ...S, hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "toolu_gated" }, { sleepMs: 1100 });
check("a gated call is reported even when short", ctx(gated).includes("<timing-tool>"), ctx(gated));
check("it is not presented as tool time", !/^<timing-tool>Write took/.test(ctx(gated)), ctx(gated));
check("the approval gate is named", /gated on the user's approval/.test(ctx(gated)), ctx(gated));
check("the wait before the prompt is given", /\d+s before the prompt reached the user/.test(ctx(gated)), ctx(gated));
check("the run is bounded, not measured", /ran at most \d+s/.test(ctx(gated)), ctx(gated));
check("no scratchpad hint on a gated call", !ctx(gated).includes("tee it to a scratchpad"), ctx(gated));

// An unrelated notification must not turn an ordinary call into a gated one.
run({ ...S, hook_event_name: "Stop" });
run({ ...S, hook_event_name: "UserPromptSubmit" });
run({ ...S, hook_event_name: "Notification", notification_type: "idle_prompt" });
run({ ...S, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_ungated" });
const ungated = run(
  { ...S, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_ungated" },
  { sleepMs: 1200, env: { CLAUDE_PLUGIN_OPTION_TOOL_THRESHOLD_SECONDS: "1" } },
);
check("a non-permission notification is ignored", /Bash took \d+s\./.test(ctx(ungated)), ctx(ungated));

// --- an interrupted call: no Post, so the stamp is the only evidence ---
console.log("\n  interrupts");
run({ ...S, hook_event_name: "Stop" });
run({ ...S, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_killed" });
const afterKill = run({ ...S, hook_event_name: "UserPromptSubmit" }, { sleepMs: 1100 });
check("an interrupted call is reported", ctx(afterKill).includes("<timing-interrupt>"), ctx(afterKill));
check("the interrupted tool is named", /Bash was started \d+s before the user's next message/.test(ctx(afterKill)), ctx(afterKill));
check("the span is labelled a bound, not a measurement", /upper bound, not a measurement/.test(ctx(afterKill)), ctx(afterKill));
check("idle is suppressed after an interrupt", !ctx(afterKill).includes("idle="), ctx(afterKill));
const clearedStamps = readdirSync(join(dataDir, "sessions", S.session_id, "tools"));
check("the orphan stamp is consumed, not re-reported", clearedStamps.length === 0, clearedStamps.join(", "));
const quietAfter = run({ ...S, hook_event_name: "UserPromptSubmit" });
check("the interrupt is not reported twice", !ctx(quietAfter).includes("<timing-interrupt>"), ctx(quietAfter));

// --- compaction: the gap that matters is measured at the next prompt ---
console.log("\n  compaction");
run({ ...S, hook_event_name: "PreCompact" });
const afterCompact = run({ ...S, hook_event_name: "UserPromptSubmit" }, { sleepMs: 1100 });
check("the compaction gap is reported", /<timing-compaction>compacted \d+s ago, at \d{2}:\d{2}:\d{2}/.test(ctx(afterCompact)), ctx(afterCompact));
const afterCompact2 = run({ ...S, hook_event_name: "UserPromptSubmit" });
check("the compaction is reported once", !ctx(afterCompact2).includes("<timing-compaction>"), ctx(afterCompact2));

// --- session start: only worth saying something when time actually passed ---
console.log("\n  session start");
const resumed = run({ ...S, hook_event_name: "SessionStart", source: "resume" });
check("a resumed session says so", /<timing-session>source=resume/.test(ctx(resumed)), ctx(resumed));
const plainStart = run({ session_id: "test-session-fresh", hook_event_name: "SessionStart", source: "startup" });
check("a fresh startup stays silent", plainStart.stdout.trim() === "", plainStart.stdout);

// --- the event log: the plugin's own instrument ---
console.log("\n  event log");
const eventLog = readFileSync(join(dataDir, "sessions", S.session_id, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
run({ ...S, hook_event_name: "MessageDisplay" }); // no handler, must still be logged
const withUnhandled = readFileSync(join(dataDir, "sessions", S.session_id, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("every event is logged", eventLog.length > 20, `${eventLog.length} entries`);
check("events with no handler are logged too", withUnhandled.some((e) => e.ev === "MessageDisplay"), "MessageDisplay missing from the log");
check("log entries carry a clock reading", eventLog.every((e) => /^\d{2}:\d{2}:\d{2}$/.test(e.clock)), JSON.stringify(eventLog[0]));
check("tool events carry the tool name", eventLog.some((e) => e.ev === "PreToolUse" && e.tool === "Bash"), "no PreToolUse/Bash entry");

// --- turn totals must not bleed across turns ---
console.log("\n  turn isolation");
run({ ...S, hook_event_name: "Stop" });
run({ ...S, hook_event_name: "UserPromptSubmit" }, { env: { CLAUDE_PLUGIN_OPTION_TURN_THRESHOLD_SECONDS: "0" } });
run({ ...S, hook_event_name: "Stop" });
const third = run({ ...S, hook_event_name: "UserPromptSubmit" }, { env: { CLAUDE_PLUGIN_OPTION_TURN_THRESHOLD_SECONDS: "0" } });
check("a turn with no tools reports no tool breakdown", !ctx(third).includes("tools "), ctx(third));

// --- robustness: nothing here may produce a non-zero exit or stray output ---
console.log("\n  robustness");
const noStdin = spawnSync(process.execPath, [hook], { input: "", encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
check("empty stdin exits 0 silently", noStdin.status === 0 && noStdin.stdout === "", `${noStdin.status} ${noStdin.stdout}`);

const garbage = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
check("malformed stdin exits 0 silently", garbage.status === 0 && garbage.stdout === "", `${garbage.status} ${garbage.stdout}`);

run({ ...S, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_never_started" });
run({ hook_event_name: "UserPromptSubmit" }); // no session_id
run({ ...S, hook_event_name: "SomeFutureEvent" });
run({ ...S, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "../../etc/passwd" });
run({ hook_event_name: "PreToolUse", session_id: "../../..", tool_name: "Bash", tool_use_id: "toolu_x" });
const afterTraversal = readdirSync(join(dataDir, "sessions", S.session_id, "tools"));
check("path-shaped ids write nothing", afterTraversal.length === 0, afterTraversal.join(", "));
check("path-shaped ids escape nothing", readdirSync(join(dataDir, "sessions")).every((n) => /^[A-Za-z0-9_-]+$/.test(n)), readdirSync(join(dataDir, "sessions")).join(", "));

// --- config plumbing ---
console.log("\n  config");
const quiet = run({ ...S, hook_event_name: "UserPromptSubmit" }, {
  env: { CLAUDE_PLUGIN_OPTION_SHOW_CLOCK: "false", CLAUDE_PLUGIN_OPTION_IDLE_THRESHOLD_SECONDS: "3600", CLAUDE_PLUGIN_OPTION_TURN_THRESHOLD_SECONDS: "3600" },
});
check("everything disabled injects nothing", quiet.stdout.trim() === "", quiet.stdout);

const noIdleMsg = run({ ...S, hook_event_name: "Stop" }) && run({ ...S, hook_event_name: "UserPromptSubmit" }, {
  env: { CLAUDE_PLUGIN_OPTION_IDLE_THRESHOLD_SECONDS: "0", CLAUDE_PLUGIN_OPTION_VISIBLE_IDLE: "false" },
});
check("visible_idle=false keeps the transcript clean", noIdleMsg.json?.systemMessage === undefined, noIdleMsg.stdout);
check("...but Claude still gets the context", ctx(noIdleMsg).includes("idle="), ctx(noIdleMsg));

// --- overhead: the reason to trust this plugin is on all the time ---
console.log("\n  overhead");
const started = Date.now();
const N = 20;
for (let i = 0; i < N; i += 1) {
  run({ ...S, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `toolu_bench_${i}` });
  run({ ...S, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: `toolu_bench_${i}` });
}
const perInvocation = (Date.now() - started) / (N * 2);
console.log(`  ~${perInvocation.toFixed(0)}ms per hook invocation (${N * 2} runs, includes node startup)`);
check("hook invocation stays under 250ms", perInvocation < 250, `${perInvocation.toFixed(0)}ms`);

// --- cleanup ---
// Ctrl+C ends the session, but `claude --resume` brings it back -- so what
// survives SessionEnd is exactly what the resume gap is measured against.
run({ ...S, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_leftover" });
run({ ...S, hook_event_name: "SessionEnd" });
const sessionDir = join(dataDir, "sessions", S.session_id);
check("SessionEnd keeps the state a resume needs", existsSync(join(sessionDir, "state.json")));
check("SessionEnd keeps the event log", existsSync(join(sessionDir, "events.ndjson")));
check("SessionEnd drops turn-scoped scratch", !existsSync(join(sessionDir, "tools")) && !existsSync(join(sessionDir, "turn.ndjson")));

const resumed2 = run(
  { ...S, hook_event_name: "SessionStart", source: "resume" },
  { sleepMs: 1100, env: { CLAUDE_PLUGIN_OPTION_SESSION_GAP_SECONDS: "1" } },
);
check("a resumed session can still measure its gap", /source=resume idle for \d+s, last active \d{2}:\d{2}:\d{2}/.test(ctx(resumed2)), ctx(resumed2));

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${failures ? "FAILED" : "PASSED"}: ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
