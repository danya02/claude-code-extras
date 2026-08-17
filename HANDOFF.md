# Handoff: anomaly-relative timings, quota as a decision input, and an interruption bug

Written 2026-08-17, at the end of a session that (a) fixed three super-edit UX
defects — committed as `f6e7ec7`, done, not part of this handoff — and (b) worked
out why the `timings` and `quota` hooks, though functioning correctly, almost
never change what the model does. Part (b) is what follows. Nothing here is
implemented yet.

## The problem this is trying to solve

Both hooks work. Both inject accurate numbers on every turn. In a two-hour
session the model referenced them essentially never, and when it did claim to be
adapting ("that's why I've been terse") it had in fact just posted a table, three
headed sections and a commit message longer than its diff. The number changed
what it *claimed*, not what it *did*.

Diagnosis, which the user and the model converged on:

**A bare value is trivia; a value with a baseline is information.** `93%` maps
onto no decision. `prev_turn=15m48s` cannot be surprising, because nothing says
what is usual. If nothing is ever surprising, nothing is ever load-bearing, and
uniform-every-turn output becomes wallpaper — the same alert-fatigue dynamic the
`super-edit` warning budget was designed around, and the reason that budget now
refills on heeded advice rather than depleting monotonically.

One concrete miss worth recording, because it shows the failure is not abstract:
the timing line reports `prev_turn=2m23s (tools 5s; model ~2m18s)`. That split is
direct evidence that this session's burn came from *generation*, not from tool
latency — which was the exact subject under discussion two turns later. The data
was present on every single turn of that discussion and went unused.

## Design conclusions

### Anomaly detection, not reporting

The user's proposed shape, which is the right one:

```
<timing-tool>That Bash tool took 5m12s.</timing-tool>
<timing-admonition>This is 15.4x longer than the median Bash tool call in this session.</timing-admonition>
```

Two tags with **different firing rules**, and that split is what makes cold start
tractable (see below):

- `<timing-tool>` is a **fact**. Fires on an absolute floor, needs no history.
- `<timing-admonition>` is a **comparison**. Needs a baseline, stays silent until
  it has one.

### Which statistic

- **Work in log space.** Durations are multiplicatively distributed. `2×` means
  the same thing at 1s and at 100s; `+30s` does not. Raw-second statistics are
  dominated by the tail.
- **Median + MAD, not mean + σ.** The outliers being detected are the same ones
  that would inflate σ and hide themselves. Modified z-score,
  `0.6745 × (x − median) / MAD`, on log durations; the conventional cut is
  `|z| > 3.5` (Iglewicz–Hoaglin).
- **Report the ratio, not the z-score.** "15× the median" communicates; "z = 4.1"
  does not. The statistic is for the detector, the ratio is for the reader.
- **Ratio alone will spam.** If the median `Bash` is 0.3s, an unremarkable 5s call
  is 16× the median. The admonition must require a conjunction: *anomalous by
  z-score* **and** *above an absolute floor*. Nothing under ~30s deserves a
  comparison no matter how many multiples it is.
- **Bucket per tool name**, and for `Bash` consider sub-bucketing on the first
  token of the command (`git`, `cargo`, `node`, …). Bash-as-one-bucket is bimodal,
  which inflates MAD and makes the detector conservative — it fails toward
  silence, which is the right direction, but sub-bucketing recovers sensitivity
  cheaply.

### Thresholds: calibrate, do not guess

The transcripts are on disk with timestamps. Mine them for the real distribution
of tool and turn durations and pick the cuts from actual quantiles. This is the
cheap half of the work and it converts every number below into a measurement.

Starting points pending that: **30s** floor for tools, **3.5** modified-z, **2min**
floor for turns, **8–10** samples minimum in a bucket before any admonition.

### Quota is quantized — do not run anomaly detection on it

The usage endpoint reports integer percent, so per-turn burn is mostly a 0/1
draw. The turn where it clicks from 0 to 1 is not more expensive than the three
before it, and a ratio statistic on that signal is noise amplification
("∞× the previous turn" — true, meaningless).

So quota gets different treatment:

- **Never report a single-turn quota delta as anomalous.**
- Smooth over a trailing window of N turns and express the result as the derived
  quantity that is both smooth and decision-relevant: `~2 turns at recent burn`.
