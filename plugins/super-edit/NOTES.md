# Why this plugin exists

Findings from an investigation on 2026-08-17, across 113 session transcripts in
`~/.claude/projects` plus direct probing of the running harness.

It started from a handoff document written on 2026-08-14 by a session in another
repo, which had noticed the same habit from the inside. That document was
temporary and is not kept here; the parts of it worth keeping are quoted below,
including the two claims it got wrong.

## What was actually happening

977 Bash turns across all sessions write a file. Most are legitimate: 382 target
`/tmp` or the scratchpad, 312 are heredoc-into-an-interpreter (running a script,
not editing one). **356 are genuine in-place edits of tracked project files.**

Sorted by why the model reached for the shell:

1. **Batching.** Several non-adjacent changes in one file: N `Edit` round-trips,
   or one `python` block. The largest bucket.
2. **Edit chained with its own verification (~114, 32%).** This is the pattern
   the original handoff missed entirely, and it is *good* engineering being
   taxed:
   ```
   sed -i 's/.../.../' tools/plot_checkpoint_paths.py && .venv/bin/python tools/plot_checkpoint_paths.py sweep_data --out figures
   ```
   `Edit` structurally cannot edit-and-then-test in one call, so the shell wins
   on latency every time.
3. **Momentum (~49–140).** No capability gap at all — python heredocs that are
   byte-for-byte what `Edit` does:
   ```python
   p=pathlib.Path("tools/check_dead_ends.py"); s=p.read_text()
   s=s.replace("        if self.branchy and var in BRANCHING_EFFECTS:",
               "        if var in self.branchy and var in BRANCHING_EFFECTS:")
   ```
   Several even write `assert old in s`, hand-rolling `Edit`'s uniqueness check.
4. **Structured data (~62).** `node -e` doing `JSON.parse` → mutate →
   `writeFileSync`. Editing JSON as text really is worse than editing it as a tree.

## The resync mechanism, as actually measured

When a file changes outside the tracked tools, the harness *may* inject a
`<system-reminder>` about it. When it does is not obvious, and getting it wrong
is what produced the handoff's bad cost estimate.

| Prior state of the file | Out-of-band write | Result |
| --- | --- | --- |
| Written via `Edit`/`Write` (fresh snapshot) | any writer | **±8-line window** around each changed hunk is injected, and the snapshot is **refreshed** |
| Only `Read`, never written | any writer | **No injection.** The next `Edit` is refused with "modified since read" → forced **full re-Read** |
| Snapshot already stale | any writer | Nothing |

Three consequences, all of which change the design:

- **It is a diff window, not the whole file.** The handoff claimed the full file
  comes back ("roughly 30× the tokens"). It does not. Changing line 45 of a
  60-line file injected lines 37–53; changing line 5 injected lines 1–13.
  An early estimate of 1–2M wasted tokens across all sessions assumed full-file
  reinjection and is wrong by more than an order of magnitude.
- **The injection refreshes the snapshot, so it is self-healing.** A native
  `Edit` immediately after an injection succeeds with no re-Read. The injection
  is therefore the *cheap* path.
- **The genuinely expensive case is the silent one.** A `sed` on a file that was
  only ever `Read` produces no warning at all, and the cost lands later as a
  forced full re-Read of (mean) a 31 KB file. Quiet, not loud, is what to worry
  about.

### Writer identity is not tracked

A disowned background process, not a child of the tool call, triggers the
injection identically to an inline `sed`. The harness compares its own snapshot
against disk at request time; it has no idea who wrote. This is why the notice
says the change came from "the user or by a linter" and asserts the user is
"already aware" — **both false when the writer was the model's own Bash call**,
and it instructs the model not to mention it. That is a live mechanism for
confidently misinforming the user, and it is how this whole issue first surfaced.

**Therefore an MCP server's writes behave exactly like `sed`'s** — an MCP server
is just another process. **Confirmed empirically on 2026-08-17**, by driving a
separate headless Claude session (`claude -p`, Haiku, with this server
registered):

- A `super_edit` write to a file holding a fresh `Edit` snapshot produced the
  resync notice with the same ±8-line window (lines 37–53 for a change at 45).
- The objective confirmation: in a second run the agent called `Edit` on the file
  **after** the `super_edit` write and **without re-reading**. It succeeded, and
  all three changes survived in the final file. That is only possible if the
  harness resynced its snapshot from the MCP write — had the write gone
  undetected, the stale snapshot would have refused the edit or clobbered the
  MCP change. This evidence comes from harness-generated tool results, not from
  the model's self-report.

So on a file with a fresh write snapshot, the harness does cover us. On a file
that was only ever `Read`, it says nothing at all — which is why `super_edit`
returns the changed regions itself.

### Not measurable after the fact

The resync notice is injected at request time and **never persisted to the
JSONL**. A transcript scan finds zero occurrences even in sessions where it
certainly fired. Any future audit of this has to probe a live session.

## Things the handoff got right, and one to drop

- **Drop its proposal #1.** "Does a partial `Read` satisfy the `Edit`
  precondition?" — it does. Reading lines 10–14 of a 40-line file unlocked an
  edit at line 30, far outside the window. The cheap correct path already exists.
- Its proposals #3 (anchored match), #4 (multi-edit) and #5 (line-anchored) are
  real, and #4 is the biggest bucket.
- Its "momentum" case is real and no tool schema can fix it — that needs a nudge
  at the point of use, which is what the hook in this plugin is for.

## What we built, and why it is shaped this way

**`super_edit` (MCP tool).** One call, a sequence of patches, possibly across
several files.

- **Regex with an expected match count** is the most valuable part, and it is a
  correctness feature `Edit` lacks rather than a convenience. Asking for 10
  replacements and finding 8 means the model's recollection of the file is
  wrong; the right response is to re-read, not to apply 8 changes. `Edit`'s
  `replace_all` silently applies whatever it finds.
- **Atomic vs independent.** Atomic validates every patch against every file
  before writing anything, so a half-applied batch is impossible. Independent
  exists for the case Danya raised: on a large batch you want to know *which*
  row failed, which an all-or-nothing failure hides.
- **No `then_run`.** It would mean reimplementing Bash's timeout handling and
  auto-backgrounding, and the measurement above removed its main justification —
  the saved round-trip no longer costs a file reinjection. It also cannot be
  made meaningfully atomic with the edits.
- Patches to the same file apply **sequentially against an in-memory buffer**, so
  a later patch sees earlier patches' results. Expected counts are evaluated
  against the content as of that patch.

**The Bash hook.** Best-effort detection of in-place edits, as a non-blocking
nudge. It cannot be exhaustive — the sheer variety in the transcripts
(`sed -i`, `perl -pi`, python `write_text`, `node writeFileSync`, `cat > f <<EOF`,
plain `>` redirects) means heuristics will miss cases and occasionally
false-positive. That is acceptable for a nudge and would not be for a block, so
it never blocks.

It warns only for the first few detections per session, because the momentum
case is a habit that needs interrupting once, not a lecture on every call. The
escape hatch is a counter file holding the number of warnings remaining:

- **delete it** → reset to the full budget, keep getting warnings;
- **write `0` into it** → expire it early and stop getting them.
