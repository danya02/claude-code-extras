# timings

Claude has no clock. Within a turn it cannot tell a 200 ms `Read` from a 40-minute
training run, and between turns it cannot tell whether you replied instantly or
came back the next morning. This plugin measures the three gaps that matter and
hands them back as context:

- **how long you were away** — the gap between Claude's last response and your next prompt;
- **how long the assistant turn took**, split into time spent in tools and time spent thinking;
- **how long individual tool calls ran** — any tool, not just `Bash`.

## What it injects

Each block is tagged by what it is, because the tag is the first thing Claude
matches on and several can land in one context window:

| Tag | When | Example |
| --- | --- | --- |
| `timing-prompt` | every prompt | `<timing-prompt>now=20:31:04 date=2026-08-15 idle=5m02s prev_turn=4m12s (tools 2m30s: Bash×3 2m10s; your approvals 40s; model ~1m02s)</timing-prompt>` |
| `timing-tool` | after a slow tool call | `<timing-tool>Bash took 2m10s (20:28:54→20:31:04, plus 40s waiting for approval).</timing-tool>` |
| `timing-interrupt` | a call that never finished | `<timing-interrupt>Bash was started 1m02s before this message and never finished, so it was interrupted…</timing-interrupt>` |
| `timing-compaction` | first prompt after a compaction | `<timing-compaction>compacted 9h12m ago, at 22:10 on 2026-08-15</timing-compaction>` |
| `timing-session` | a resumed, forked or dormant session | `<timing-session>source=resume idle for 3d, last active 18:40 on 2026-08-13</timing-session>` |

`interrupt` and `compaction` get their own tags rather than becoming fields on
`timing-prompt` because both change what Claude should *do* — retry versus
rethink, and treat a summarised context as stale — while a field in a list reads
as trivia.

Roughly 40–70 tokens per turn. Everything is thresholded, so a fast turn with fast
tools injects nothing at all.

### Time is relative, with a clock to pin it to

There is no ISO datetime anywhere. Almost everything here is minute- or
hour-scale, so blocks carry a duration (`5m02s`) plus a bare clock reading
(`20:31:04`), and the date only where it earns its place: the first prompt of a
session, a day rollover, and any past instant that was not today. A field that
never changes a decision is worse than absent — it teaches the reader to skim the
block that also carries the fields that do.

### Approval time is not tool time

`PreToolUse` fires *before* the permission prompt, so a naive stopwatch reports a
`cat` that waited 40 seconds for your approval as a 40-second command. The
`PermissionRequest` event carries the same `tool_use_id`, so the wait is
subtracted from the call and reported separately — as `plus 40s waiting for
approval` on the call, and `your approvals 40s` in the turn breakdown.

### Interrupts are reported as a bound, not a measurement

