# quota

Claude cannot see your subscription usage. `/usage` shows it to *you*, but the
model has no idea whether it is at hour one of a fresh five-hour window or
about to burn the last of your week — so it plans identically either way, and
finds out only when a request is refused.

This plugin puts the numbers in Claude's context, and gives it a tool to ask
on demand.

## What it injects

At session start, and afterwards only when something moved:

```
<quota>session 71%/64% +7 resets 1h48m · weekly 92%/89% +3 resets 15h · credits 16% of $60</quota>
```

Each window is **used% / elapsed%**, with the lead between them. That pairing is
the whole point: 92% used is alarming four minutes into a window and completely
unremarkable four hours and fifty minutes in. Only the lead is actionable, so
only the lead triggers advice:

```
<quota-advice>The session quota is 60% used with only 20% of its window elapsed
(running 40 points ahead of the clock). Spend the remaining budget deliberately:
prefer targeted reads and edits over broad exploration, avoid long autonomous
runs and parallel subagents unless the user asks for them.</quota-advice>
```

When a window crosses 95% the advice switches to wrapping up — finish or hand
off what is in flight — because at that point pace no longer matters.

Roughly 30 tokens per report, and reports are rare: after the first one, a
window has to move `report_delta_percent` points or change pace state.

## The MCP tool

`check` returns the full picture on demand, which is what you want before
starting something expensive:

```
session 71%/64% +7 resets 1h48m · weekly 92%/89% +3 resets 15h · credits 16% of $60

- session 71%/64% +7 resets 1h48m
- weekly 92%/89% +3 resets 15h [critical]
- extra-usage credits 16% ($9.33 of $60)

Pace: OK
Trend over the last 5h (12 polls): session +48, weekly_all +6

(from cache, 2m old)
```

Arguments: `refresh` (ask for a fresher poll, still rate-budget bound) and
`history_hours` (movement over that span, from locally recorded polls).

## Install

```
/plugin marketplace add gmatiukhin/claude-code-extras
/plugin install quota@claude-code-extras
```

Nothing to configure: it reads the OAuth token Claude Code already keeps in
`~/.claude/.credentials.json` (honouring `CLAUDE_CONFIG_DIR`). API-key installs
have no such token and the plugin stays silent.

## The rate budget, which is the hard constraint

`GET https://api.anthropic.com/api/oauth/usage` allows about **five calls per
five minutes per OAuth token**, then answers `429` with `Retry-After: 300`.
That budget is per *token*, and every Claude Code session on the machine shares
one token file — so a naive per-session poller with three windows open would
lock out `/usage` for everyone.

Hence:

- **One cache for all sessions**, in the plugin data directory. Sessions read
  it; they do not each poll.
- **One poll per `poll_interval_seconds`** (default 300), so the plugin uses
  about a fifth of the budget and leaves the rest for `/usage` and your own
  scripts.
- **A cross-process lock** so simultaneous session starts produce one request,
  not six. It is a `mkdir`, which is atomic on every platform, reclaimed after
  30 s in case a poller was killed.
- **`429` is expected, not exceptional.** The lockout is recorded with exactly
  the `Retry-After` the server gave, and until it expires nothing polls. The
  last good reading is still served, labelled with its age and the backoff.

## Proxies

Node's built-in `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` unless the process
was started with `NODE_USE_ENV_PROXY=1` — and that is read at startup, so a
script cannot set it for itself, while an inline `VAR=1 node …` hook command is
not portable to Windows. Behind a proxy the request then does not merely fail:
it goes out direct and comes back `403` from the CDN, which looks exactly like
a broken token.

So `scripts/request.mjs` does its own proxying: a `CONNECT` tunnel for `https`,
the absolute-URI form for `http`, `NO_PROXY` honoured, TLS verified against the
real hostname so the proxy cannot read the token. Standard variable precedence
(`https_proxy` → `HTTPS_PROXY` → `http_proxy` → `HTTP_PROXY`).

## Credentials

Read-only, re-read on every poll, **never written**. The access token expires
roughly hourly and Claude Code refreshes it; a second refresher would rotate
the refresh token out from under it — which is exactly how the sibling
`claude-usage` project once destroyed a year-long token.

## Configuration

| Option | Default | Effect |
| --- | --- | --- |
| `poll_interval_seconds` | `300` | Minimum seconds between network polls, shared by all sessions. Clamped to ≥ 60. |
| `report_delta_percent` | `3` | Points a window must move before it is reported again. `0` reports every prompt. |
| `pace_caution_lead` | `10` | Lead at which the pace counts as worth noting. |
| `pace_alarm_lead` | `25` | Lead at which Claude is told to spend the rest deliberately. |
| `spent_percent` | `95` | Usage at or above this is a spent window regardless of pace. |
| `visible_alerts` | `true` | Show you a message when a quota state worsens. Improvements are never announced. |
| `wrap_up_nudge` | `true` | Let the injected context carry advice, not just numbers. |
| `keep_history` | `true` | Record each poll to `history.ndjson` (pruned to 30 days) for the trend report. |
| `request_timeout_seconds` | `5` | Abandon a poll after this long. A timed-out poll injects nothing. |
| `debug_log` | `false` | Append internal errors to `errors.ndjson` in the plugin data directory. |

## Cost

One `node` process per session start and per prompt, ~40–70 ms, almost all of
it Node startup; the common path is a cache read, not a network call. Only one
process in five minutes does any I/O beyond that.

## Design notes

- **Never blocks.** Every failure path exits 0 and lets the prompt through:
  missing credentials, an unreachable endpoint, a dead proxy, malformed stdin.
- **Failures are reported, not swallowed.** Anything but malformed stdin emits
  a `<quota-error>` block naming the status or error code, the URL and whether
  the request went direct or through which proxy — Claude can work around a
  failure it is told about, or pass it on, whereas silence reads as "quota is
  fine". The same failure is reported once per session, not on every prompt.
- **Stale data is labelled, not hidden.** A reading served from cache during a
  lockout says how old it is, because a number Claude thinks is current but is
  not is worse than no number.
- **Zero dependencies**, including for MCP: `scripts/mcp.mjs` implements the
  three JSON-RPC methods it needs directly rather than pulling in the SDK.

## Tests

```
node plugins/quota/tests/run.mjs
```

71 checks, no network — a local server stands in for the endpoint, including a
real forwarding proxy for the proxy cases and a scripted `429` for the lockout.

## Known gaps

- Per-model weekly buckets (`weekly_opus` and friends) are rendered if the API
  returns them, but this account has only ever seen them null, so their labels
  are untested against real data.
- The 5-call/5-minute budget is measured, not documented; if Anthropic tightens
  it, the first symptom is a longer-than-expected backoff, not a failure.
- History is written by whichever session happens to poll, so a machine that
  never runs Claude Code has gaps — the trend report is best-effort, not a
  time series you can audit.
