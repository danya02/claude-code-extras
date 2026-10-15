#!/usr/bin/env node
// node plugins/super-edit/tests/run.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { apply, validate, diffHunks } from "../scripts/patch.mjs";
import { detect } from "../scripts/hook.mjs";

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) pass += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
const files = (o) => new Map(Object.entries(o));

// --- validation ---------------------------------------------------------
check("regex without expect is rejected", !!validate({ file: "a", regex: "x", replace: "y" }, 0));
check("regex with expect is accepted", validate({ file: "a", regex: "x", replace: "y", expect: 2 }, 0) === null);
check("literal defaults expect to 1", validate({ file: "a", find: "x", replace: "y" }, 0) === null);
check("both find and regex is rejected", !!validate({ file: "a", find: "x", regex: "x", replace: "y" }, 0));
check("neither find nor regex is rejected", !!validate({ file: "a", replace: "y" }, 0));
check("invalid regex is rejected", !!validate({ file: "a", regex: "([", replace: "y", expect: 1 }, 0));
check("expect must be positive", !!validate({ file: "a", find: "x", replace: "y", expect: 0 }, 0));

// --- count enforcement --------------------------------------------------
{
  const r = apply([{ file: "f", regex: "\\blet\\b", replace: "const", expect: 10 }], files({ f: "let a; let b;" }));
  check("wrong predicted count fails", !r.ok && /matched 2 times, expected 10/.test(r.results[0].error), r.results[0].error);
  check("wrong count writes nothing", r.writes.size === 0);
}
{
  const r = apply([{ file: "f", regex: "\\blet\\b", replace: "const", expect: 2 }], files({ f: "let a; let b;" }));
  check("right predicted count applies all", r.ok && r.writes.get("f") === "const a; const b;", r.writes.get("f"));
}
{
  const r = apply([{ file: "f", find: "x", replace: "y" }], files({ f: "x and x" }));
  check("literal defaulting to 1 fails on 2 matches", !r.ok && /found 2 matches, expected 1/.test(r.results[0].error));
}
{
  const r = apply([{ file: "f", find: "x", replace: "y", expect: 2 }], files({ f: "x and x" }));
  check("literal with expect 2 applies both", r.ok && r.writes.get("f") === "y and y");
}
{
  const r = apply([{ file: "f", find: "nope", replace: "y" }], files({ f: "abc" }));
  check("no match reports clearly", !r.ok && /no match for the literal text/.test(r.results[0].error));
}

// --- regex backreferences and flags ------------------------------------
{
  const r = apply([{ file: "f", regex: "v(\\d)", replace: "version$1", expect: 2 }], files({ f: "v1 v2" }));
  check("backreferences work", r.ok && r.writes.get("f") === "version1 version2", r.writes.get("f"));
}
{
  const r = apply([{ file: "f", regex: "ABC", flags: "i", replace: "x", expect: 2 }], files({ f: "abc AbC" }));
  check("flags are honoured and g is forced", r.ok && r.writes.get("f") === "x x", r.writes.get("f"));
}

// --- atomic vs independent ---------------------------------------------
{
  const patches = [
    { file: "a", find: "one", replace: "1" },
    { file: "b", find: "MISSING", replace: "x" },
    { file: "a", find: "two", replace: "2" },
  ];
  const atomic = apply(patches, files({ a: "one two", b: "bbb" }), "atomic");
  check("atomic aborts entirely", !atomic.ok && atomic.writes.size === 0);
  check("atomic still reports every patch", atomic.results.length === 3);
  check("atomic names the good ones too", atomic.results.filter((r) => r.ok).length === 2);

  const indep = apply(patches, files({ a: "one two", b: "bbb" }), "independent");
  check("independent applies what works", indep.writes.get("a") === "1 2", indep.writes.get("a"));
  check("independent leaves the failing file alone", !indep.writes.has("b"));
  check("independent identifies the failing index", indep.results[1].index === 1 && !indep.results[1].ok);
}

