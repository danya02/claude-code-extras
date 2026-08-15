# timings

Claude has no clock. Within a turn it cannot tell a 200 ms `Read` from a 40-minute
training run, and between turns it cannot tell whether you replied instantly or
came back the next morning. This plugin measures the three gaps that matter and
hands them back as context:

- **how long you were away** — the gap between Claude's last response and your next prompt;
- **how long the assistant turn took**, split into time spent in tools and time spent thinking;
- **how long individual tool calls ran** — any tool, not just `Bash`.

## What it injects

At each prompt, one hidden line:

```
<timing>now=2026-08-15T20:31:04+02:00 idle=5m02s prev_turn=4m12s (tools 2m30s: Bash×3 2m10s, WebFetch 20s; model ~1m42s)</timing>
```

And after any tool call that crossed the threshold:

```
<timing>Bash took 2m10s.</timing>
```

Roughly 40–70 tokens per turn. Everything is thresholded, so a fast turn with fast
tools injects nothing at all.

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
| `show_clock` | `true` | Include local date/time with UTC offset in each block. |
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
- State lives in `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>/` and is deleted at
  `SessionEnd`; stray directories are swept after 7 days.

## Tests

```
node plugins/timings/tests/run.mjs
```

Drives the real script as a subprocess, one process per event, exactly as Claude
Code does — including the orphaned-stamp, path-traversal, and malformed-input
cases, plus the overhead benchmark.

## Known gaps

- Tool calls made inside a subagent are attributed to the session's turn totals,
  not separated out by `agent_type`.
- A turn interrupted with Esc produces no `Stop`, so its tool time is folded into
  the next prompt's report rather than labelled as its own turn.