- If per-turn token counts are available, use those as the continuous underlying
  signal and treat the percentage as a lossy readout of it.

**Known confound: parallel usage.** Subagents and peer sessions inflate the
aggregate burn, and the hook cannot attribute it. In this session the model's own
context was 107.8k while a peer session doing measurements for it was at 223.0k.
The hook should therefore state what it measured (`-13 since last turn`) rather
than assert whose it was (`your burn rate`), and any extrapolation must read
visibly as an extrapolation — the rate is exactly what parallel work makes
unreliable. The model knows who else is running; the hook does not. Let each
supply the half it has.

### Register: implication, not instruction

Settled explicitly with the user, and it revises an earlier proposal in the
session. The hook must **not** say "wrap up" or "do not start new
investigations".

The counterexample is real and happened: with the session at 93%, the user kept
talking *because he knew the reset was five minutes out*. A hook instructing the
model to wrap up would have been wrong, and wrong in a way that competes with the
user's own knowledge of the situation.

`93%, ~2 turns at recent burn` has teeth — the model cannot claim terseness while
contradicting it — but commands nothing. Precedent already in this repo: the
super-edit nudge says "this is a nudge, not a rule" in its own text and the script
never blocks, both deliberate, because the heuristic cannot see the case where
the shell edit is correct. Quota has *strictly less* information about user intent
than that heuristic has about a command, so it deserves strictly more hedging.

The failure mode being avoided is not one-time obedience — it is the model
starting to treat injected text as the thing to satisfy instead of the user.

Corollary, also a revision: an earlier idea to *require* the model to state what
it is cutting when over a threshold is wrong for the same reason. It presumes
cutting is correct. Conditional phrasing only — if scope is being narrowed, say so
plainly, because that is checkable against what follows. Narration is the
cheapest thing to fake and therefore the worst evidence that a hook is working;
a decision stated in advance and then visible in the output is falsifiable in the
same screen.

### Cold start

Three parts, first one most important:

1. **The floor rule needs no baseline.** "This Bash call took 5m12s" is worth
   saying on turn one of a fresh session with zero history — five minutes is long
   by any standard, and that is precisely the stuck-run case that motivated the
   whole plugin (in `agx_navigation`, long calibration runs that looked hung to
   the user). So `<timing-tool>` fires from the first call; `<timing-admonition>`
   waits for data. The two-tag format degrades gracefully by construction.
2. **Persist per-project, not globally.** Same project means the same test suite,
   build and hardware — a genuinely informative prior. Pooling across projects
   mixes a Rust build with a docs repo and yields a median describing nothing.
   Store beside the existing per-session state.
3. **Blend, do not switch.** Shrink the session estimate toward the project prior
   weighted by sample count, so it begins as the prior and becomes
   session-specific as evidence accumulates. Avoids both cold-start silence and
   the discontinuity of a hard cutover at n = 10. Medians rather than means keep
   one atypical session from poisoning the prior.

### Naming: `idle` is wrong

`idle` describes the *system's* state; the interesting fact is the *user's*
turnaround. Rename to something naming its referent — `your_gap`,
`since_your_last_message`.

The user's point, worth preserving verbatim in spirit: if he is asked to run a
program and report what it does, whether he comes back in 10 seconds or 10
minutes is real information he may forget to volunteer. The gap is reportable.
The **cause** is not — ten minutes might be running the thing, reading, or lunch —
and a hook that editorialises about it is back to claiming knowledge of intent.
Median-relative framing helps here too: "unusually quick" reads very differently
from "10m" in a session whose median gap is 12 minutes.

## Bug: interrupted turns are only detected when a tool was in flight

Found by accident this session. **The guard exists and did not fire**, which is
what makes it worth writing down carefully.

### Intended behaviour

`scripts/hook.mjs`, `onUserPromptSubmit`, roughly lines 174–201. Interruption is
inferred from **orphan tool stamps** — a `PreToolUse` with no matching
`PostToolUse`:

```js
const orphans = takeOrphans(dir, now);
const interrupted = orphans.length > 0;
```

and the intent is stated in the comment at lines 186–188:

