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

The budget is spent by warnings that are **ignored**. A `PostToolUse` pass on
`super_edit` refills it, so taking the advice buys back the nudge. Without that,
the budget ran out partway through a long editing session and the hook was
silent for the rest of it — measured, not hypothetical — which is precisely the
session that needed it.

## Permissions

`super_edit` is an MCP tool, so in any mode that surfaces tool calls for approval
(**Edit automatically**, **Ask every time**) it prompts on **every call**, while
the `sed -i` it exists to replace runs unprompted. That gradient is backwards on
risk: the tool that declares match counts, applies atomically and fails loudly is
the only one that costs a human decision.

Pre-approve it to remove the interrupt:

```jsonc
// .claude/settings.json
{ "permissions": { "allow": ["mcp__plugin_super-edit_se__super_edit"] } }
```

Two gotchas, both measured:

- Approving via **"allow for this project"** writes that file but does **not**
  take effect until the harness reloads — the call right after approval prompts
  again. Choose the **session**-scoped option for immediate effect, or add the
  line above and restart.
- The plugin-registered name embeds the plugin *and* server name
  (`plugin_super-edit_se` — server key `se`, kept short for exactly this
  reason), with a double underscore before the tool. Registering the server at
  user scope instead gives the shorter `mcp__super-edit__super_edit`, which is
  what sessions guess first.

## Testing

```sh
node plugins/super-edit/tests/run.mjs   # logic, heuristics, MCP protocol
```

`tests/MANUAL.md` covers what a unit test cannot: how a live session reacts to
these writes. Checks 1–4 there can be driven headlessly; 5 onward need a human.

For iterating without the plugin install/version dance, register the server at
user scope — it runs the working tree directly, so edits are live immediately:

```sh
claude mcp add super-edit --scope user -- node "$PWD/plugins/super-edit/scripts/mcp.mjs"
```
