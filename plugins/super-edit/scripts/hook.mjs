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

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const DEFAULT_BUDGET = 5;

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
