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

import { readFileSync, writeFileSync } from "node:fs";
import { apply, changedRegions } from "./patch.mjs";

const PROTOCOL_VERSION = "2025-06-18";

const TOOL = {
  name: "super_edit",
  title: "Apply a batch of patches",
  description:
    "Apply several edits in one call, across one or more files. Prefer this over shell edits " +
    "(sed -i, python write_text, node writeFileSync) and over long runs of single Edit calls.\n\n" +
    "Each patch matches either a literal string ('find') or a regular expression ('regex'), and " +
    "states how many matches it expects. A count mismatch fails the patch instead of applying it: " +
    "if you expected 10 occurrences and there are 8, your recollection of the file is wrong and you " +
    "should re-read it rather than change 8 things.\n\n" +
    "mode=atomic (default) writes nothing unless every patch succeeds. mode=independent applies the " +
    "patches that succeed and reports each one that did not, which is what you want on a large batch " +
    "where you need to know which entry was wrong.",
  inputSchema: {
    type: "object",
    properties: {
      patches: {
        type: "array",
        minItems: 1,
        description: "Applied in order. Patches to the same file build on each other.",
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
        description: "Lines of context around each changed region in the report. Default 3.",
      },
    },
    required: ["patches"],
    additionalProperties: false,
  },
};

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
            serverInfo: { name: "super-edit", version: "0.1.0" },
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
  const patches = Array.isArray(args.patches) ? args.patches : [];
  if (!patches.length) return errorResult("No patches given.");
  const mode = args.mode === "independent" ? "independent" : "atomic";
  const context = Number.isInteger(args.context_lines) ? args.context_lines : 3;

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

  const written = [];
  const writeFailures = [];
  for (const [path, text] of writes) {
    try {
      writeFileSync(path, text, "utf8");
      written.push(path);
    } catch (err) {
      writeFailures.push(`${path}: ${String(err?.message ?? err)}`);
    }
  }

  return { content: [{ type: "text", text: report({ mode, results, files, writes, written, writeFailures, readErrors, context, ok }) }] };
}

function report({ mode, results, files, writes, written, writeFailures, readErrors, context, ok }) {
  const lines = [];
  const failures = results.filter((r) => !r.ok);
  const successes = results.filter((r) => r.ok);

  if (ok) {
    lines.push(`Applied ${successes.length} patch${successes.length === 1 ? "" : "es"} across ${written.length} file${written.length === 1 ? "" : "s"}.`);
  } else if (mode === "atomic") {
    lines.push(
      `ATOMIC BATCH ABORTED — nothing was written. ${failures.length} of ${results.length} patches failed; ` +
        `the other ${successes.length} would have applied cleanly.`,
    );
  } else {
    lines.push(`Applied ${successes.length} of ${results.length} patches; ${failures.length} failed. Files written: ${written.length}.`);
  }

  if (failures.length) {
    lines.push("", "Failed:");
    for (const f of failures) {
      lines.push(`  [${f.index}] ${f.file ?? "?"} — ${f.error}`);
      if (readErrors.has(f.file)) lines.push(`        read error: ${readErrors.get(f.file)}`);
    }
    lines.push(
      "",
      "A count mismatch means the file does not look the way you think it does. Re-read it before retrying.",
    );
  }

  if (writeFailures.length) {
    lines.push("", "Could not write:");
    for (const w of writeFailures) lines.push(`  ${w}`);
  }

  // The harness cannot see these writes, so show what the files now contain.
  if (written.length) {
    lines.push("", "Changed regions (this server's writes are not tracked by the harness, so this is your only view of them):");
    for (const path of written) {
      const region = changedRegions(files.get(path), writes.get(path), context);
      lines.push("", `${path}  lines ${region.firstLine}-${region.lastLine}`, region.text);
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