// --- invalidated-by-an-earlier-patch, vs a genuine no-match -------------
// These two fail identically at the point of failure but need opposite
// responses from the caller, so the report has to tell them apart.
{
  const r = apply(
    [
      { file: "f", find: "gamma three", replace: "gamma THREE" },
      { file: "f", find: "gamma three", replace: "gamma tres" },
    ],
    files({ f: "alpha one\ngamma three\n" }),
  );
  check("overlap fails the later patch", !r.ok && !r.results[1].ok);
  check("overlap names the patch that moved the ground", r.results[1].invalidatedBy === 0, String(r.results[1].invalidatedBy));
  check("overlap writes nothing under atomic", r.writes.size === 0);
}
{
  const r = apply(
    [
      { file: "f", find: "alpha one", replace: "alpha ONE" },
      { file: "f", find: "typo that is not there", replace: "x" },
    ],
    files({ f: "alpha one\ngamma three\n" }),
  );
  check("a genuine no-match is not blamed on the batch", !r.ok && r.results[1].invalidatedBy === undefined);
}
{
  // Only the *pre-batch* text counts as exoneration: if the text was never
  // there, an earlier patch on the same file is not the explanation.
  const r = apply(
    [
      { file: "f", find: "alpha one", replace: "alpha ONE" },
      { file: "f", find: "alpha ONE", replace: "alpha 1" },
    ],
    files({ f: "alpha one\n" }),
  );
  check("a patch matching an earlier patch's output still succeeds", r.ok && r.writes.get("f") === "alpha 1\n");
}

// --- count mismatch shows where the matches are --------------------------
{
  const r = apply([{ file: "f", find: "x", replace: "y", expect: 3 }], files({ f: "a\nx\nb\nx\nc\nx\nd\nx\ne\nx\n" }));
  const res = r.results[0];
  check("mismatch carries the found count", !res.ok && res.found === 5, String(res.found));
  check("mismatch samples carry line numbers", res.matches?.[0] === "line 2: x" && res.matches?.[1] === "line 4: x", JSON.stringify(res.matches));
  check("samples are capped at three", res.matches.length === 3);
}
{
  const r = apply([{ file: "f", regex: "l\\w+", replace: "x", expect: 99 }], files({ f: "one line\ntwo lines\n" }));
  const res = r.results[0];
  check("regex mismatch samples match text", res.matches?.[0] === "line 1: line" && res.matches?.[1] === "line 2: lines", JSON.stringify(res.matches));
}
{
  const r = apply([{ file: "f", find: "zzz", replace: "y" }], files({ f: "abc" }));
  check("zero matches gives no samples", r.results[0].matches === undefined);
}

