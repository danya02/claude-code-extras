#!/usr/bin/env node
// node plugins/super-edit/tests/run.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { apply, validate, changedRegions } from "../scripts/patch.mjs";
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
  const region = changedRegions(before, after, 2);
  check("region is tight around the change", region.firstLine === 13 && region.lastLine === 17, `${region.firstLine}-${region.lastLine}`);
  check("region shows the new content", /line 15 CHANGED/.test(region.text));
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
];
for (const cmd of shouldFlag) check(`flags: ${cmd.slice(0, 40)}`, detect(cmd) !== null);
for (const cmd of shouldNotFlag) check(`ignores: ${cmd.slice(0, 40)}`, detect(cmd) === null, `got ${detect(cmd)}`);

// --- end-to-end over the MCP protocol -----------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "super-edit-"));
  const target = join(dir, "sample.txt");
  writeFileSync(target, "alpha\nbeta\ngamma\n");
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "super_edit", arguments: { patches: [{ file: target, find: "beta", replace: "BETA" }] } },
    },
  ];
  const proc = spawnSync("node", [new URL("../scripts/mcp.mjs", import.meta.url).pathname], {
    input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
    encoding: "utf8",
  });
  const replies = proc.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check("server answers all three", replies.length === 3, proc.stdout + proc.stderr);
  check("server advertises super_edit", replies[1]?.result?.tools?.[0]?.name === "super_edit");
  check("end-to-end write lands on disk", readFileSync(target, "utf8") === "alpha\nBETA\ngamma\n");
  const appliedReport = replies[2]?.result?.content?.[0]?.text ?? "";
  check("report echoes the changed region", /BETA/.test(appliedReport));
  check("single literal call gets the use-Edit note", /plain Edit does the same/.test(appliedReport), appliedReport.slice(0, 120));

  // A count mismatch, end to end: the report must show where the matches were.
  writeFileSync(target, "alpha\nbeta\ngamma\nbeta\n");
  const mismatch = spawnSync("node", [new URL("../scripts/mcp.mjs", import.meta.url).pathname], {
    input:
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n" +
      JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "super_edit", arguments: { patches: [{ file: target, find: "beta", replace: "B" }] } },
      }) + "\n",
    encoding: "utf8",
  });
  const mismatchReport = JSON.parse(mismatch.stdout.trim().split("\n")[1]).result.content[0].text;
  check("mismatch report shows found count", /found 2 matches, expected 1/.test(mismatchReport), mismatchReport);
  check("mismatch report shows match locations", /found at: line 2: beta; line 4: beta/.test(mismatchReport), mismatchReport);
  check("mismatch report writes nothing", readFileSync(target, "utf8") === "alpha\nbeta\ngamma\nbeta\n");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
