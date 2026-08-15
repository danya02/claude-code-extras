#!/usr/bin/env node
// SessionStart / UserPromptSubmit hook: put the subscription quota in Claude's
// context, but only when the number has actually changed enough to be worth
// the tokens, and only ever from the shared cache (see scripts/quota.mjs for
// the polling budget).
//
// Never blocks: every failure path exits 0. Failures are reported as context
// rather than swallowed -- silence would read as "quota is fine" -- but only
// once per distinct error per session.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assess,
  config,
  dataDir,
  describeSnapshot,
  explain,
  formatDuration,
  getUsage,
  logError,
  safeId,
  sweepSessions,
  writeAtomic,
} from "./quota.mjs";

main();

async function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return; // no stdin, or not JSON
  }

  try {
    const kind = event.hook_event_name;
    if (kind !== "SessionStart" && kind !== "UserPromptSubmit") return;

    const now = Date.now();
    if (kind === "SessionStart") sweepSessions(now);

    const { snapshot, source, cachedAt, lockedUntil, error } = await getUsage({ now });
    const sessionPath = sessionStatePath(event.session_id);
    const previous = readSession(sessionPath);

    // A failure is worth one report, with the technical detail intact: a
    // wrong-looking 403 or a proxy 520 is something the reader can diagnose or
    // pass on, whereas silence reads as "quota is fine". Repeats are
    // suppressed -- the same broken proxy on every prompt is just noise.
    if (!snapshot?.windows?.length) {
      if (!error || error === previous?.error) return;
      writeSession(sessionPath, { ...(previous ?? {}), error, reportedAt: now });
      return emit({
        hookSpecificOutput: {
          hookEventName: kind,
          additionalContext: `<quota-error>Subscription quota unavailable: ${error}</quota-error>`,
        },
      });
    }

    const assessment = assess(snapshot);

    // SessionStart always reports: a fresh context has no idea where the week
    // stands. After that, silence is the default.
    const reason = kind === "SessionStart" ? "start" : changeReason(previous, snapshot, assessment);
    if (!reason) return;

    const staleFor = source === "network" ? 0 : now - (cachedAt ?? now);
    const context = renderContext(snapshot, assessment, { staleFor, lockedUntil, now, error });

    const output = {
      hookSpecificOutput: { hookEventName: kind, additionalContext: context },
    };

    // Only escalations reach the user: a quota that improved is not news, and
    // a line on every prompt would be noise they cannot act on.
    if (config.visibleAlerts && assessment.rank > 0 && assessment.rank > (previous?.rank ?? 0)) {
      output.systemMessage = `[quota] ${explain(assessment)}`;
    }

    writeSession(sessionPath, {
      rank: assessment.rank,
      percents: percentsOf(snapshot),
      error: error ?? null,
      reportedAt: now,
    });

    emit(output);
  } catch (err) {
    logError(event?.hook_event_name ?? "hook", err);
  }
}

function emit(output) {
  process.stdout.write(JSON.stringify(output));
}

/* ----------------------------------------------------------- what to say */

function renderContext(snapshot, assessment, { staleFor, lockedUntil, now, error }) {
  const parts = [describeSnapshot(snapshot)];

  // Age matters: a five-minute-old number is fine, a number from before a
  // rate-limit lockout could be half an hour stale and should not be trusted
  // as current.
  if (staleFor > 90_000) parts.push(`measured ${formatDuration(staleFor / 1000)} ago`);
  if (lockedUntil && lockedUntil > now) parts.push(`polling backed off ${formatDuration((lockedUntil - now) / 1000)}`);
  // The numbers below are real but could not be refreshed; say why, so a
  // reader knows whether to trust them or investigate.
  if (error) parts.push(`refresh failed: ${error}`);

  let block = `<quota>${parts.join(" · ")}</quota>`;

  if (config.wrapUpNudge && assessment.rank >= 2) {
    block += `\n<quota-advice>${advice(assessment)}</quota-advice>`;
  }
  return block;
}

function advice(assessment) {
  const why = explain(assessment);
  if (assessment.state === "spent") {
    return (
      `${why} Prefer wrapping up: finish or hand off what is in flight, write down state that a ` +
      `later session would need, and check with the user before starting anything large.`
    );
  }
  return (
    `${why} Spend the remaining budget deliberately: prefer targeted reads and edits over broad ` +
    `exploration, avoid long autonomous runs and parallel subagents unless the user asks for them.`
  );
}

// A report is earned by a change, not by a turn passing.
function changeReason(previous, snapshot, assessment) {
  if (!previous) return "first";
  if (assessment.rank !== previous.rank) return "state";
  const current = percentsOf(snapshot);
  for (const [kind, percent] of Object.entries(current)) {
    const before = previous.percents?.[kind];
    if (typeof before !== "number" || Math.abs(percent - before) >= config.reportDelta) return "delta";
  }
  return null;
}

function percentsOf(snapshot) {
  const out = {};
  for (const w of snapshot.windows) out[w.kind] = w.percent;
  if (snapshot.credits) out.credits = snapshot.credits.percent;
  return out;
}

/* --------------------------------------------------------- session state */

// What *this* session has already been told, so two sessions on one machine
// report independently while sharing a single poll.
function sessionStatePath(sessionId) {
  return join(dataDir, "sessions", `${safeId(sessionId) || "unknown"}.json`);
}

function readSession(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeSession(path, value) {
  try {
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeAtomic(path, JSON.stringify(value));
  } catch (err) {
    logError("writeSession", err);
  }
}