// --- count wording ------------------------------------------------------
{
  const r = apply([{ file: "f", find: "x", replace: "y", expect: 3 }], files({ f: "x" }));
  check("singular count reads '1 match'", /found 1 match, expected 3/.test(r.results[0].error), r.results[0].error);
}
{
  const r = apply([{ file: "f", regex: "x", replace: "y", expect: 3 }], files({ f: "x" }));
  check("singular regex count reads '1 time'", /matched 1 time, expected 3/.test(r.results[0].error), r.results[0].error);
}
check("validate numbers patches one-based", /patch #1\b/.test(validate({ file: "a", replace: "y" }, 0)));

// --- sequential application within a file ------------------------------
{
  const r = apply(
    [
      { file: "f", find: "a", replace: "b" },
      { file: "f", find: "b", replace: "c" },
    ],
    files({ f: "a" }),
  );
  check("later patches see earlier results", r.ok && r.writes.get("f") === "c", r.writes.get("f"));
}

// --- unreadable file ----------------------------------------------------
{
  const r = apply([{ file: "gone", find: "x", replace: "y" }], files({}));
  check("missing file is a patch failure, not a throw", !r.ok && /could not be read/.test(r.results[0].error));
}

// --- changed regions ----------------------------------------------------
{
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 15", "line 15 CHANGED");
  const hunks = diffHunks(before, after, 2);
  check("single change is one tight hunk", hunks.length === 1 && hunks[0].firstLine === 13 && hunks[0].lastLine === 17, JSON.stringify(hunks));
  check("hunk shows the new content", /line 15 CHANGED/.test(hunks[0].text));
}
{
  // The case that motivated per-patch hunks: distant changes used to merge
  // into one span covering everything between them (~25x bloat, field-measured).
  const before = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 10\n", "line 10 CHANGED\n").replace("line 110\n", "line 110 CHANGED\n");
  const hunks = diffHunks(before, after, 3);
  check("distant changes stay separate hunks", hunks.length === 2, JSON.stringify(hunks.map((h) => [h.firstLine, h.lastLine])));
  check("hunks do not span the untouched middle", hunks[1].firstLine - hunks[0].lastLine > 80, JSON.stringify(hunks.map((h) => [h.firstLine, h.lastLine])));
}
{
  const before = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
  const after = [...before.split("\n").slice(0, 5), "new1", "new2", ...before.split("\n").slice(5)].join("\n");
  const hunks = diffHunks(before, after, 1);
  check("a pure insertion is reported", hunks.length === 1 && /new1/.test(hunks[0].text), JSON.stringify(hunks));
}
{
  const before = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace("l5\n", "").replace("l6\n", "");
  const hunks = diffHunks(before, after, 2);
  check("a pure deletion is reported where it happened", hunks.length === 1 && hunks[0].firstLine === 4 && hunks[0].lastLine === 8, JSON.stringify(hunks));
}
{
  // A large replacement is text the caller just wrote; it must be elided
  // rather than echoed back in full.
  const before = Array.from({ length: 130 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 130 }, (_, i) => (i >= 60 && i < 120 ? `new ${i}` : `old ${i}`)).join("\n");
  const hunks = diffHunks(before, after, 3);
  check("large replacement elides its middle", hunks.length === 1 && /lines elided/.test(hunks[0].text) && hunks[0].rendered <= 17, JSON.stringify(hunks[0]?.text));
}

// --- hook detection -----------------------------------------------------
const shouldFlag = [
  "sed -i 's/a/b/' src/main.rs",
  "perl -pi -e 's/a/b/' Justfile",
  "python3 - <<'EOF'\nimport pathlib\np=pathlib.Path('tools/x.py'); p.write_text(s)\nEOF",
  "node -e 'require(\"fs\").writeFileSync(\"hooks.json\", x)'",
  "cat > README.md <<'EOF'\nhi\nEOF",
];
const shouldNotFlag = [
  "sed -i 's/a/b/' /tmp/scratch.txt",
  "cat file.txt | grep foo",
  "python3 - <<'EOF'\nprint('just computing')\nEOF",
  "git commit -q -F - <<'EOF'\nmessage\nEOF",
  "cargo build 2>&1 | tail -5",
  "ls -la > /dev/null",
  // Arrow functions and -> inside quoted arguments are not redirects; these
  // fired six times in one field session and exhausted the warning budget.
  "just eval 'JSON.stringify(chart.series.values.map(s=>s.name))' oiot.ru",
  "node -e \"x.filter(a=>a.id).map(b=>b.name)\"",
  "just eval 'd.forEach(r=>{m[r.date]=r})' site.ru",
  "jq '.items[] | select(.n>0)' f.json",
  // A scratch heredoc under /tmp piped into a pod: `>` sits right before the
  // path, which the scratch rule used to miss for lack of a preceding space.
  "cat >/tmp/probe.py <<'PYEOF'\nprint(1)\nPYEOF\nkubectl exec -i deploy/x -- python3 - </tmp/probe.py",
];
for (const cmd of shouldFlag) check(`flags: ${cmd.slice(0, 40)}`, detect(cmd) !== null);
for (const cmd of shouldNotFlag) check(`ignores: ${cmd.slice(0, 40)}`, detect(cmd) === null, `got ${detect(cmd)}`);

// A redirect into a path that does not exist yet creates a file — generated
// or bulk work the nudge's own text exempts. `exists` defaults to "yes" so
// the checks above run without a filesystem.
{
  const heredoc = "cat > made-up.yml <<'EOF'\nx\nEOF";
  check("new-file redirect is not flagged", detect(heredoc, { cwd: "/w", exists: (p) => p.replaceAll("\\", "/") !== "/w/made-up.yml" }) === null);
  check("existing-file redirect is still flagged", detect(heredoc, { cwd: "/w", exists: (p) => p.replaceAll("\\", "/") === "/w/made-up.yml" }) !== null);
  check("default assumes the target exists", detect(heredoc) !== null);
  // An absolute target in the platform's own form (C:\... on Windows) must not be joined onto the cwd.
  const absTarget = join(tmpdir(), "..", "abs-target.yml");
  const absHeredoc = `cat > "${absTarget}" <<'EOF'\nx\nEOF`;
  check("absolute target resolves as itself", detect(absHeredoc, { cwd: "/w", exists: (p) => p === absTarget }) !== null);
  check("append to an existing file is flagged", detect("echo hi >> log/exists.txt", { cwd: "/w", exists: () => true }) !== null);
}

// --- end-to-end over the MCP protocol -----------------------------------
// One drive() is one server process, so token state carries across calls in
// the sequence — which is exactly what the retry tests need.
function drive(requests) {
  const proc = spawnSync("node", [fileURLToPath(new URL("../scripts/mcp.mjs", import.meta.url))], {
    input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
    encoding: "utf8",
  });
  return proc.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const call = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "super_edit", arguments: args } });
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

