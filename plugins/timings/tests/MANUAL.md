# Manual tests: a human and an agent, one step each

Some of this plugin's behaviour only exists when a real person interrupts a real
tool call, approves a real permission prompt, or walks away from a real session.
`run.mjs` fakes those events; these five checks do not.

Run them in a session with the plugin installed. Each has a **human** part and an
**agent** part — the agent should report what it saw in its context, quoting the
block verbatim, and the human confirms it matches.

If the agent sees nothing, check `events.ndjson` in the session's state directory
(`~/.claude/plugins/data/timings-*/sessions/<session_id>/`): if the event is not
in the log, the hook is not firing, which is a different problem from the hook
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

## 2. Approval wait is not tool time

- **Agent:** run a trivially fast command that needs approval, e.g.
  `Bash(command="cat README.md")`.
- **Human:** leave the permission prompt sitting for at least 30 seconds, then
  approve.
- **Agent:** should see the call reported as taking well under a second, with
  `plus 30s waiting for approval` — not as a 30-second command. Below the tool
  threshold it may report nothing at all, which is also correct; check the turn
  breakdown on the next prompt for `your approvals 30s`.

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

> I saw `<timing-interrupt>Bash was started 1m04s before this message and never
> finished, so it was interrupted. At most 1m04s of that was the call running --
> the span also covers your typing and any wait for approval, so treat it as an
> upper bound, not a measurement</timing-interrupt>`, and no `idle=` field.
>
> You said you gave it ~10s, so the bound is behaving as intended: it is much
> larger than the true run, and labelled as such.
