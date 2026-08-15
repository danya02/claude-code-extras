// Shared logic for the quota plugin: credentials, polling, pace, formatting.
// Imported by both scripts/hook.mjs and scripts/mcp.mjs.
//
// Three rules hold everywhere in this file:
//   1. Never block a session, but never hide a failure either. Every failure
//      path resolves rather than throwing, and carries an error string with
//      enough technical detail (status, URL, proxy route) that the reader can
//      act on it. Silence would be indistinguishable from "quota is fine".
//   2. Never spend someone else's rate budget. The usage endpoint tolerates
//      five calls per five minutes before returning 429 with a 300s
//      Retry-After, and that budget is per *token* -- which every Claude Code
//      session on this machine shares. So all sessions poll through one cache
//      file, at most once per POLL_INTERVAL, leaving headroom for `/usage`
//      and any other tooling reading the same token.
//   3. Never write the credentials file. The access token is short-lived and
//      Claude Code refreshes it; a second refresher would rotate the refresh
//      token out from under it. We only ever read.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getJson, proxyFor } from "./request.mjs";

// The override is a test seam: tests/run.mjs points it at a local server so
// the suite never touches the network or spends the real rate budget.
export const USAGE_URL = process.env.CLAUDE_QUOTA_USAGE_URL || "https://api.anthropic.com/api/oauth/usage";

export const dataDir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "claude-code-quota");
const cachePath = join(dataDir, "cache.json");
const lockPath = join(dataDir, "poll.lock"); // a directory: mkdir is atomic on every platform
const historyPath = join(dataDir, "history.ndjson");

const LOCK_STALE_MS = 30_000; // a crashed poller must not wedge every session
const DEFAULT_LOCKOUT_MS = 300_000; // what the endpoint's Retry-After says in practice
const HISTORY_MAX_DAYS = 30;

// Window length behind each limit `kind`, so resets_at becomes "how much of
// this window has elapsed" -- the number that makes a percentage meaningful.
export const KIND_WINDOW_SECONDS = {
  session: 5 * 3600,
  weekly_all: 7 * 86400,
  weekly_scoped: 7 * 86400,
  weekly_opus: 7 * 86400,
};

export const LABELS = {
  session: "session",
  weekly_all: "weekly",
  weekly_scoped: "weekly/model",
  weekly_opus: "weekly/opus",
};

export const config = {
  pollIntervalMs: Math.max(60, num("POLL_INTERVAL_SECONDS", 300)) * 1000,
  reportDelta: num("REPORT_DELTA_PERCENT", 3),
  cautionLead: num("PACE_CAUTION_LEAD", 10),
  alarmLead: num("PACE_ALARM_LEAD", 25),
  spentPercent: num("SPENT_PERCENT", 95),
  visibleAlerts: bool("VISIBLE_ALERTS", true),
  wrapUpNudge: bool("WRAP_UP_NUDGE", true),
  keepHistory: bool("KEEP_HISTORY", true),
  timeoutMs: Math.max(1, num("REQUEST_TIMEOUT_SECONDS", 5)) * 1000,
  debugLog: bool("DEBUG_LOG", false),
};

function num(key, fallback) {
  const raw = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  const parsed = Number(raw);
  return raw === undefined || raw === "" || !Number.isFinite(parsed) || parsed < 0 ? fallback : parsed;
}

function bool(key, fallback) {
  const raw = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  if (raw === undefined || raw === "") return fallback;
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

/* ------------------------------------------------------------ credentials */

// Read-only, every time: the token expires roughly hourly and Claude Code
// rewrites the file, so a cached token would go stale within one session.
export function readToken() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    const raw = JSON.parse(readFileSync(join(base, ".credentials.json"), "utf8"));
    const oauth = raw?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
    return { token: oauth.accessToken, expiresAt: oauth.expiresAt ?? null };
  } catch {
    return null; // no credentials on this machine, or an API-key install
  }
}

/* ---------------------------------------------------------------- polling */

