#!/usr/bin/env node
// End-to-end test: drives scripts/hook.mjs the way Claude Code does -- one
// process per event, JSON on stdin -- against a throwaway data directory.
// Run with `node plugins/timings/tests/run.mjs`. No dependencies, no network.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
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
check("first prompt carries wall-clock time", /now=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(ctx(first)), ctx(first));
check("first prompt has no idle (no prior Stop)", !ctx(first).includes("idle="), ctx(first));

run({ ...S, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_slow" });
const slow = run(
  { ...S, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_slow" },
  { sleepMs: 1200, env: { CLAUDE_PLUGIN_OPTION_TOOL_THRESHOLD_SECONDS: "1" } },
);
check("slow tool is reported", /<timing>Bash took \d+s\.<\/timing>/.test(ctx(slow)), ctx(slow));

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
run({ ...S, hook_event_name: "SessionEnd" });
check("SessionEnd removes session state", !existsSync(join(dataDir, "sessions", S.session_id)));

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${failures ? "FAILED" : "PASSED"}: ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
