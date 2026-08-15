#!/usr/bin/env node
// A stdio MCP server exposing one tool, `check`, so Claude can ask for the
// quota on purpose -- before starting expensive work -- rather than waiting
// for the hook to volunteer it.
//
// The protocol is implemented directly rather than with the MCP SDK: this
// repo's plugins must run on an unfamiliar machine with no `npm install`, and
// the server needs exactly three methods.

import { readHistory, getUsage, describeSnapshot, describeWindow, assess, explain, formatDuration, logError, money, trend } from "./quota.mjs";

const PROTOCOL_VERSION = "2025-06-18";

const TOOL = {
  name: "check",
  title: "Check subscription quota",
  description:
    "Report Claude subscription usage: the 5-hour session window, the weekly windows, and extra-usage credits. " +
    "Each window is given as percent used versus percent of its time elapsed, so pace is visible rather than " +
    "just the raw number. Results are served from a cache shared by every session on this machine and refreshed " +
    "at most once every few minutes, because the underlying endpoint rate-limits per token.",
  inputSchema: {
    type: "object",
    properties: {
      refresh: {
        type: "boolean",
        description: "Ask for a fresher poll. Still subject to the shared rate budget; a recent cache wins.",
      },
      history_hours: {
        type: "number",
        description: "Also report how much each window moved over this many hours, from locally recorded polls.",
        minimum: 0,
        maximum: 720,
      },
    },
    additionalProperties: false,
  },
};

let buffer = "";
let pending = 0; // in-flight requests; stdin can end while a poll is still out
let ended = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) track(line);
  }
});
process.stdin.on("end", () => {
  ended = true;
  maybeExit();
});

function track(line) {
  pending += 1;
  handle(line).finally(() => {
    pending -= 1;
    maybeExit();
  });
}

// Exiting the moment stdin closes would drop a reply whose poll is still in
// flight -- which is exactly what a client does when it pipes one batch in.
function maybeExit() {
  if (ended && pending === 0) process.exit(0);
}

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (err) {
    return logError("mcp/parse", err);
  }

  // Notifications carry no id and take no reply.
  const { id, method, params } = message;
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "quota", version: "0.1.0" },
          },
        });
      case "tools/list":
        return send({ id, result: { tools: [TOOL] } });
      case "tools/call":
        if (params?.name !== TOOL.name) {
          return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
        }
        return send({ id, result: await runCheck(params?.arguments ?? {}) });
      case "ping":
        return send({ id, result: {} });
      default:
        return send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  } catch (err) {
    logError("mcp/handle", err);
    send({ id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
}

async function runCheck(args) {
  const now = Date.now();
  const { snapshot, source, cachedAt, lockedUntil, error } = await getUsage({ force: args.refresh === true, now });

  if (!snapshot?.windows?.length) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          // The caller asked on purpose, so give it the real reason rather
          // than a generic failure it cannot act on.
          text:
            source === "locked"
              ? `Usage endpoint is rate-limited; backing off for ${formatDuration(((lockedUntil ?? now) - now) / 1000)} (Retry-After from the server). No cached reading available.`
              : `No usage reading available: ${error ?? "another session holds the poll lock; try again in a moment"}`,
        },
      ],
    };
  }

  const lines = [describeSnapshot(snapshot), ""];
  for (const w of snapshot.windows) {
    lines.push(`- ${describeWindow(w)}${w.severity && w.severity !== "normal" ? ` [${w.severity}]` : ""}`);
  }
  if (snapshot.credits) {
    const c = snapshot.credits;
    const of = c.limit !== null ? ` of ${money(c.limit, c.currency)}` : "";
    lines.push(`- extra-usage credits ${Math.round(c.percent)}%${c.used !== null ? ` (${money(c.used, c.currency)}${of})` : ""}`);
  }

  const assessment = assess(snapshot);
  lines.push("", `Pace: ${assessment.state.toUpperCase()}${assessment.window ? ` — ${explain(assessment)}` : ""}`);

  if (args.history_hours > 0) {
    const windowMs = args.history_hours * 3600_000;
    const t = trend(readHistory({ sinceMs: now - windowMs }), windowMs, now);
    lines.push(
      t
        ? `Trend over the last ${formatDuration(t.spanMs / 1000)} (${t.samples} polls): ` +
          Object.entries(t.deltas)
            .map(([kind, delta]) => `${kind} ${delta >= 0 ? "+" : ""}${Math.round(delta)}`)
            .join(", ")
        : `No usable history for the last ${args.history_hours}h (needs at least two recorded polls).`,
    );
  }

  const age = now - (cachedAt ?? now);
  const freshness =
    source === "network" ? "polled just now" : `from cache, ${formatDuration(age / 1000)} old`;
  const backoff = lockedUntil && lockedUntil > now ? `; polling backed off for ${formatDuration((lockedUntil - now) / 1000)}` : "";
  if (error) lines.push(`Refresh failed, so the reading above is the last good one: ${error}`);
  lines.push("", `(${freshness}${backoff})`);

  const text = lines.join("\n");
  return { content: [{ type: "text", text }], structuredContent: { snapshot, state: assessment.state, source } };
}

function send(payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
}