// Returns { snapshot, source, cachedAt, lockedUntil, error } where source is
// one of network | cache | locked | none.
//
// A failure is reported, not swallowed. Silence and "the endpoint answered
// 520 because the request went out unproxied" look identical from inside a
// session, and the second one is something the reader can act on -- so the
// error text carries the status, the URL and whether a proxy was in play.
export async function getUsage({ force = false, now = Date.now() } = {}) {
  const cache = readCache();
  const fallback = (error) => ({
    snapshot: cache?.snapshot ?? null,
    source: cache?.snapshot ? "cache" : "none",
    cachedAt: cache?.at ?? null,
    error,
  });

  const lockedUntil = cache?.lockedUntil ?? 0;
  const fresh = cache?.at && now - cache.at < (force ? Math.min(config.pollIntervalMs, 60_000) : config.pollIntervalMs);
  if (fresh) return { snapshot: cache.snapshot, source: "cache", cachedAt: cache.at };
  if (now < lockedUntil) {
    // Rate-limited by the endpoint. Serving a stale snapshot is strictly
    // better than serving nothing, as long as its age is visible.
    return { snapshot: cache?.snapshot ?? null, source: "locked", cachedAt: cache?.at ?? null, lockedUntil };
  }

  // One poller at a time across all sessions on this machine. Losing the race
  // is not an error: another session is fetching the same number right now.
  if (!acquireLock(now)) return fallback(null);

  try {
    // Re-read under the lock. Between this process reading the cache and
    // taking the lock, the previous holder may have finished a poll and
    // published its result -- polling again would spend a second slot of a
    // five-per-five-minute budget for a number we already have.
    const latest = readCache();
    if (latest?.at && latest.at > (cache?.at ?? 0) && now - latest.at < config.pollIntervalMs) {
      return { snapshot: latest.snapshot, source: "cache", cachedAt: latest.at };
    }
    if (latest?.lockedUntil > now) {
      return { snapshot: latest.snapshot ?? null, source: "locked", cachedAt: latest.at ?? null, lockedUntil: latest.lockedUntil };
    }

    const auth = readToken();
    if (!auth) {
      return fallback(
        `no OAuth token in ${process.env.CLAUDE_CONFIG_DIR || "~/.claude"}/.credentials.json ` +
          `(expected claudeAiOauth.accessToken; an API-key install has none)`,
      );
    }

    const result = await fetchUsage(auth.token);
    if (result.retryAfterMs !== undefined) {
      writeCache({ ...cache, lockedUntil: now + result.retryAfterMs });
      return {
        snapshot: cache?.snapshot ?? null,
        source: "locked",
        cachedAt: cache?.at ?? null,
        lockedUntil: now + result.retryAfterMs,
      };
    }
    if (!result.data) {
      logError("fetch", result.error);
      return fallback(describeError(result.error, auth));
    }

    const snapshot = toSnapshot(result.data, now);
    writeCache({ at: now, snapshot, lockedUntil: 0 });
    if (config.keepHistory) appendHistory(snapshot, now);
    return { snapshot, source: "network", cachedAt: now };
  } catch (err) {
    logError("getUsage", err);
    return fallback(describeError(err, null));
  } finally {
    releaseLock();
  }
}

// Turn a transport or HTTP failure into something a reader can act on rather
// than a bare status code: name the proxy, since an unproxied request on a
// proxied machine reaches a CDN edge instead of the API and fails in ways that
// look like a bad token; and name token expiry, since that is the one cause a
// session can actually resolve by waiting for Claude Code to refresh it.
function describeError(err, auth) {
  const message = String(err?.message ?? err);
  const via = proxyFor(new URL(USAGE_URL));
  const route = via ? `via proxy ${via.protocol}//${via.host}` : "direct, no proxy configured";
  const hints = [];
  if (/HTTP 40[13]/.test(message) && auth?.expiresAt && auth.expiresAt < Date.now()) {
    hints.push("the cached access token is past its expiry; Claude Code refreshes it on its own schedule");
  }
  if (/HTTP 5\d\d/.test(message) && !via) {
    hints.push("a 5xx on a direct request often means a proxy is required on this network");
  }
  return `${message} for ${USAGE_URL} (${route})${hints.length ? ` — ${hints.join("; ")}` : ""}`;
}

// Resolves to { data } | { retryAfterMs } | { error }. A 429 is an expected
// outcome here, not an exception: it means some other reader of this token
// spent the budget, and the only correct response is to back off for exactly
// as long as the response says.
export async function fetchUsage(token) {
  let resp;
  try {
    resp = await getJson(
      USAGE_URL,
      { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", accept: "application/json" },
      config.timeoutMs,
    );
  } catch (err) {
    // Transport failures (dead proxy, DNS, timeout) carry a code worth keeping.
    return { error: new Error(`${err?.code ? `${err.code}: ` : ""}${err?.message ?? err}`) };
  }

  if (resp.status === 429) {
    const header = Number(resp.headers["retry-after"]);
    const ms = Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_LOCKOUT_MS;
    return { retryAfterMs: Math.min(ms, 3600_000) };
  }
  if (resp.status < 200 || resp.status >= 300) {
    return { error: new Error(`HTTP ${resp.status}${bodyHint(resp.body)}`) };
  }

  try {
    return { data: JSON.parse(resp.body) };
  } catch (err) {
    return { error: err };
  }
}

// One line of the error body, when the server bothered to explain itself.
function bodyHint(body) {
  if (typeof body !== "string" || !body.trim()) return "";
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.message;
    if (message) return ` (${String(message).slice(0, 200)})`;
  } catch {}
  return ` (${body.replace(/\s+/g, " ").trim().slice(0, 120)})`;
}

