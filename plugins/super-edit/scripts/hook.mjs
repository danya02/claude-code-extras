#!/usr/bin/env node
// PreToolUse on Bash: notice a command that edits a project file in place and
// nudge toward Edit / super_edit.
//
// Deliberately non-blocking. Detection is heuristic and cannot be exhaustive --
// the transcripts show sed -i, perl -pi, python write_text, node writeFileSync,
// cat > f <<EOF and plain > redirects, and any pattern set will miss cases and
// occasionally fire on a legitimate one. That is fine for a nudge and would not
// be for a block, so this never denies a call.
//
// It also stops after a few warnings per session: the habit it targets needs
// interrupting once, not a lecture on every call. See NOTES.md.
//
// The budget is spent by warnings that go UNHEEDED, not by warnings as such. A
// PostToolUse pass on super_edit refills it, because a caller that took the
// advice is evidence the nudge is landing rather than crying wolf -- and a long
// editing session is exactly where the nudge is worth most and, under a
// spend-only budget, exactly where it had gone silent. Ignore it repeatedly and
// it still shuts up, which is the alarm-fatigue property worth keeping.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const DEFAULT_BUDGET = 5;

// A permission dialog is invisible to a hook, but the WAIT for one is not:
// PreToolUse fires at request time, before the prompt is raised, so the gap to
// PostToolUse contains the user's decision. Measured on this harness, a gated
// call carries ~6s of fixed pre-prompt latency BEFORE the human even sees the
// dialog (observed 7439 ms for an immediate approval, 12904 ms for a deliberate
// ~10s wait), while an ungated call is single-digit milliseconds. Anything in
// 2-4s separates them cleanly; this is not decision time, so do not tune it down
// expecting it to be.
const GATED_MS = Number.parseInt(process.env.SUPER_EDIT_GATED_MS ?? "", 10) || 3000;

// bypassPermissions never prompts; plan mode does not run tools. The rest can.
const PROMPTING_MODES = new Set(["default", "acceptEdits", "ask"]);

const SETTINGS_SCOPES = [
  [".claude/settings.local.json", "this project (local)"],
  [".claude/settings.json", "this project"],
  ["~/.claude/settings.json", "your user settings"],
];

