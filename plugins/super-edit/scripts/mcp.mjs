#!/usr/bin/env node
// A stdio MCP server exposing one tool, `super_edit`: a batch of patches
// applied in one call, with a predicted match count per patch.
//
// The protocol is implemented directly rather than with the MCP SDK, matching
// the `quota` plugin: these plugins must run on an unfamiliar machine with no
// `npm install`, and the server needs exactly three methods.
//
// See NOTES.md for why the tool is shaped this way, and in particular why it
// echoes changed regions back: this server's writes are invisible to the
// harness's file snapshot, so on a file that was only ever Read, nothing else
// will tell the caller what the file now looks like.
//
// The server is one long-lived process per session, which is what makes the
// retry token free: a failed batch is cached server-side, so the next call
// carries only the corrected patches. Field reports showed callers re-sending
// the whole 8-patch batch to fix one typo every time; the token exists so
// they don't have to.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { apply, diffHunks } from "./patch.mjs";

// Two spellings of one file ("f", "./f", a symlink, another letter case on Windows) must share one buffer. Keyed
// by the raw string, each spelling is patched from the on-disk text and the last write silently discards the rest.
// Every spelling is rewritten to the first one seen, so reports keep the name the caller used.
export function unifyAliases(patches) {
  const firstSpelling = new Map();
  return patches.map((p) => {
    if (typeof p?.file !== "string" || !p.file) return p;
    let key;
    try {
      key = realpathSync.native(p.file);
    } catch {
      key = resolve(p.file); // unreadable or absent: the read step reports it
    }
    if (!firstSpelling.has(key)) firstSpelling.set(key, p.file);
    const first = firstSpelling.get(key);
    return first === p.file ? p : { ...p, file: first };
  });
}

const PROTOCOL_VERSION = "2025-06-18";

const TOOL = {
  name: "super_edit",
  title: "Apply a batch of patches",
  description:
    "Apply several edits in one call, across one or more files, with a predicted match count per patch and " +
    "all-or-nothing writes. For a single simple substitution on one file, plain Edit is the better tool — reach " +
    "for this when batching several patches, counting matches, or keeping multi-file edits atomic is the point. " +
    "Prefer it over shell edits (sed -i, python write_text, node writeFileSync) and over long runs of single Edit calls.\n\n" +
    "Each patch matches either a literal string ('find' — strip the Read tool's line-number-and-tab prefix before " +
    "matching) or a regular expression ('regex'), and states how many matches it expects. A count mismatch fails " +
    "the patch instead of applying it: if you expected 10 occurrences and there are 8, your recollection of the " +
    "file is wrong and you should re-read it rather than change 8 things.\n\n" +
    "Patches to the same file build on each other: each one matches the text as modified by the earlier ones. " +
    "mode=atomic (default) writes nothing — to any file in the batch, not merely the file that failed — unless " +
    "every patch succeeds. Patches are applied to in-memory buffers and only reach disk once all of them have, so " +
    "there is no partial state to roll back. mode=independent applies the patches that succeed and reports each " +
    "one that did not — for sweeps where absence is expected rather than alarming, e.g. the same rename across " +
    "30 files, some of which legitimately do not contain it.\n\n" +
    "When a batch fails, its report carries a retry token: the next call sends only the corrected patches, and " +
    "the patches that validated re-run from the server's cache — an 8-patch batch with one typo costs one small " +
    "second call, not a re-send of all 8 (nothing that already reached disk runs again). dry_run validates a " +
    "batch without writing anything, and its token applies the batch as-is later: " +
    '{"retry": "<token>", "patches": []}.\n\n' +
    "Mixing this tool with Edit is safe. A later Read always shows the new content; on a file the harness has " +
    "only ever seen you Read, the next Edit may ask for one re-Read first — that re-read is the whole cost.",
  inputSchema: {
    type: "object",
    properties: {
      patches: {
        type: "array",
        description:
          "Applied in order. Patches to the same file build on each other. May be empty when 'retry' is given, " +
          "to re-run a cached batch (e.g. applying a dry run) unchanged.",
        items: {
          type: "object",
          properties: {
            file: { type: "string", description: "Absolute path, or relative to the server's working directory." },
            find: { type: "string", description: "Literal text to match. Give exactly one of 'find' or 'regex'." },
            regex: { type: "string", description: "JavaScript regular expression source. Requires 'expect'." },
            flags: { type: "string", description: "Regex flags; 'g' is always added. Default 'g'." },
            replace: { type: "string", description: "Replacement text. With 'regex', $1/$<name> backreferences apply." },
            expect: {
              type: "integer",
              minimum: 1,
              description: "How many matches you believe are present. Defaults to 1 for 'find'; required for 'regex'.",
            },
          },
          required: ["file", "replace"],
          additionalProperties: false,
        },
      },
      mode: {
        type: "string",
        enum: ["atomic", "independent"],
        description: "atomic: all-or-nothing. independent: apply what succeeds, report each failure.",
      },
      context_lines: {
        type: "integer",
        minimum: 0,
        maximum: 50,
        description:
          "Lines of context around each changed region in the report — the main cost lever for report size. " +
          "Default 3; 0 for the tersest report.",
      },
      report: {
        type: "string",
        enum: ["auto", "diff", "summary", "none"],
        description:
          "How changed files are shown back. auto (default): changed regions with context, elided and reduced to a " +
          "one-line-per-file summary when the diff would be large. diff: always the regions. summary: line ranges " +
          "only. none: confirmation only. Failures are always reported in full whatever this says.",
      },
      dry_run: {
        type: "boolean",
        description: "Validate every patch and report as usual, but write nothing. The report's token applies the batch later.",
      },
      retry: {
        type: "string",
        description:
          "Token from a failed batch's or a dry run's report. Re-runs the patches from that attempt that " +
          "validated and have not reached disk, then applies this call's patches on top. Single use; mode " +
          "defaults to that attempt's.",
      },
    },
    anyOf: [{ required: ["patches"] }, { required: ["retry"] }],
    additionalProperties: false,
  },
};