{
  const dir = mkdtempSync(join(tmpdir(), "super-edit-"));
  const target = join(dir, "sample.txt");
  writeFileSync(target, "alpha\nbeta\ngamma\n");
  const replies = drive([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    call(3, { patches: [{ file: target, find: "beta", replace: "BETA" }] }),
    call(4, { patches: [{ file: target, find: "gamma", replace: "GAMMA" }] }),
  ]);
  check("server answers all requests", replies.length === 4, JSON.stringify(replies.map((r) => r.id)));
  check("server advertises super_edit", replies[1]?.result?.tools?.[0]?.name === "super_edit");
  check("retry and report are in the schema", ["retry", "report", "dry_run"].every((k) => k in (replies[1]?.result?.tools?.[0]?.inputSchema?.properties ?? {})));
  check("end-to-end write lands on disk", readFileSync(target, "utf8") === "alpha\nBETA\nGAMMA\n");
  const first = replies[2]?.result?.content?.[0]?.text ?? "";
  const second = replies[3]?.result?.content?.[0]?.text ?? "";
  check("report echoes the changed region", /BETA/.test(first), first);
  check("single literal call gets the use-Edit note", /plain Edit does the same/.test(first), first.slice(0, 160));
  check("the use-Edit note fires once per session", !/plain Edit does the same/.test(second), second.slice(0, 160));
  rmSync(dir, { recursive: true, force: true });
}

// A count mismatch, end to end: the report must show where the matches were.
{
  const dir = mkdtempSync(join(tmpdir(), "super-edit-"));
  const target = join(dir, "sample.txt");
  writeFileSync(target, "alpha\nbeta\ngamma\nbeta\n");
  const mismatchReport = text(drive([
    INIT,
    call(2, { patches: [{ file: target, find: "beta", replace: "B" }] }),
  ])[1]);
  check("mismatch report shows found count", /found 2 matches, expected 1/.test(mismatchReport), mismatchReport);
  check("mismatch report shows match locations", /found at: line 2: beta; line 4: beta/.test(mismatchReport), mismatchReport);
  check("mismatch report writes nothing", readFileSync(target, "utf8") === "alpha\nbeta\ngamma\nbeta\n");
  rmSync(dir, { recursive: true, force: true });
}

