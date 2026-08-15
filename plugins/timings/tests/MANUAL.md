# Manual tests: a human and an agent, one step each

Some of this plugin's behaviour only exists when a real person interrupts a real
tool call, approves a real permission prompt, or walks away from a real session.
`run.mjs` fakes those events; these five checks do not.

## Before you start: are you running the version you think you are?

Hooks are loaded when a session starts. Updating the plugin **inside** a session
leaves that session running the old code, while `/plugin` cheerfully reports the
new version — this has already cost one full test round. So:

1. Update the plugin (`/plugin`), then **quit and start a new session**.
2. In the new session, check the block on your first message reads
   `now=HH:MM:SS`. If it reads `now=2026-08-16T…+03:00`, you are on 0.1.x and
   nothing below means anything yet.

The versioned install path is `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`,
and every version ever installed stays there, so it is worth confirming which one
`installed_plugins.json` actually points at.

Each check below has a **human** part and an **agent** part. The agent should
quote what it saw **verbatim**, and say explicitly whether it came from its
injected context or from a file it read — an agent that has just read this file
has all the example blocks in its context and can quote them back in good faith.

If the agent sees nothing, check the event log at
`~/.claude/plugins/data/timings-*/sessions/<session_id>/events.ndjson`. It
survives the session ending, so it can be read after the fact. If the event is
not in the log, the hook is not firing — a different problem from the hook
computing the wrong thing.

---

## 1. Interrupt: the impatient case

- **Agent:** run `Bash(command="for i in $(seq 1 25); do echo $i; command sleep 1; done")`.
- **Human:** approve it, let it run about 10 seconds, then interrupt with Esc and
  send any message.
- **Agent:** should see `<timing-interrupt>` naming `Bash`, with a span of roughly
  the approval wait + 10s + typing time, described as an upper bound. Should
  *not* see an `idle=` field.

The point of this one is that the span is **not** 10 seconds and does not claim
to be. If the agent quotes it back as "you waited N seconds", the wording has
regressed.

## 2. A gated call is not a slow tool

- **Agent:** do something trivially fast that still needs approval — a `Write`
  to `/tmp` works, since it is outside the project.
- **Human:** leave the permission prompt sitting for at least 30 seconds, then
  approve. Note that the prompt only appears once you stop typing.
- **Agent:** should see `gated on the user's approval`, a `Ns before the prompt
  reached the user` figure, and `ran at most Ns`. It must **not** report a plain
  `Write took 1m42s` — that reads as a slow tool and is the bug this replaced.

A gated call is reported even when it is far below the tool threshold, so
silence here is a failure, not a pass.

## 3. The scratchpad hint

- **Agent:** run a command that takes at least 45 seconds and produces output.
- **Human:** approve it and let it finish.
- **Agent:** should see `<timing-tool>` with a `start→end` clock pair and the
  reminder to tee output to a log or run it in the background.

## 4. Compaction across a long gap

- **Human:** compact the context (`/compact`), then leave the session alone for
  at least a few minutes — ideally overnight, which is the case this exists for.
  Come back and send any message.
- **Agent:** should see `<timing-compaction>compacted Nh ago, at HH:MM:SS`, with
  the date attached if the compaction was on an earlier day. Should see it
  exactly once: a second message must not repeat it.

## 5. Resume

- **Human:** end the session and resume it later with `claude --resume`.
- **Agent:** should see `<timing-session>source=resume`, and if the session was
  dormant longer than `session_gap_seconds`, how long it was idle and when it was
  last active.

---

## What a good report from the agent looks like

> I saw `<timing-interrupt>Bash was started 1m04s before the user's next message
> and never finished, so it was interrupted. At most 1m04s of that was the call
> running -- the span also covers the time the user spent typing, so treat it as
> an upper bound, not a measurement</timing-interrupt>`, and no `idle=` field.
>
> You said you gave it ~10s, so the bound is behaving as intended: it is much
> larger than the true run, and labelled as such.