// --- retry-token cache ----------------------------------------------------
// token -> { base: patches to re-run, mode, used }. Capped FIFO; tokens are
// consumed on use so a batch can never be applied twice off one token.

const attempts = new Map();
const MAX_ATTEMPTS = 8;
let attemptSeq = 0;

function issueToken(base, mode) {
  const token = `r${(attemptSeq += 1)}`;
  attempts.set(token, { base, mode, used: false });
  while (attempts.size > MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value);
  return token;
}

// The use-Edit note is correct but was shown on every single-patch call until
// readers pattern-matched it as boilerplate — the field reports were plain
// about that. Once per server lifetime (per session) is what it takes.
let editNoteShown = false;

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // notification

  try {
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "super-edit", version: "0.2.0" },
          },
        });
      case "tools/list":
        return send({ id, result: { tools: [TOOL] } });
      case "tools/call":
        if (params?.name !== TOOL.name) {
          return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
        }
        return send({ id, result: runEdit(params?.arguments ?? {}) });
      case "ping":
        return send({ id, result: {} });
      default:
        return send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  } catch (err) {
    send({ id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
}

export function runEdit(args) {
  const patchesIn = Array.isArray(args.patches) ? args.patches : [];
  const retryToken = typeof args.retry === "string" && args.retry ? args.retry : null;
  if (!patchesIn.length && !retryToken) return errorResult("No patches given.");

  let patches = patchesIn;
  let mode = args.mode === "independent" || args.mode === "atomic" ? args.mode : undefined;
  if (retryToken) {
    const cached = attempts.get(retryToken);
    if (!cached) {
      return errorResult(`Unknown retry token ${JSON.stringify(retryToken)}.`);
    }
    if (cached.used) {
      const live = [...attempts].filter(([, a]) => !a.used).map(([t]) => t);
      return errorResult(
        `Retry token ${retryToken} was already used — compose a fresh call${live.length ? ` (valid tokens: ${live.join(", ")})` : ""}.`,
      );
    }
    cached.used = true;
    patches = [...cached.base, ...patchesIn];
    if (mode === undefined) mode = cached.mode;
  }
  if (mode === undefined) mode = "atomic";
  const dryRun = args.dry_run === true;
  const context = Number.isInteger(args.context_lines) ? args.context_lines : 3;
  const reportMode = ["auto", "diff", "summary", "none"].includes(args.report) ? args.report : "auto";

  patches = unifyAliases(patches);

  // Read every distinct file once, up front. A file that cannot be read is
  // recorded as absent rather than thrown, so the report can name it alongside
  // any other failure instead of losing the batch to the first bad path.
  const files = new Map();
  const readErrors = new Map();
  for (const p of patches) {
    const path = p?.file;
    if (typeof path !== "string" || files.has(path) || readErrors.has(path)) continue;
    try {
      files.set(path, readFileSync(path, "utf8"));
    } catch (err) {
      readErrors.set(path, String(err?.message ?? err));
    }
  }

  const { ok, results, writes } = apply(patches, files, mode);

  // A single literal `find` with the default count is exactly what plain Edit
  // does — and repeating a large `find` verbatim costs more here than there,
  // where the outgoing text never needs to travel. Size is not the test; using
  // no capability Edit lacks is.
  const editEquivalent =
    patches.length === 1 &&
    typeof patches[0]?.find === "string" &&
    (patches[0].expect === undefined || patches[0].expect === 1);

  const written = [];
  const writeFailures = [];
  if (!dryRun) {
    for (const [path, text] of writes) {
      try {
        writeFileSync(path, text, "utf8");
        written.push(path);
      } catch (err) {
        writeFailures.push(`${path}: ${String(err?.message ?? err)}`);
      }
    }
  }

  const failures = results.filter((r) => !r.ok);
  const successes = results.filter((r) => r.ok);

  // A token is worth issuing when there is something to re-run: the patches
  // that validated but have not reached disk. In atomic mode a failure means
  // nothing reached disk, so that is all the successes; in independent mode
  // they already landed and re-running them would fail their own expect
  // counts, so the cache is empty and only the corrections travel. A dry run
  // never wrote, so its successes always cache — which is what makes
  // {"retry": token, "patches": []} an apply-as-is.
  const base = dryRun || mode === "atomic" ? successes.map((r) => patches[r.index]) : [];
  const token = successes.length && (!ok || dryRun) ? issueToken(base, mode) : null;
  const filesTouched = written.length || new Set(successes.map((r) => r.file)).size;

  return {
    content: [
      {
        type: "text",
        text: report({ mode, results, files, writes, written, writeFailures, readErrors, context, ok, editEquivalent, dryRun, token, reportMode, filesTouched }),
      },
    ],
  };
}

// Beyond this many rendered lines across the whole report, auto mode shows
// per-file summaries instead. Field reports put the merged-span bloat at
// ~25-30x the lines actually changed; per-patch hunks with elision bound the
// common cases well below this, and the cap catches the rest.
const MAX_REPORT_LINES = 60;

function report({ mode, results, files, writes, written, writeFailures, readErrors, context, ok, editEquivalent, dryRun, token, reportMode, filesTouched }) {
  const lines = [];
  const failures = results.filter((r) => !r.ok);
  const successes = results.filter((r) => r.ok);
  const prefix = dryRun ? "DRY RUN — nothing was written. " : "";

  if (ok) {
    lines.push(
      `${prefix}${dryRun ? "Would apply" : "Applied"} ${successes.length} patch${successes.length === 1 ? "" : "es"} across ` +
        `${filesTouched} file${filesTouched === 1 ? "" : "s"}.`,
    );
    if (editEquivalent && !editNoteShown) {
      editNoteShown = true;
      lines.push(
        "",
        "Note: this was one literal substitution with the expected count — plain Edit does the same" +
          " in one call, without repeating the outgoing text or paying this report. Use Edit for simple" +
          " substitutions; reach for super_edit when you want its advanced features: several patches at" +
          " once, regex, or a predicted match count.",
      );
    }
  } else if (mode === "atomic") {
    lines.push(
      `${prefix}ATOMIC BATCH ABORTED — nothing ${dryRun ? "would be" : "was"} written. ${failures.length} of ${results.length} patches failed` +
        (successes.length ? `; the other ${successes.length} would have applied cleanly.` : "."),
    );
  } else {
    lines.push(
      `${prefix}${dryRun ? "Would apply" : "Applied"} ${successes.length} of ${results.length} patches; ${failures.length} failed. ` +
        `Files ${dryRun ? "to be " : ""}written: ${written.length}.`,
    );
  }

  if (failures.length) {
    lines.push("", "Failed:");
    for (const f of failures) {
      lines.push(`  patch #${f.index + 1}  ${f.file ?? "?"} — ${f.error}`);
      if (f.matches?.length) {
        const extra = f.found > f.matches.length ? ` (+${f.found - f.matches.length} more)` : "";
        lines.push(`        found at: ${f.matches.join("; ")}${extra}`);
      }
      if (f.invalidatedBy !== undefined) {
        lines.push(
          `        This text IS in the file on disk — patch #${f.invalidatedBy + 1} rewrote this region` +
            ` earlier in the batch, and patches build on each other. Your view of the file was right:` +
            ` re-order or rewrite this patch. Do not re-read.`,
        );
      } else if (f.sawModifiedBuffer) {
        lines.push(`        (counted against the file as already modified by earlier patches in this batch)`);
      }
      if (readErrors.has(f.file)) lines.push(`        read error: ${readErrors.get(f.file)}`);
    }
    // Only offer the re-read advice for failures it actually fits. Telling the
    // caller to go hunting for a typo that is not there is worse than silence.
    if (failures.some((f) => f.invalidatedBy === undefined)) {
      lines.push(
        "",
        "A count mismatch means the file does not look the way you think it does. Re-read it before retrying" +
          " (any 'found at' locations above are from the file as this batch saw it).",
      );
    }
  }

  if (writeFailures.length) {
    lines.push("", "Could not write:");
    for (const w of writeFailures) lines.push(`  ${w}`);
  }

  if (token) {
    lines.push("");
    if (dryRun && ok) {
      lines.push(`To apply for real: {"retry": "${token}", "patches": []}.`);
    } else if (mode === "atomic") {
      lines.push(
        `Retry without re-sending the ${successes.length} that were fine: send {"retry": "${token}", "patches": [corrected]}` +
          ` — they re-run from the server's cache, and a failed patch runs only if you re-send it here.`,
      );
    } else {
      lines.push(
        `Retry the failures without re-sending what landed: send {"retry": "${token}", "patches": [corrected]}` +
          ` — nothing that already reached disk runs again.`,
      );
    }
  }

  // The harness shows its own copy of these writes only for files carrying a
  // fresh Edit/Write snapshot; on files the caller has only ever Read, this
  // report is the only view. Say which it is, and name the off-switch.
  const targets = dryRun ? [...writes.keys()] : written;
  if (targets.length && reportMode !== "none") {
    const hunksByFile = new Map(targets.map((path) => [path, diffHunks(files.get(path), writes.get(path), context)]));
    const totalRendered = [...hunksByFile.values()].reduce((n, hs) => n + hs.reduce((m, h) => m + h.rendered, 0), 0);
    const summary = reportMode === "summary" || (reportMode === "auto" && totalRendered > MAX_REPORT_LINES);

    lines.push(
      "",
      `Changed regions (the harness shows its own copy of these writes only for files with a fresh Edit/Write` +
        ` snapshot; on files you have only Read, this is your only view${summary ? "" : ` — report: "summary" or "none" to skip it`}):`,
    );
    if (summary) {
      if (reportMode === "auto") {
        lines.push(`(diff would be ${totalRendered}+ lines — elided; report: "diff" to see it)`);
      }
      for (const [path, hunks] of hunksByFile) {
        const total = writes.get(path).split("\n").length;
        const ranges = hunks.map((h) => (h.firstLine === h.lastLine ? `${h.firstLine}` : `${h.firstLine}–${h.lastLine}`));
        lines.push(`  ${path} — ${hunks.length} region${hunks.length === 1 ? "" : "s"}: ${ranges.join(", ")} (of ${total} lines)`);
      }
    } else {
      for (const [path, hunks] of hunksByFile) {
        for (const h of hunks) lines.push("", `${path}  lines ${h.firstLine}–${h.lastLine}`, h.text);
      }
    }
  }

  return lines.join("\n");
}

function errorResult(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

function send(payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
}