// Retry: a failed atomic batch hands back a token; the next call carries only
// the corrected patch, and the good ones re-run from the server's cache.
// Tokens are deterministic per process, so the first one a session issues is
// r1 — the report itself is checked to confirm that.
{
  const dir = mkdtempSync(join(tmpdir(), "super-edit-"));
  const target = join(dir, "sample.txt");
  writeFileSync(target, "one\ntwo\nthree\n");
  const replies = drive([
    INIT,
    call(2, { patches: [
      { file: target, find: "one", replace: "ONE" },
      { file: target, find: "two", replace: "TWO", expect: 2 },
    ] }),
    call(3, { retry: "r1", patches: [{ file: target, find: "two", replace: "TWO" }] }),
    call(4, { retry: "r1", patches: [] }),
    call(5, { retry: "r99", patches: [] }),
  ]);
  const failed = text(replies[1]);
  const token = (failed.match(/"retry": "(r\d+)"/) ?? [])[1];
  check("atomic failure offers retry token r1", token === "r1", failed);
  check("retry hint names the cached patch count", /Retry without re-sending the 1 that were fine/.test(failed), failed);
  check("retry applies the cached good patch too", /Applied 2 patches/.test(text(replies[2])), text(replies[2]));
  check("retry landed the whole batch on disk", readFileSync(target, "utf8") === "ONE\nTWO\nthree\n", readFileSync(target, "utf8"));
  check("consumed token errors", replies[3]?.result?.isError === true && /already used/.test(text(replies[3])), text(replies[3]));
  check("unknown token errors", replies[4]?.result?.isError === true && /Unknown retry token/.test(text(replies[4])), text(replies[4]));
  rmSync(dir, { recursive: true, force: true });
}

// Independent mode: what landed must not re-run, so the retry cache is empty
// and only the corrections travel.
{
  const dir = mkdtempSync(join(tmpdir(), "super-edit-"));
  const target = join(dir, "sample.txt");
  writeFileSync(target, "one\ntwo\n");
  const replies = drive([
    INIT,
    call(2, { mode: "independent", patches: [
      { file: target, find: "one", replace: "ONE" },
      { file: target, find: "missing", replace: "x" },
    ] }),
    call(3, { retry: "r1", patches: [{ file: target, find: "two", replace: "TWO" }] }),
  ]);
  const partial = text(replies[1]);
  check("independent partial success offers a token", /"retry": "r1"/.test(partial) && /nothing that already reached disk runs again/.test(partial), partial);
  check("independent applied the good patch", /Applied 1 of 2 patches/.test(partial), partial);
  check("independent retry runs only the new patch", /Applied 1 patch/.test(text(replies[2])), text(replies[2]));
  check("independent retry result on disk", readFileSync(target, "utf8") === "ONE\nTWO\n", readFileSync(target, "utf8"));
  rmSync(dir, { recursive: true, force: true });
}

// Dry run: validates, writes nothing, and its token applies the batch as-is.
// (If the dry run had written, the retry's own expect check would fail — so
// the applied count is also the proof that it did not.)
{
  const dir = mkdtempSync(join(tmpdir(), "super-edit-"));
  const target = join(dir, "sample.txt");
  writeFileSync(target, "alpha\n");
  const replies = drive([
    INIT,
    call(2, { dry_run: true, patches: [{ file: target, find: "alpha", replace: "ALPHA" }] }),
    call(3, { retry: "r1", patches: [] }),
  ]);
  const dry = text(replies[1]);
  check("dry run says nothing was written", /DRY RUN — nothing was written\./.test(dry) && /Would apply 1 patch/.test(dry), dry);
  check("dry run offers apply-as-is", /To apply for real: \{"retry": "r1", "patches": \[\]\}/.test(dry), dry);
  check("dry run's token applies the batch unchanged", readFileSync(target, "utf8") === "ALPHA\n", readFileSync(target, "utf8"));
  check("apply-as-is reports the patch count", /Applied 1 patch/.test(text(replies[2])), text(replies[2]));
  rmSync(dir, { recursive: true, force: true });
}