/* --------------------------------------------------------------- snapshot */

// The API also returns five_hour/seven_day objects duplicating the first two
// limits in an older shape, plus a long tail of null codenamed buckets. Only
// `limits` and `spend` are load-bearing, so the snapshot keeps just those --
// which also keeps the cache file small and the history rows comparable.
export function toSnapshot(data, now = Date.now()) {
  const windows = [];
  for (const limit of data?.limits ?? []) {
    if (typeof limit?.percent !== "number") continue;
    windows.push({
      kind: limit.kind,
      label: LABELS[limit.kind] ?? limit.kind,
      percent: limit.percent,
      severity: limit.severity ?? null,
      resetsAt: limit.resets_at ?? null,
      ...paceOf(limit, now),
    });
  }

  const spend = data?.spend;
  const credits =
    spend && spend.enabled && typeof spend.percent === "number"
      ? {
          percent: spend.percent,
          used: minorToNumber(spend.used),
          limit: minorToNumber(spend.limit),
          currency: spend.used?.currency ?? "USD",
        }
      : null;

  return { at: now, windows, credits };
}

// elapsed% of the window, and the lead: how far usage is running ahead of the
// clock. The lead is the actionable number -- 92% used is alarming at hour 1
// of 5 and completely fine at hour 4.5.
function paceOf(limit, now) {
  const windowSeconds = KIND_WINDOW_SECONDS[limit.kind];
  if (!limit.resets_at || !windowSeconds) return { elapsedPct: null, lead: null, secondsLeft: null };

  const resetsAt = Date.parse(limit.resets_at);
  if (!Number.isFinite(resetsAt)) return { elapsedPct: null, lead: null, secondsLeft: null };

  const secondsLeft = (resetsAt - now) / 1000;
  if (secondsLeft < 0 || secondsLeft > windowSeconds) {
    // A reset in the past, or further out than the window is long: the data is
    // stale or the window has not started. Either way the clock is unknowable.
    return { elapsedPct: null, lead: null, secondsLeft: secondsLeft > 0 ? secondsLeft : null };
  }

  const elapsedPct = (1 - secondsLeft / windowSeconds) * 100;
  return { elapsedPct, lead: limit.percent - elapsedPct, secondsLeft };
}

function minorToNumber(money) {
  if (!money || typeof money.amount_minor !== "number") return null;
  return money.amount_minor / 10 ** (money.exponent ?? 0);
}

/* ------------------------------------------------------------------- pace */

// Ordered worst-first; `rank` is what lets a session decide whether the
// situation got worse since the last report.
export const STATES = { spent: 3, alarm: 2, caution: 1, ok: 0 };

export function assess(snapshot) {
  let worst = { state: "ok", rank: 0, window: null };
  for (const w of snapshot?.windows ?? []) {
    const state = stateOf(w);
    if (STATES[state] > worst.rank) worst = { state, rank: STATES[state], window: w };
  }
  return worst;
}

function stateOf(w) {
  if (w.percent >= config.spentPercent) return "spent";
  // Below the spent line, only the *lead* matters: burning quota faster than
  // the window's time is passing is the thing worth flagging. Running behind
  // the clock is what a healthy session looks like at any percentage.
  if (w.lead === null) return "ok";
  if (w.lead >= config.alarmLead) return "alarm";
  if (w.lead >= config.cautionLead) return "caution";
  return "ok";
}

/* -------------------------------------------------------------- rendering */

// "session 70%/58% +12 resets 1h12m" -- used, elapsed, lead, time left.
export function describeWindow(w, { pace = true } = {}) {
  const parts = [`${w.label} ${Math.round(w.percent)}%`];
  if (pace && w.elapsedPct !== null) {
    parts[0] += `/${Math.round(w.elapsedPct)}%`;
    const lead = Math.round(w.lead);
    if (Math.abs(lead) >= 1) parts.push(lead > 0 ? `+${lead}` : `${lead}`);
  }
  if (w.secondsLeft !== null) parts.push(`resets ${formatDuration(w.secondsLeft)}`);
  return parts.join(" ");
}

export function describeSnapshot(snapshot, { pace = true } = {}) {
  const parts = (snapshot?.windows ?? []).map((w) => describeWindow(w, { pace }));
  if (snapshot?.credits) {
    const c = snapshot.credits;
    parts.push(`credits ${Math.round(c.percent)}%${c.limit !== null ? ` of ${money(c.limit, c.currency)}` : ""}`);
  }
  return parts.join(" · ");
}

