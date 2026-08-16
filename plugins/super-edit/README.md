# super-edit

Batch file patches in one call, with a **predicted match count** per patch — plus
a non-blocking nudge away from in-place shell edits.

`NOTES.md` has the measurements this is built on, including how the harness
actually reacts to writes it did not make. Read it before changing anything here;
several obvious-looking "improvements" are ruled out by findings in it.

## The tool

```jsonc
{
  "patches": [
    { "file": "src/app.rs", "find": "let mut x", "replace": "let x" },
    { "file": "src/app.rs", "regex": "\\blet\\b", "replace": "const", "expect": 10 },
    { "file": "Justfile",   "find": "old", "replace": "new", "expect": 2 }
  ],
  "mode": "atomic"          // or "independent"
}
```

- **`find`** matches literal text; **`regex`** is a JS regular expression with
  `$1` backreferences. Exactly one of the two per patch.
- **`expect`** is how many matches you believe are there. Defaults to 1 for
  `find`, and is **required** for `regex`. A mismatch fails the patch rather than
  applying it — if you expected 10 and there are 8, your recollection of the file
  is wrong, and the right move is to re-read it, not to change 8 things. This is
  the part `Edit` genuinely lacks: `replace_all` silently applies whatever it
  finds.
- **`mode: "atomic"`** (default) writes nothing unless every patch succeeds, and
  still reports every patch so you see all the failures at once, not just the
  first. **`mode: "independent"`** applies what works and names each failure by
  index — for large batches where you need to know *which* row was wrong.
- Patches to the same file apply in order against an in-memory buffer, so a later
  patch sees earlier ones' results.

The result echoes the changed regions back. That is not decoration: on a file the
session has only `Read` and never written, the harness does not notice an
external write at all, so this report is the only accurate view of the file.

There is deliberately no `then_run`. See NOTES.md.

## The hook

`PreToolUse` on `Bash`. Spots in-place edits (`sed -i`, `perl -pi`, python
`write_text`, `node writeFileSync`, `cat > f <<EOF`, plain redirects) and adds a
one-paragraph nudge. It **never blocks** — detection is heuristic, shell edits are
sometimes right, and a nudge that cries wolf gets ignored.

It warns only a few times per session. The message names a counter file holding
the number of warnings remaining:

- **write `0` into it** → stop the warnings early;
- **delete it** → reset to the full budget and keep getting them.

## Testing

```sh
node plugins/super-edit/tests/run.mjs   # logic, heuristics, MCP protocol
```

`tests/MANUAL.md` covers what a unit test cannot: how a live session reacts to
these writes. Checks 1–4 there can be driven headlessly; 5 onward need a human.

For iterating without the plugin install/version dance, register the server
directly:

```sh
claude mcp add super-edit-dev --scope local -- node "$PWD/plugins/super-edit/scripts/mcp.mjs"
```