// Report modes: none skips regions entirely; auto degrades to a per-file
// summary when the diff would be large.
{
  const dir = mkdtempSync(join(tmpdir(), "super-edit-"));
  const target = join(dir, "sample.txt");
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} payload text`);
  const patches = [10, 25, 40, 55, 70, 85, 100, 115, 130, 145, 160, 175].map((n) => ({
    file: target,
    find: `line ${n} payload`,
    replace: `line ${n} CHANGED`,
  }));

  writeFileSync(target, lines.join("\n") + "\n");
  const none = drive([INIT, call(2, { patches, report: "none" })]);
  check("report none skips regions", !/Changed regions/.test(text(none[1])), text(none[1]).slice(-200));

  writeFileSync(target, lines.join("\n") + "\n");
  const autoText = text(drive([INIT, call(2, { patches })])[1]);
  check("auto degrades a large diff to summaries", /elided; report: "diff" to see it/.test(autoText) && /12 regions: /.test(autoText), autoText.slice(-400));
  check("degraded summary keeps line ranges", /regions: 7–13, 22–28, 37–43/.test(autoText), autoText.slice(-400));

  writeFileSync(target, lines.join("\n") + "\n");
  const diffText = text(drive([INIT, call(2, { patches: [patches[0]], report: "diff" })])[1]);
  check("diff mode shows region content", /line 10 CHANGED/.test(diffText), diffText);
  rmSync(dir, { recursive: true, force: true });
}

// --- literal and regex edge cases ---------------------------------------
{
  const one = (patch, text) => apply([{ file: "a", ...patch }], files({ a: text }));
  check("literal replace treats $& and $1 as plain text", one({ find: "x", replace: "$&$1" }, "x").writes.get("a") === "$&$1");
  check("an empty replace deletes the match", one({ find: "x", replace: "" }, "axb").writes.get("a") === "ab");
  check("a replace containing the find text is applied once", one({ find: "a", replace: "aa" }, "a").writes.get("a") === "aa");
  check("a no-op replace succeeds but writes nothing", (() => { const r = one({ find: "x", replace: "x" }, "x"); return r.ok && r.writes.size === 0; })());
  check("overlapping literal matches count as non-overlapping", one({ find: "aa", replace: "b" }, "aaa").writes.get("a") === "ba");
  check("a find with an LF does not match a CRLF file", /no match/.test(one({ find: "a\nb", replace: "X" }, "a\r\nb").results[0].error ?? ""));
  check("CRLF endings survive an edit on another line", one({ find: "b", replace: "X" }, "a\r\nb\r\nc\r\n").writes.get("a") === "a\r\nX\r\nc\r\n");
  check("a byte-order mark survives an edit", one({ find: "x", replace: "y" }, "﻿x").writes.get("a") === "﻿y");
  check("multi-byte text is matched and replaced", one({ find: "naïve", replace: "naive" }, "a naïve b").writes.get("a") === "a naive b");
  check("an empty file matches nothing", /no match/.test(one({ find: "x", replace: "y" }, "").results[0].error ?? ""));
  check("a file with no trailing newline is edited intact", one({ find: "end", replace: "END" }, "start\nend").writes.get("a") === "start\nEND");
  check("regex flag m anchors every line", one({ regex: "^", replace: "# ", expect: 3, flags: "m" }, "a\nb\nc").writes.get("a") === "# a\n# b\n# c");
  check("regex without m anchors the text once", one({ regex: "^", replace: "# ", expect: 1 }, "a\nb\nc").writes.get("a") === "# a\nb\nc");
  check("regex backreferences swap groups", one({ regex: "(a)(b)", replace: "$2$1", expect: 1 }, "ab").writes.get("a") === "ba");
  check("a zero-width regex is counted per position", one({ regex: "x*", replace: "-", expect: 2 }, "b").ok);
  check("unknown regex flags are dropped, not fatal", one({ regex: "a", replace: "b", expect: 1, flags: "gzz" }, "a").ok);
  check("a regex mismatch is reported as a regex", /regex matched nothing/.test(one({ regex: "q", replace: "r", expect: 1 }, "abc").results[0].error ?? ""));
  check("expect must be an integer", !!validate({ file: "a", find: "x", replace: "y", expect: 1.5 }, 0));
  check("expect must not be a string", !!validate({ file: "a", find: "x", replace: "y", expect: "1" }, 0));
  check("an empty file name is rejected", !!validate({ file: "", find: "x", replace: "y" }, 0));
  check("an empty find is rejected", !!validate({ file: "a", find: "", replace: "y" }, 0));
  check("a missing replace is rejected", !!validate({ file: "a", find: "x" }, 0));
  check("a null patch is rejected", !!validate(null, 0));
  check("a numeric find is rejected", !!validate({ file: "a", find: 1, replace: "y" }, 0));
}

// --- batches across files and modes -------------------------------------
{
  const two = apply(
    [{ file: "a", find: "1", replace: "A" }, { file: "b", find: "2", replace: "B" }],
    files({ a: "1", b: "2" }),
  );
  check("a two-file batch writes both files", two.ok && two.writes.get("a") === "A" && two.writes.get("b") === "B");

  const atomic = apply(
    [{ file: "a", find: "1", replace: "A" }, { file: "b", find: "nope", replace: "B" }],
    files({ a: "1", b: "2" }),
  );
  check("atomic writes no file when another file fails", !atomic.ok && atomic.writes.size === 0);

  const independent = apply(
    [{ file: "a", find: "1", replace: "A" }, { file: "b", find: "nope", replace: "B" }],
    files({ a: "1", b: "2" }),
    "independent",
  );
  check("independent keeps the file that succeeded", !independent.ok && independent.writes.get("a") === "A" && !independent.writes.has("b"));

  const unreadable = apply(
    [{ file: "gone", find: "1", replace: "A" }, { file: "a", find: "1", replace: "A" }],
    files({ a: "1" }),
    "independent",
  );
  check("independent reports an unreadable file and still patches the rest", unreadable.results[0].ok === false && unreadable.writes.get("a") === "A");

  const sequential = apply(
    [{ file: "a", find: "1", replace: "2" }, { file: "a", find: "2", replace: "3" }],
    files({ a: "1" }),
  );
  check("a later patch sees the earlier patch's result", sequential.writes.get("a") === "3");
}

// --- the same file under two spellings -----------------------------------
// Keyed by the raw string, "f" and "./f" were two buffers over one file, so both
// were written and the last silently discarded the first.
{
  const dir = mkdtempSync(join(tmpdir(), "super-edit-"));
  const target = join(dir, "sample.txt");
  const alias = `${dir}${sep}.${sep}sample.txt`;
  writeFileSync(target, "one two\n");
  const replies = drive([
    INIT,
    call(2, { patches: [{ file: target, find: "one", replace: "1" }, { file: alias, find: "two", replace: "2" }] }),
  ]);
  check("two spellings of one file keep both edits", readFileSync(target, "utf8") === "1 2\n", readFileSync(target, "utf8"));
  check("two spellings of one file report success", /Applied|applied/.test(text(replies[1])) || !/fail/i.test(text(replies[1])), text(replies[1]).slice(0, 200));
  rmSync(dir, { recursive: true, force: true });
}

// --- end-to-end error paths ----------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "super-edit-"));
  const target = join(dir, "sample.txt");
  writeFileSync(target, "keep\n");
  const missing = text(drive([INIT, call(2, { patches: [{ file: join(dir, "absent.txt"), find: "x", replace: "y" }] })])[1]);
  check("a missing file is named in the report", /absent\.txt/.test(missing) && /could not be read/.test(missing), missing.slice(0, 200));
  const asDir = text(drive([INIT, call(2, { patches: [{ file: dir, find: "x", replace: "y" }] })])[1]);
  check("a directory given as a file is a read error, not a crash", /could not be read/.test(asDir), asDir.slice(0, 200));
  const none = drive([INIT, call(2, { patches: [] })])[1];
  check("an empty patch list is an error result", /No patches given/.test(text(none)), text(none));
  const noTool = drive([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "other", arguments: {} } }])[1];
  check("an unknown tool name is a protocol error", noTool?.error?.code === -32602);
  const noMethod = drive([INIT, { jsonrpc: "2.0", id: 2, method: "nope" }])[1];
  check("an unknown method is a protocol error", noMethod?.error?.code === -32601);
  const ping = drive([INIT, { jsonrpc: "2.0", id: 2, method: "ping" }])[1];
  check("ping answers with an empty result", ping?.result && Object.keys(ping.result).length === 0);
  check("a failed batch leaves the file untouched", readFileSync(target, "utf8") === "keep\n");
  rmSync(dir, { recursive: true, force: true });
}

// --- changed-region report edge cases ------------------------------------
{
  const before = "l1\nl2\nl3\nl4\nl5\n";
  const after = "l1\nL2\nl3\nl4\nL5\n";
  const spans = (hunks) => JSON.stringify(hunks.map((h) => [h.firstLine, h.lastLine]));
  check("a trailing newline does not add a phantom last line", spans(diffHunks(before, after, 3)) === "[[1,5]]", spans(diffHunks(before, after, 3)));
  check("context 0 shows exactly the changed lines", spans(diffHunks(before, after, 0)) === "[[2,2],[5,5]]");
  check("a negative context behaves as zero", spans(diffHunks(before, after, -1)) === spans(diffHunks(before, after, 0)));
  check("a very negative context never runs backwards", diffHunks(before, after, -5).every((h) => h.lastLine >= h.firstLine));
  check("a non-integer context falls back to the default", spans(diffHunks(before, after, 1.5)) === spans(diffHunks(before, after, 3)));
  check("appending a line at the end is reported", spans(diffHunks("a\nb\n", "a\nb\nc\n", 3)) === "[[1,3]]");
  check("removing the last line is reported", diffHunks("a\nb\nc\n", "a\nb\n", 0).length === 1);
  check("adding only the final newline is still a change", diffHunks("a", "a\n", 3).length === 1);
  check("removing only the final newline is still a change", diffHunks("a\n", "a", 3).length === 1);
  check("identical text has no hunks", diffHunks(before, before, 3).length === 0);
  check("a file without a trailing newline reports its real last line", spans(diffHunks("a\nb", "a\nB", 3)) === "[[1,2]]");
  check("an empty before-text diffs against new content", diffHunks("", "x\n", 3).length === 1);
}

// --- more hook heuristics ------------------------------------------------
{
  const flagged = (c) => detect(c, { cwd: "/w", exists: () => true }) !== null;
  check("sed --in-place is flagged", flagged("sed --in-place s/a/b/ f.txt"));
  check("sed -i with a backup suffix is flagged", flagged("sed -i.bak s/a/b/ f.txt"));
  check("sed -n without -i is not flagged", !flagged("sed -n '1,5p' file.txt"));
  check("sed --in-place on a /tmp scratch file is not flagged", !flagged("sed --in-place s/a/b/ /tmp/x"));
  check("a git commit message containing > is not flagged", !flagged('git commit -m "a > b"'));
  check("a redirect to /dev/null is not flagged", !flagged("echo hi > /dev/null"));
  check("2>&1 into a pipe is not flagged", !flagged("ls 2>&1 | head"));
  check("an append to a project file is flagged", flagged("echo x >> notes.md"));
  check("a redirect with no space is flagged", flagged("echo a>f.txt"));
  check("a stderr redirect to a named file is flagged", flagged("cmd 2> err.log"));
  check("perl -pi is flagged", flagged("perl -pi -e 's/a/b/' f.txt"));
  check("python open(..., 'w') is flagged", flagged("python3 -c \"open('f','w').write('x')\""));
  check("node writeFileSync is flagged", flagged("node -e \"require('fs').writeFileSync('f','x')\""));
  check("a plain read-only command is not flagged", !flagged("cat README.md | head -20"));
  check("an empty command is not flagged", !flagged(""));
}

function text(reply) {
  return reply?.result?.content?.[0]?.text ?? "";
}

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
