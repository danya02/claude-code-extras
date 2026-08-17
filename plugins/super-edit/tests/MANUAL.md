# Manual tests: a human and an agent, one step each

`run.mjs` covers the patch logic, the hook's detection heuristics and the MCP
protocol in isolation. What it cannot cover is the thing this plugin was built
around: **how the harness reacts to a write it did not make.** That only exists
in a live session, and the notice involved is never written to the transcript
(see NOTES.md), so it has to be observed as it happens.

## Before you start: are you running the version you think you are?

MCP servers and hooks are both bound when a session starts. Updating the plugin
**inside** a session leaves that session on the old code while `/plugin` reports
the new version.

1. Bump `version` in `.claude-plugin/plugin.json` — the install cache is keyed on
   it, so an unchanged version silently keeps the old copy.
2. Update the plugin, then **quit and start a new session**.
3. In the new session, confirm the agent can see a tool named `super_edit`. If it
   cannot, nothing below means anything yet.

## Checks 1–4 can be automated

A headless session is a real Claude Code session with the same file tracking, so
most of this file can be driven without a human:

```sh
claude -p "<the steps>" --model claude-haiku-4-5-20251001 \
  --output-format stream-json --verbose --permission-mode acceptEdits \
  --allowedTools "Read,Edit,mcp__super-edit-dev__super_edit"
```

Two traps, both learned the hard way:

- **`stream-json` does not surface the resync notice as its own record.** Grepping
  the stream for "modified, either by the user" only ever matches the *model
  quoting it back*. Asking the agent whether it saw a reminder is a
  model-introspection test, and a cheap model is least reliable exactly there.
- **Use a discriminator the harness answers instead.** After the `super_edit`
  write, have the agent call `Edit` on the same file *without re-reading*. The
  tool result is harness-generated and objective: success with the MCP change
  intact proves the snapshot resynced; a "modified since read" refusal proves it
  did not.

Check 5 onward still needs a human, because they turn on approving a real call
and editing a counter file mid-session.

Each check has a **human** part and an **agent** part. The agent should quote
what it saw **verbatim**, and say explicitly whether it came from injected
context, a tool result, or a file it read — an agent that has just read this
file has all the example text in its context and can quote it back in good
faith without having observed anything.

---

## 1. The headline question: does an MCP write trigger the harness resync?

This is the check the whole design rests on. The prediction in NOTES.md is that
`super_edit`'s writes behave exactly like `sed`'s, because the harness compares
its own snapshot against disk and has no idea who wrote.

- **Agent:** create `/tmp/se-probe.txt` with 60 numbered lines. `Read` it, then
  change one line with the **`Edit`** tool — this is what gives the harness a
  fresh write snapshot, and without it the rest of the check tests nothing.
- **Agent:** now change a *different* line with `super_edit`.
- **Agent:** report whether a `<system-reminder>` arrived saying the file "was
  modified, either by the user or by a linter", and if so, quote the line range
  it showed.

**Expected:** the notice fires, showing roughly ±8 lines around the changed line
— not the whole file.

**If it does not fire:** that is the more interesting result. It would mean MCP
writes are tracked differently from shell writes, and the "echo the changed
regions back" behaviour in `mcp.mjs` may be redundant. Record which it was.

## 2. The silent case, which is the expensive one

- **Agent:** create a second probe file, `Read` it, and do **not** `Edit` it.
- **Agent:** change a line with `super_edit`.
- **Agent:** report whether any notice arrived.
- **Agent:** now try a native `Edit` on that file.

**Expected:** no notice at all, and the `Edit` is refused with "File has been
modified since read". This is the case the tool's own changed-region report
exists to cover — confirm that report was present in the `super_edit` result and
that it was enough to know what the file now contains.

## 3. Atomic really is all-or-nothing

- **Agent:** call `super_edit` with three patches on a real file, where the
  second one has a deliberately wrong `expect` count.
- **Human:** `git diff` the file, or check its mtime.

**Expected:** the file is untouched, and the report names all three patches —
the failing one with its actual-vs-expected count, and the other two as ones
that *would* have applied. A report that only mentions the failure is a bug.

## 4. Independent mode identifies the bad row

- **Agent:** same three patches, `mode: "independent"`.

**Expected:** patches 1 and 3 applied, patch 2 reported by **index** with the
count it actually found. The point of this mode is that on a twenty-patch batch
you learn which entry was wrong; check the index is unambiguous.

## 5. The hook fires, and the escape hatch works

- **Agent:** run `Bash(command="sed -i 's/foo/bar/' some-real-project-file")`.
- **Human:** approve it.
- **Agent:** quote the injected nudge verbatim, including the remaining-warning
  count and the counter file path.
