#!/usr/bin/env node
// node plugins/super-edit/tests/run.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  check("new-file redirect is not flagged", detect(heredoc, { cwd: "/w", exists: (p) => p !== "/w/made-up.yml" }) === null);
  check("existing-file redirect is still flagged", detect(heredoc, { cwd: "/w", exists: (p) => p === "/w/made-up.yml" }) !== null);
  check("default assumes the target exists", detect(heredoc) !== null);
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

function text(reply) {
  return reply?.result?.content?.[0]?.text ?? "";
}

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