No hook fires when you interrupt a tool call: `Stop` never arrives and no
`PostToolUse` lands, so the stamp written at `PreToolUse` is simply left behind.
By the next prompt nothing is in flight, so an orphaned stamp *is* an interrupted
call. What that gives is the span from the call starting to your next message —
which also contains any approval wait and the time you spent typing. It is
reported as an explicit upper bound, because the tempting reading ("you waited
60s") is wrong and is exactly the number Claude would otherwise reason from.

For the same reason, `idle=` is suppressed after an interrupt: it is measured
from the last `Stop`, which never happened, so it would span Claude's own
working time and read as you being away.

### The event log

Every hook event is appended to `events.ndjson` in the session's state
directory, including events this plugin has no handler for:

```
{"at":1786833001164,"clock":"01:30:01","ev":"PreToolUse","tool":"Bash","id":"toolu_01RtXk…"}
```

Which events a given build actually fires, in what order, and how far apart is
not something the documentation settles — this is how you find out. It is also
the fastest way to check whether a hook you just registered is firing at all.

The `model ~` figure is wall time minus tool time, so it is an estimate: parallel
tool calls make the tool total exceed the turn's wall clock, and compaction lands
inside it. It is right to within a few seconds on ordinary turns, which is enough
to answer "have I already waited long enough?" without reaching for `sleep`.

## Install

```
/plugin marketplace add gmatiukhin/claude-code-extras
/plugin install timings@claude-code-extras
```

## Configuration

Set at install time, editable later via `/plugin`:

| Option | Default | Effect |
| --- | --- | --- |
| `tool_threshold_seconds` | `10` | Minimum duration for a tool call to be reported. `0` reports every call. |
| `idle_threshold_seconds` | `10` | Minimum gap since the last response to report. |
| `turn_threshold_seconds` | `20` | Minimum turn duration to report a breakdown for. |
| `clock_pair_seconds` | `60` | Duration at which a tool call is also pinned to the wall clock as `start→end`. |
| `scratchpad_hint_seconds` | `45` | Duration after which a `Bash` call is reminded to log its output somewhere an interrupt cannot discard. |
| `session_gap_seconds` | `600` | Dormancy needed before `SessionStart` reports a gap. |
| `event_log` | `true` | Append every hook event to `events.ndjson`. |
| `show_clock` | `true` | Include clock time, plus the date on day rollover. |
| `visible_idle` | `true` | Also show the idle gap to you as `[after 5m 02s]`, not only to Claude. |
| `show_hook_overhead` | `false` | Append this plugin's own measured cost to the turn breakdown. |
| `debug_log` | `false` | Append internal errors to `errors.ndjson` in the plugin data directory. |

## Cost

One `node` process per hook event, measured at **~60 ms per invocation** on this
machine (`tests/run.mjs` asserts it stays under 250 ms), almost all of it Node
startup. A turn with ten tool calls therefore spends roughly 1.2 s in hooks, in
parallel with nothing else. Turn on `show_hook_overhead` to see the real figure
for your machine in the turn breakdown rather than trusting this paragraph.

## Design notes

- **Zero dependencies**, one file, no `jq` — hooks that silently do nothing on a
  machine without `jq` are worse than no hooks.
- **Never blocks.** Every failure path exits 0 with no output. Malformed stdin,
  a missing data directory and unknown events are all no-ops.
- **No lost measurements under parallelism.** Tool stamps are one file per
  `tool_use_id` and completed calls are appended to a log, so concurrent tool
  calls cannot clobber a shared JSON object.
- **Stamps get consumed, not swept.** `PostToolUse` does not fire for a denied or
  failed call, so `PostToolUseFailure` and `PermissionDenied` are hooked too. A
  stale sweep still runs as a backstop for interrupts.
- **`SessionEnd` is not the end of the session.** Ctrl+C prints
  `claude --resume <id>`, and the gap across that resume is the most valuable
  thing here — it is precisely the case where the transcript reads as if no time
  had passed. So `SessionEnd` drops only turn-scoped scratch and keeps the state
  the resume is measured against, along with the event log. State lives in
  `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>/` and whole directories are swept
  after 7 days at `SessionStart`, which is what bounds the growth.
- **The manifest does not declare `hooks/hooks.json`.** That path is loaded
  automatically, and naming it in `manifest.hooks` as well is a duplicate load
  that Claude Code rejects outright — leaving the plugin installed, enabled, and
  running no hooks at all.

## Tests

```
node plugins/timings/tests/run.mjs
```

Drives the real script as a subprocess, one process per event, exactly as Claude
Code does — including the orphaned-stamp, path-traversal, and malformed-input
cases, plus the overhead benchmark.

Some behaviour cannot be tested this way, because it depends on a real person
interrupting a real tool call at a real moment. [`tests/MANUAL.md`](tests/MANUAL.md)
is a short script for a human and an agent to run together, one step each.

## Known gaps

- **Queued messages are invisible.** A message typed while Claude is working
  fires no `UserPromptSubmit` — verified: `lastPromptAt` does not move — so it
  cannot be timed. All Claude can rely on is the framing: a queued message was
  written without sight of the output it arrived next to.
- **An interrupted call's stdout is gone.** The harness returns a rejection, not
  the partial output, and no hook can recover it. Hence the scratchpad hint on
  long `Bash` calls: the fix is to not have the output only in the tool result.
- Tool calls made inside a subagent are attributed to the session's turn totals,
  not separated out by `agent_type`, though `SubagentStart`/`SubagentStop` are
  now logged and every event carries `agent_id` to build it on.
- Interrupt spans include the user's typing time and cannot be tightened
  further; they are labelled as bounds rather than corrected.