> Idle is measured from the last Stop -- but an interrupted turn never reaches
> Stop, so that gap would span my own working time and read as the user being
> away. Better to say nothing than to say the opposite.

That reasoning is correct. The detector implementing it is not.

### What actually happened, twice, in one session

**Case A — interrupted while generating text, mid-session.** The user submitted a
prompt at 07:14:07, then interrupted ~90s later and submitted another. Both
`UserPromptSubmit` firings landed in what the model sees as a single user turn,
producing two adjacent and mutually contradictory lines:

```
<timing-prompt>now=07:14:07 idle=10m28s prev_turn=41s (model ~41s)</timing-prompt>
<timing-prompt>now=07:15:36 idle=11m57s</timing-prompt>
```

The second `idle=11m57s` is exactly the error the comment set out to prevent: no
tool was in flight, so `orphans` was empty, so `interrupted` was `false`, so idle
was computed from a `lastStopAt` that predates the interrupted turn — and the
resulting figure spans the model's own generation time and reads as the user
being away for twelve minutes when he had been away for none of it.

**Case B — interrupted after tools completed, first turn of the session.** Output
was a bare `<timing-prompt>now=06:07:21</timing-prompt>`: no `idle`, no
`prev_turn`. Two completed tool calls (`ListAgents`, `Bash`) had run that turn and
their time was silently dropped. Here `lastStopAt` was `null` (no Stop had ever
happened), which suppressed idle by luck rather than by design, and `previous`
had `durationMs === null`, so the first branch failed; the `interrupted` fallback
branch at line 197 could not fire because `interrupted` was again `false`.

### Root cause

`interrupted` keys on **tool-level** interruption only. An interruption during
text generation — no tool in flight, or all tools already returned — leaves no
orphan stamp and is invisible. The user reports interrupting this way *routinely*,
often reacting to what the tool calls reveal about intent, so this is the common
case rather than the edge one.

Two distinct symptoms follow: a **wrong** idle figure (Case A) and **silently
dropped** turn/tool time (Case B).

### Proposed fix, not yet implemented

A turn that was interrupted is exactly a turn that never reached `Stop`, and that
is directly observable from state without any reference to tools:

```js
const missedStop =
  state.turnStartAt != null &&
  (state.lastStopAt == null || state.lastStopAt < state.turnStartAt);
const interrupted = orphans.length > 0 || missedStop;
```

Then:

- Suppress `idle` whenever `interrupted` — as the existing comment already argues.
- Report `prev_turn=interrupted after <now − turnStartAt>` even with no tool time,
  since how much work was thrown away is useful regardless of what kind it was.
  The current fallback at line 197 requires `previous.toolMs` and so stays silent
  on text-only interruptions.
- Do not record interrupted turns as duration samples once the anomaly statistics
  above exist — they are censored observations, not measurements, and would drag
  every median downward.

### Wider point the user raised

The space of timing conditions between a user's actions and an agent's output is
hard to enumerate up front; interrupted turns were simply not considered when the
plugin was designed. Worth an explicit enumeration pass over the event model —
what can be in flight, what never fires, what fires twice — rather than patching
each case as it is stumbled over. This bug produced *two* different wrong outputs
from *one* missing signal, which suggests there are more.

## Next steps, in order

1. Mine existing transcripts for tool- and turn-duration distributions. Settles
   every threshold above with data instead of priors. Cheapest, highest leverage.
2. Fix the interruption detector (above) — small, self-contained, and it must land
   before statistics are collected, or interrupted turns will pollute the sample.
3. Implement per-project persisted stats with shrinkage, then the two-tag output.
4. Quota: trailing-window rate and `~N turns` phrasing. No anomaly detection.
5. Rename `idle`.

## Also still open, from the super-edit work

Whether a project-scoped `permissions.allow` entry is honoured for MCP tools at
all. One live session reported still being prompted after a full restart with a
correct entry in `.claude/settings.json`. If it is not honoured, the stage-2
advice now shipping in the super-edit hook is wrong and should point at a
server-level rule (the name with its `__super_edit` suffix removed) instead.
Recorded as **open, not settled** in `plugins/super-edit/tests/MANUAL.md` check 10.