// Why the state fired, in the terms that make it actionable.
export function explain(assessment) {
  const w = assessment.window;
  if (!w) return null;
  if (assessment.state === "spent") {
    const when = w.secondsLeft !== null ? `, which resets in ${formatDuration(w.secondsLeft)}` : "";
    return `The ${w.label} quota is at ${Math.round(w.percent)}%${when}.`;
  }
  return (
    `The ${w.label} quota is ${Math.round(w.percent)}% used with only ` +
    `${Math.round(w.elapsedPct)}% of its window elapsed (running ${Math.round(w.lead)} points ahead of the clock).`
  );
}

export function money(amount, currency) {
  const symbol = { USD: "$", EUR: "€", GBP: "£" }[currency] ?? "";
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return symbol ? `${symbol}${value}` : `${value} ${currency}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m`;
  return `${total}s`;
}

/* ------------------------------------------------------------------ cache */

export function readCache() {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(value) {
  writeAtomic(cachePath, JSON.stringify(value));
}

// tmp+rename is the portable atomic-publish idiom, but on Windows the rename
// fails with EPERM/EBUSY while another process has the destination open for
// reading. A cache entry is not worth failing a poll over, so fall back to a
// plain write and let the reader's JSON.parse guard handle a torn read.
export function writeAtomic(path, contents) {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    try {
      writeFileSync(path, contents);
    } catch (err) {
      logError("writeAtomic", err);
    }
  }
}

/* ------------------------------------------------------------------- lock */

// mkdir either creates the directory or fails with EEXIST, atomically, on
// every platform Node supports -- unlike an O_EXCL file, it needs no cleanup
// subtleties on Windows, where an open file cannot be unlinked.
function acquireLock(now) {
  try {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(lockPath);
    return true;
  } catch (err) {
    if (err?.code !== "EEXIST") return false;
    try {
      if (now - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath);
        return true;
      }
    } catch {
      // Another process reclaimed it first; it holds the lock, we do not.
    }
    return false;
  }
}

function releaseLock() {
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {}
}

/* ---------------------------------------------------------------- history */

// One line per successful poll. Appends of this size are atomic on the
// platforms Claude Code runs on, so concurrent sessions cannot interleave
// half-lines; a torn line costs one sample, not the file.
function appendHistory(snapshot, now) {
  const row = { at: now };
  for (const w of snapshot.windows) row[w.kind] = w.percent;
  if (snapshot.credits) row.credits = snapshot.credits.percent;
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(historyPath, `${JSON.stringify(row)}\n`);
    pruneHistory(now);
  } catch (err) {
    logError("appendHistory", err);
  }
}

export function readHistory({ sinceMs = null } = {}) {
  let raw;
  try {
    raw = readFileSync(historyPath, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (Number.isFinite(row.at) && (sinceMs === null || row.at >= sinceMs)) rows.push(row);
    } catch {
      // Torn line: skip the sample.
    }
  }
  return rows;
}

// Rewritten only when it has actually outgrown the retention window, so the
// common path is a pure append.
function pruneHistory(now) {
  try {
    if (statSync(historyPath).size < 512 * 1024) return;
  } catch {
    return;
  }
  const cutoff = now - HISTORY_MAX_DAYS * 86400_000;
  const kept = readHistory({ sinceMs: cutoff });
  writeAtomic(historyPath, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
}

// Change in each window's percent across the retained samples in `windowMs`,
// which is the question "am I burning faster than I was an hour ago?".
export function trend(rows, windowMs, now = Date.now()) {
  const recent = rows.filter((r) => now - r.at <= windowMs);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const deltas = {};
  for (const key of Object.keys(last)) {
    if (key === "at" || typeof first[key] !== "number" || typeof last[key] !== "number") continue;
    deltas[key] = last[key] - first[key];
  }
  return { spanMs: last.at - first.at, samples: recent.length, deltas };
}

/* ------------------------------------------------------------------ utils */

// Session ids are interpolated into a path, so anything not plainly id-shaped
// is rejected rather than sanitised.
export function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function logError(where, err) {
  if (!config.debugLog) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(
      join(dataDir, "errors.ndjson"),
      `${JSON.stringify({ at: new Date().toISOString(), where, error: String(err?.stack ?? err) })}\n`,
    );
  } catch {
    // Logging must never be the thing that breaks a hook.
  }
}

export function sweepSessions(now) {
  const dir = join(dataDir, "sessions");
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > 7 * 86400_000) rmSync(path, { force: true });
      } catch {}
    }
  } catch {}
}

// Exported only so the tests can reach them without duplicating paths.
export const paths = { cachePath, lockPath, historyPath };
export const internals = { acquireLock, releaseLock, stateOf, paceOf };