// Anything under these never counts -- scratch work is a legitimate use of the
// shell and is the majority of file-writing Bash calls in practice.
const SCRATCH = /(^|[\s"'=])(\/tmp\/|\/dev\/|\/var\/tmp\/)|scratchpad|\.git\/|node_modules\//;

const WRITERS = [
  { re: /\bsed\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i/, what: "sed -i" },
  { re: /\bperl\s+-[a-zA-Z]*i/, what: "perl -i" },
  { re: /\bpython3?\b[\s\S]*?\.write_text\s*\(/, what: "python write_text" },
  { re: /\bpython3?\b[\s\S]*?\bopen\s*\([^)]*['"][wa]\+?['"]/, what: "python open(...,'w')" },
  { re: /\bnode\b[\s\S]*?\b(writeFileSync|appendFileSync|createWriteStream)\b/, what: "node writeFileSync" },
  { re: /\b(cat|tee|printf|echo)\b[^|<>]*>>?\s*[^\s>&|;]+/, what: "shell redirect" },
  { re: />>?\s*[^\s>&|;]*\.[A-Za-z0-9]{1,6}\b/, what: "shell redirect" },
  { re: /\|\s*tee\s+(-a\s+)?[^\s|;&]+/, what: "tee" },
];

// A heredoc fed straight to an interpreter is running a script, not editing a
// file, and is the single biggest false-positive source if left in.
const HEREDOC_TO_INTERPRETER = /\b(python3?|node|bash|sh|ruby|perl|psql|sqlite3)\b[^\n<]*<<-?\s*['"]?\w+/;
const GIT_MESSAGE = /\bgit\s+(commit|tag)\b[^\n]*(-F\s*-|<<)/;

function main() {
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    return ok();
  }
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return ok();
  }
  const isOurTool = /super_edit/.test(String(payload?.tool_name ?? ""));

  // Stamp the request time so the PostToolUse pass can measure the gap.
  if (payload?.hook_event_name === "PreToolUse" && isOurTool) {
    writeStamp(stampFile(payload), Date.now());
    return ok();
  }

  // The advice was taken: refill. Deleting the counter rather than writing the
  // full budget keeps "absent means untouched" as the single default.
  if (payload?.hook_event_name === "PostToolUse") {
    if (isOurTool) {
      try {
        unlinkSync(counterFile(payload));
      } catch {
        /* never warned this session, or nothing to reset */
      }
      return ok(gatedAdvice(payload));
    }
    return ok();
  }

  if (payload?.tool_name !== "Bash") return ok();
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !command) return ok();

  const hit = detect(command);
  if (!hit) return ok();

  const counterPath = counterFile(payload);
  const remaining = readBudget(counterPath);
  if (remaining <= 0) return ok();
  writeBudget(counterPath, remaining - 1);

  ok(
    `This Bash call edits a file in place (${hit}). Prefer Edit for a single change, or the ` +
      `super_edit tool for a batch across one or more files -- it applies all patches in one ` +
      `call and fails loudly when a match count is not what you predicted.\n` +
      `Shell edits are still right for genuine bulk or generated-file work; this is a nudge, not a rule. ` +
      `Note that a shell edit to a file you have only Read (never Edit-ed) is invisible to the harness ` +
      `and silently costs you a full re-Read later.\n` +
      `${remaining - 1} more warning${remaining - 1 === 1 ? "" : "s"} this session. ` +
      `Write 0 to ${counterPath} to stop them, or delete that file to reset the budget.`,
  );
}

export function detect(command) {
  if (GIT_MESSAGE.test(command)) return null;
  // Strip heredoc-to-interpreter bodies before looking for writers, so a script
  // that merely mentions open(...,'w') on its own stdout is not flagged.
  if (HEREDOC_TO_INTERPRETER.test(command) && !/\b(sed\s+-[a-zA-Z]*i|perl\s+-[a-zA-Z]*i)/.test(command)) {
    // Still flag it if the script clearly writes a named project file.
    if (!/\.write_text\s*\(|writeFileSync|\bopen\s*\([^)]*['"][wa]\+?['"]/.test(command)) return null;
  }
  for (const { re, what } of WRITERS) {
    if (!re.test(command)) continue;
    if (SCRATCH.test(command)) return null;
    if (/>\s*\/dev\/null/.test(command) && !/>>?\s*[^\s>&|;]*\.[A-Za-z0-9]{1,6}/.test(command)) return null;
    return what;
  }
  return null;
}

// Was this call gated behind a dialog, and if so what should the user be told?
// Returns advice text for the caller to relay, or null. Two escalating stages,
// each said once per session: the advice is actionable exactly once, and this
// plugin's whole thesis is that a nudge repeated past its usefulness is a nudge
// that stops being read.
function gatedAdvice(payload) {
  const mode = String(payload?.permission_mode ?? "");
  if (mode && !PROMPTING_MODES.has(mode)) return null;

  const started = readStamp(stampFile(payload));
  if (started === null) return null;
  const waited = Date.now() - started;
  if (waited < GATED_MS) return null; // ran unprompted; nothing to say

  const tool = String(payload?.tool_name ?? "super_edit");
  const seconds = (waited / 1000).toFixed(1);
  const listedIn = findAllowEntry(payload?.cwd, tool);
  const stage = listedIn ? 2 : 1;
  if (!claimStage(stageFile(payload), stage)) return null;

  const preamble =
    `That super_edit call waited ${seconds}s, which means it was held for the user to approve` +
    `${mode ? ` (permission mode: ${mode})` : ""}. Relay the following to them — it is for ` +
    `them, not for you, and it is worth one sentence of your reply:\n\n`;

  if (stage === 1) {
    return (
      preamble +
      `Every super_edit call is costing you an approval, while the shell edits it replaces are ` +
      `less constrained, not more. To stop the prompts, allow it:\n\n` +
      `  // .claude/settings.json\n` +
      `  { "permissions": { "allow": ["${tool}"] } }\n\n` +
      `Note that settings are read at session start: adding the line, or choosing the dialog's ` +
      `project-scoped option, will not take effect until the harness reloads. The dialog's ` +
      `session-scoped option is the one that applies immediately.`
    );
  }

  return (
    preamble +
    `You were prompted even though ${tool} is already allowed in ${listedIn}. That is not a typo ` +
    `on your part — settings load at session start, so an entry added during this session does ` +
    `nothing until the harness reloads. Use the dialog's session-scoped option for the rest of ` +
    `this session; the existing entry should take effect on the next start. If it still prompts ` +
    `after a restart, the project-scoped allow is not being honoured for MCP tools and the entry ` +
    `may need to name the server (without the tool suffix) instead.`
  );
}

// Which settings scope, if any, already allows this tool. Server-level rules
// (the name without its "__tool" suffix) count too.
function findAllowEntry(cwd, tool) {
  const server = tool.replace(/__[^_]+$/, "");
  for (const [rel, label] of SETTINGS_SCOPES) {
    const path = rel.startsWith("~/")
      ? join(process.env.HOME || "", rel.slice(2))
      : join(cwd || process.cwd(), rel);
    try {
      const allow = JSON.parse(readFileSync(path, "utf8"))?.permissions?.allow;
      if (Array.isArray(allow) && allow.some((rule) => rule === tool || rule === server)) return label;
    } catch {
      /* absent or unparseable: not our problem to report */
    }
  }
  return null;
}

// True the first time this stage is claimed in a session.
function claimStage(path, stage) {
  let done = 0;
  try {
    done = Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0;
  } catch {
    /* nothing said yet */
  }
  if (done >= stage) return false;
  writeBudget(path, stage);
  return true;
}

function stampFile(payload) {
  return `${counterFile(payload)}-stamp`;
}

function stageFile(payload) {
  return `${counterFile(payload)}-advice`;
}

function writeStamp(path, value) {
  writeBudget(path, value);
}

function readStamp(path) {
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function counterFile(payload) {
  const base =
    process.env.CLAUDE_PLUGIN_DATA_DIR ||
    join(process.env.HOME || "/tmp", ".claude", "super-edit");
  const session = String(payload?.session_id ?? "session").replace(/[^\w-]/g, "");
  return join(base, `warnings-${session}`);
}

function readBudget(path) {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : DEFAULT_BUDGET;
  } catch {
    return DEFAULT_BUDGET; // absent means never warned, or deliberately reset
  }
}

function writeBudget(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(Math.max(0, value)), "utf8");
  } catch {
    /* a hook must never fail loudly */
  }
}

function ok(additionalContext) {
  if (additionalContext) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } }),
    );
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