- **Agent:** repeat the same call. The count should decrease by one each time.
- **Human:** `echo 0 > <the counter file path from the message>`.
- **Agent:** run the `sed` again.

**Expected:** no nudge at all after the `0`. Then:

- **Human:** delete the counter file.
- **Agent:** run the `sed` once more.

**Expected:** the nudge returns with the full budget of 5. If deleting the file
silences it instead, the two escape hatches are inverted.

## 6. The hook stays out of the way

Run each of these and confirm **no** nudge appears. These are all legitimate and
all appear frequently in real transcripts; a nudge on any of them is a
false positive worth fixing, because a nudge that cries wolf gets ignored.

- **Agent:** `Bash(command="git commit -q -F - <<'EOF'\nsome message\nEOF")`
- **Agent:** `Bash(command="python3 - <<'EOF'\nprint(sum(range(10)))\nEOF")`
- **Agent:** `Bash(command="sed -i 's/a/b/' /tmp/throwaway.txt")`
- **Agent:** `Bash(command="cargo build 2>&1 | tail -5")`

## 7. Does the nudge actually change behaviour?

The momentum case from NOTES.md is the one no tool schema can fix, so it is
worth checking the nudge lands as a nudge and not as noise.

- **Human:** in a fresh session, ask for a one-line change to a file the agent
  has already written with `Edit` this session — the case with no justification
  for a shell edit whatsoever.
- **Human:** observe which tool it reaches for, without hinting.

There is no pass/fail here, and one run proves nothing. Record it over several
sessions; if the shell still wins on a file that is fully in context, the answer
is prompt guidance, not tooling.

## 8. The budget refills when the advice is taken

Added after a live session went silent on the one call it was built to catch:
the budget had been spent earlier and never came back, so the longest editing
session — the one that needed the nudge most — got none of it.

- **Agent:** trigger the nudge until the message says `0 more warnings`.
- **Agent:** confirm a further `sed -i` produces nothing.
- **Agent:** make any successful `super_edit` call.
- **Agent:** run the `sed -i` again.

**Expected:** the nudge is back, with the full budget. Heeded advice refills;
ignored advice still spends. If a `Read` or an `Edit` also refills it, the
`PostToolUse` matcher is too broad — only `super_edit` counts as heeding.

## 9. Gated-call detection, which needs a real dialog

The point of this one is that **a permission prompt is invisible to a hook, but
the wait for it is not.** Requires a prompting mode; in `bypassPermissions` there
is nothing to detect and the correct result is silence.

- **Human:** start a session in **Edit automatically** (`acceptEdits`) with the
  tool *not* in any `permissions.allow` list.
- **Agent:** make a `super_edit` call.
- **Human:** approve it — **as fast as you can**, without reading. This is the
  case the threshold has to survive.
- **Agent:** report whether injected context arrived telling you to relay an
  allowlisting suggestion, and quote the measured wait it names.

**Expected:** it fires, and the reported wait is **6s or more even on an instant
approval**. Measured on this harness, a gated call carries ~6s of latency before
the dialog reaches the human at all: 7439 ms for an immediate approval, 12904 ms
for a deliberate ~10s wait. An ungated call is single-digit milliseconds.

That gap is the whole basis for `GATED_MS` being 3000. **If this check ever
reports a wait near or under 3s, the floor is not universal and the threshold is
wrong** — that is the result worth recording, more than a pass.

- **Agent:** make a second `super_edit` call and approve it the same way.

**Expected:** silence. The advice is actionable once per session.

## 10. The reload gotcha, three ways

Three separate mechanisms in this system fail identically, and each one has
already cost a debugging session:

- **permissions** — approving via the dialog's *project* option writes
  `.claude/settings.json` correctly and does **not** apply until the harness
  reloads; the next call prompts again. The *session*-scoped option applies now.
- **hooks** — registered at session start. Adding one mid-session does nothing,
  silently: the script is never invoked, so it looks like a broken script.
- **MCP servers / plugin versions** — see the top of this file.

To check the permission half:

- **Human:** with the tool already listed in `.claude/settings.json`, start a
  **fresh** session in `acceptEdits`.
- **Agent:** make a `super_edit` call.

**Expected:** it does **not** prompt. If it still does, then a project-scoped
allow is not honoured for MCP tools at all, and check 9's stage-2 advice is
wrong — try a server-level rule (the name with its `__super_edit` suffix
removed) and record which form works. One live session reported still being
prompted here after a restart, so treat this as **open, not settled.**
