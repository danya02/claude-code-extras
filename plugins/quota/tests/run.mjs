#!/usr/bin/env node
// node plugins/quota/tests/run.mjs
//
// Drives the real hook and MCP scripts as subprocesses, one process per event,
// exactly as Claude Code does. No framework, and no network: a local HTTP
// server stands in for the usage endpoint, so the suite never spends the real
// per-token rate budget.

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const HOOK = join(scripts, "hook.mjs");
const MCP = join(scripts, "mcp.mjs");

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : `\n     ${detail}`}`);
}

/* ----------------------------------------------------------------- server */

// Scripted responses: each request shifts the next entry, so a test can queue
// a 429 behind a 200 and assert on the transition.
const server = { requests: 0, queue: [], hits: [] };

const usagePayload = ({ session = 40, weekly = 60, sessionResetsInS = 3600, weeklyResetsInS = 86400 } = {}) => ({
  limits: [
    { kind: "session", group: "session", percent: session, severity: "normal", resets_at: iso(sessionResetsInS) },
    { kind: "weekly_all", group: "weekly", percent: weekly, severity: "normal", resets_at: iso(weeklyResetsInS) },
  ],
  spend: { used: { amount_minor: 933, currency: "USD", exponent: 2 }, limit: { amount_minor: 6000, currency: "USD", exponent: 2 }, percent: 16, enabled: true },
});

const iso = (secondsFromNow) => new Date(Date.now() + secondsFromNow * 1000).toISOString();

const http = createServer((req, res) => {
  server.requests += 1;
  server.hits.push(req.headers.authorization);
  const next = server.queue.shift() ?? { status: 200, body: usagePayload() };
  const headers = { "content-type": "application/json", ...(next.headers ?? {}) };
  res.writeHead(next.status, headers);
  res.end(JSON.stringify(next.body ?? {}));
});

await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const usageUrl = `http://127.0.0.1:${http.address().port}/usage`;

/* ------------------------------------------------------------ environment */

const root = mkdtempSync(join(tmpdir(), "quota-test-"));

function makeEnv({ data = "data", credentials = true, options = {} } = {}) {
  const dataDir = join(root, data);
  const configDir = join(root, `${data}-config`);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  if (credentials) {
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 3600_000, scopes: ["user:profile"] } }),
    );
  }
  const env = {
    ...process.env,
    // The suite talks to a local stand-in server, so it must not inherit the
    // developer's proxy configuration -- a machine behind a proxy would
    // otherwise route 127.0.0.1 through it and fail every case.
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    NO_PROXY: "",
    no_proxy: "",
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_QUOTA_USAGE_URL: usageUrl,
  };
  for (const [key, value] of Object.entries(options)) env[`CLAUDE_PLUGIN_OPTION_${key}`] = String(value);
  return { env, dataDir, configDir };
}

function run(script, { env, stdin = "", args = [] } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const hook = (env, event) => run(HOOK, { env, stdin: JSON.stringify(event) });
const parse = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};
const contextOf = (result) => parse(result.stdout)?.hookSpecificOutput?.additionalContext ?? "";

/* ------------------------------------------------------------------ tests */

// 1. SessionStart reports, and the report carries used%, elapsed% and pace.
{
  server.queue.length = 0;
  const { env } = makeEnv({ data: "basic" });
  server.queue.push({ status: 200, body: usagePayload({ session: 40, weekly: 60, sessionResetsInS: 3600 }) });
  const before = server.requests;
  const result = await hook(env, { hook_event_name: "SessionStart", session_id: "s1" });
  const context = contextOf(result);

  check("SessionStart exits 0", result.code === 0, `code=${result.code} stderr=${result.stderr}`);
  check("SessionStart polls once", server.requests === before + 1, `requests=${server.requests - before}`);
  check("sends bearer token", server.hits.at(-1) === "Bearer test-token", server.hits.at(-1));
  check("reports session window", /session 40%\/80%/.test(context), context);
  check("reports weekly window", /weekly 60%/.test(context), context);
  check("reports credits", /credits 16%/.test(context), context);
  // 40% used with 80% of the window elapsed is running behind the clock: no advice.
  check("no advice when pacing behind the clock", !context.includes("quota-advice"), context);
}

// 2. Within the poll interval the cache is reused, and an unchanged reading
//    injects nothing at all.
{
  server.queue.length = 0;
  const { env } = makeEnv({ data: "cache" });
  await hook(env, { hook_event_name: "SessionStart", session_id: "s1" });
  const after = server.requests;

  const second = await hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  check("second event does not poll", server.requests === after, `extra requests=${server.requests - after}`);
  check("unchanged quota injects nothing", second.stdout.trim() === "", second.stdout);

  // A different session shares the cache but reports on its own schedule.
  const other = await hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s2" });
  check("a new session gets its own first report", contextOf(other).includes("session"), other.stdout);
  check("still no extra poll", server.requests === after, `extra requests=${server.requests - after}`);
}

// 3. A move past the delta threshold is reported again; a smaller one is not.
{
  server.queue.length = 0;
  const { env } = makeEnv({ data: "delta", options: { POLL_INTERVAL_SECONDS: 60, REPORT_DELTA_PERCENT: 5 } });
  server.queue.push({ status: 200, body: usagePayload({ session: 40, weekly: 60 }) });
  await hook(env, { hook_event_name: "SessionStart", session_id: "s1" });

  // Force the cache to look old, then serve a reading two points higher.
  ageCache(env.CLAUDE_PLUGIN_DATA);
  server.queue.push({ status: 200, body: usagePayload({ session: 42, weekly: 60 }) });
  const small = await hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  check("a 2-point move stays silent", small.stdout.trim() === "", small.stdout);

  ageCache(env.CLAUDE_PLUGIN_DATA);
  server.queue.push({ status: 200, body: usagePayload({ session: 55, weekly: 60 }) });
  const big = await hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  check("a 15-point move reports", contextOf(big).includes("session 55%"), big.stdout);
}

// 4. Pace, not percentage, drives the advice: a high number late in a window
//    is fine; a moderate number early in one is not.
{
  server.queue.length = 0;
  const { env } = makeEnv({ data: "pace", options: { POLL_INTERVAL_SECONDS: 60 } });
  // 92% used with 10 minutes left of a 5h window -> 96% elapsed -> behind the clock.
  server.queue.push({ status: 200, body: usagePayload({ session: 92, weekly: 10, sessionResetsInS: 600 }) });
  const late = await hook(env, { hook_event_name: "SessionStart", session_id: "s1" });
  check("92% at 96% elapsed gives no advice", !contextOf(late).includes("quota-advice"), contextOf(late));

  ageCache(env.CLAUDE_PLUGIN_DATA);
  // 60% used with 4h left -> 20% elapsed -> 40 points ahead of the clock.
  server.queue.push({ status: 200, body: usagePayload({ session: 60, weekly: 10, sessionResetsInS: 4 * 3600 }) });
  const early = await hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s2" });
  const context = contextOf(early);
  check("60% at 20% elapsed gives advice", context.includes("quota-advice"), context);
  check("advice explains the lead", /ahead of the clock/.test(context), context);
  check("escalation is surfaced to the user", (parse(early.stdout)?.systemMessage ?? "").startsWith("[quota]"), early.stdout);
}

// 5. A spent window is called out regardless of pace, and asks for a wrap-up.
{
  server.queue.length = 0;
  const { env } = makeEnv({ data: "spent" });
  server.queue.push({ status: 200, body: usagePayload({ session: 99, weekly: 30, sessionResetsInS: 300 }) });
  const result = await hook(env, { hook_event_name: "SessionStart", session_id: "s1" });
  check("spent window advises wrapping up", /wrapping up/.test(contextOf(result)), contextOf(result));
}

// 6. A 429 sets a lockout for exactly as long as Retry-After says, and no
//    further request is made until it expires.
{
  server.queue.length = 0;
  const { env, dataDir } = makeEnv({ data: "ratelimit", options: { POLL_INTERVAL_SECONDS: 60 } });
  server.queue.push({ status: 429, headers: { "retry-after": "300" }, body: { error: "rate_limited" } });
  const first = await hook(env, { hook_event_name: "SessionStart", session_id: "s1" });
  check("429 does not break the hook", first.code === 0, `code=${first.code} stderr=${first.stderr}`);
  check("429 with no cache injects nothing", first.stdout.trim() === "", first.stdout);

  const cache = JSON.parse(readFileSync(join(dataDir, "cache.json"), "utf8"));
  const lockoutS = (cache.lockedUntil - Date.now()) / 1000;
  check("Retry-After drives the lockout", lockoutS > 290 && lockoutS <= 300, `lockout=${lockoutS}s`);

  const before = server.requests;
  await hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  check("no polling during the lockout", server.requests === before, `extra requests=${server.requests - before}`);
}

// 7. A lockout serves the last good reading rather than nothing, labelled with
//    its age and the backoff.
{
  server.queue.length = 0;
  const { env, dataDir } = makeEnv({ data: "stale", options: { POLL_INTERVAL_SECONDS: 60 } });
  server.queue.push({ status: 200, body: usagePayload({ session: 50, weekly: 70 }) });
  await hook(env, { hook_event_name: "SessionStart", session_id: "s1" });

  ageCache(dataDir, 10 * 60_000);
  server.queue.push({ status: 429, headers: { "retry-after": "300" }, body: {} });
  const result = await hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s2" });
  const context = contextOf(result);
  check("stale reading is still served", context.includes("session 50%"), context);
  check("staleness is labelled", /measured \d+m ago/.test(context), context);
  check("backoff is labelled", /backed off/.test(context), context);
}

// 8. Concurrent sessions share one poll: the lock must hold across processes.
{
  server.queue.length = 0;
  const { env } = makeEnv({ data: "concurrent" });
  const before = server.requests;
  const events = Array.from({ length: 6 }, (_, i) => hook(env, { hook_event_name: "SessionStart", session_id: `s${i}` }));
  const results = await Promise.all(events);
  check("all concurrent hooks exit 0", results.every((r) => r.code === 0), results.map((r) => r.code).join(","));
  check("six concurrent sessions poll once", server.requests === before + 1, `requests=${server.requests - before}`);
}

// 9. Degraded environments never break the session, and never hide the reason:
//    the reader can only work around a failure it is told about, in enough
//    detail to tell a missing token from a proxy that ate the request. The one
//    exception is a repeat of the same failure, which is just noise.
{
  server.queue.length = 0;
  const { env, configDir } = makeEnv({ data: "nocreds", credentials: false });
  const noCreds = await hook(env, { hook_event_name: "SessionStart", session_id: "s1" });
  const noCredsContext = contextOf(noCreds);
  check("missing credentials exit 0", noCreds.code === 0, `code=${noCreds.code} stderr=${noCreds.stderr}`);
  check("missing credentials are reported", noCredsContext.includes("<quota-error>"), noCreds.stdout);
  check("the credentials file is named", noCredsContext.includes(join(configDir, ".credentials.json")), noCredsContext);
  check("the missing field is named", /claudeAiOauth\.accessToken/.test(noCredsContext), noCredsContext);

  // Same session, same failure: reported once, then silence.
  const repeat = await hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  check("a repeated failure stays silent", repeat.code === 0 && repeat.stdout.trim() === "", `${repeat.code} ${repeat.stdout}`);
  // The dedupe is per session, so a fresh context still learns about it.
  const otherSession = await hook(env, { hook_event_name: "SessionStart", session_id: "s2" });
  check("a new session hears the failure", contextOf(otherSession).includes("<quota-error>"), otherSession.stdout);

  const { env: env2 } = makeEnv({ data: "malformed" });
  const malformed = await run(HOOK, { env: env2, stdin: "not json{" });
  check("malformed stdin exits 0 silently", malformed.code === 0 && malformed.stdout.trim() === "", `${malformed.code} ${malformed.stdout}`);

  const unknown = await hook(env2, { hook_event_name: "PreToolUse", session_id: "s1" });
  check("unknown event is a no-op", unknown.code === 0 && unknown.stdout.trim() === "", unknown.stdout);

  const { env: env3 } = makeEnv({ data: "traversal" });
  server.queue.push({ status: 200, body: usagePayload() });
  await hook(env3, { hook_event_name: "SessionStart", session_id: "../../escape" });
  check("path traversal in session_id is rejected", !existsSync(join(root, "escape.json")), "wrote outside the data directory");

  const { env: env4 } = makeEnv({ data: "http500" });
  server.queue.push({ status: 500, body: { error: "boom" } });
  const failed = await hook(env4, { hook_event_name: "SessionStart", session_id: "s1" });
  const failedContext = contextOf(failed);
  check("a 500 exits 0", failed.code === 0, `code=${failed.code} stderr=${failed.stderr}`);
  check("the status code is reported", /HTTP 500/.test(failedContext), failedContext);
  check("the response body is reported", failedContext.includes("boom"), failedContext);
  check("the URL is reported", failedContext.includes(usageUrl), failedContext);
  check("the direct route is reported", /direct, no proxy/.test(failedContext), failedContext);
}

// 10. The MCP server speaks enough of the protocol to be usable.
{
  server.queue.length = 0;
  const { env } = makeEnv({ data: "mcp" });
  server.queue.push({ status: 200, body: usagePayload({ session: 71, weekly: 92, sessionResetsInS: 1200 }) });
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check", arguments: { history_hours: 1 } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
  ];
  const result = await run(MCP, { env, stdin: requests.map((r) => JSON.stringify(r)).join("\n") + "\n" });
  const replies = result.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));

  check("MCP exits 0", result.code === 0, `code=${result.code} stderr=${result.stderr}`);
  check("notifications get no reply", replies.length === 4, `replies=${replies.length}`);
  check("initialize advertises tools", byId[1]?.result?.capabilities?.tools !== undefined, JSON.stringify(byId[1]));
  check("tools/list returns check", byId[2]?.result?.tools?.[0]?.name === "check", JSON.stringify(byId[2]));

  const text = byId[3]?.result?.content?.[0]?.text ?? "";
  check("tools/call reports the windows", text.includes("session 71%") && text.includes("weekly 92%"), text);
  check("tools/call reports pace", /Pace: [A-Z]+/.test(text), text);
  check("tools/call labels freshness", /polled just now|from cache/.test(text), text);
  check("tools/call returns structured content", byId[3]?.result?.structuredContent?.snapshot?.windows?.length === 2, JSON.stringify(byId[3]?.result?.structuredContent));
  check("unknown tool is an error, not a crash", byId[4]?.error?.code === -32602, JSON.stringify(byId[4]));
}

// 11. History accumulates one row per poll and feeds the trend report.
{
  server.queue.length = 0;
  const { env, dataDir } = makeEnv({ data: "history", options: { POLL_INTERVAL_SECONDS: 60 } });
  for (const session of [10, 25]) {
    server.queue.push({ status: 200, body: usagePayload({ session, weekly: 50 }) });
    await hook(env, { hook_event_name: "SessionStart", session_id: `s${session}` });
    ageCache(dataDir);
  }
  const rows = readFileSync(join(dataDir, "history.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("one history row per poll", rows.length === 2, `rows=${rows.length}`);
  check("history records each window", rows[1].session === 25 && rows[1].weekly_all === 50, JSON.stringify(rows[1]));

  server.queue.push({ status: 200, body: usagePayload({ session: 25, weekly: 50 }) });
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check", arguments: { history_hours: 24 } } };
  const result = await run(MCP, { env, stdin: `${JSON.stringify(call)}\n` });
  const text = JSON.parse(result.stdout.trim()).result.content[0].text;
  check("trend reports the movement", /Trend over.*session \+15/s.test(text), text);
}

// 12. Cost: the hook runs once per prompt, so its overhead is on the critical
//     path of every turn. Cache hits must not pay for a network round trip.
{
  server.queue.length = 0;
  const { env } = makeEnv({ data: "overhead" });
  await hook(env, { hook_event_name: "SessionStart", session_id: "s1" });
  const started = Date.now();
  for (let i = 0; i < 5; i += 1) await hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  const each = (Date.now() - started) / 5;
  check("cached hook stays under 250ms", each < 250, `${Math.round(each)}ms per invocation`);
  console.log(`     (cached hook: ~${Math.round(each)}ms per invocation)`);
}

// 13. Proxy support. Node's fetch ignores HTTP_PROXY unless the process was
//     launched with NODE_USE_ENV_PROXY=1, which a hook cannot arrange for
//     itself, so the plugin does its own proxying -- and behind a corporate
//     proxy a direct request does not merely fail, it reaches the wrong
//     server. These cases cover the routing decision and the http path; the
//     https CONNECT tunnel shares openTunnel with it.
{
  server.queue.length = 0;

  // A real forwarding proxy: it must receive the absolute-URI request line.
  let proxied = 0;
  let lastRequestLine = null;
  const proxy = createServer((req, res) => {
    proxied += 1;
    lastRequestLine = req.url;
    const upstream = httpRequest(req.url, { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    upstream.end();
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  const { env } = makeEnv({ data: "proxy" });
  server.queue.push({ status: 200, body: usagePayload({ session: 33, weekly: 44 }) });
  const viaProxy = await hook({ ...env, HTTP_PROXY: proxyUrl }, { hook_event_name: "SessionStart", session_id: "s1" });
  check("request goes through the proxy", proxied === 1, `proxied=${proxied}`);
  check("proxy gets the absolute-URI form", lastRequestLine === usageUrl, String(lastRequestLine));
  check("proxied response is used", contextOf(viaProxy).includes("session 33%"), contextOf(viaProxy));

  // NO_PROXY must win, or every localhost tool breaks behind a corporate proxy.
  const { env: direct } = makeEnv({ data: "noproxy" });
  server.queue.push({ status: 200, body: usagePayload({ session: 21, weekly: 22 }) });
  const bypass = await hook(
    { ...direct, HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" },
    { hook_event_name: "SessionStart", session_id: "s1" },
  );
  check("NO_PROXY bypasses the proxy", proxied === 1, `proxied=${proxied}`);
  check("bypassed request still works", contextOf(bypass).includes("session 21%"), contextOf(bypass));

  // An unreachable proxy must not break the session -- and must say that the
  // proxy is what failed, since a bare "unavailable" sends the reader hunting
  // for a bad token instead.
  const { env: broken } = makeEnv({ data: "deadproxy" });
  const dead = await hook({ ...broken, HTTP_PROXY: "http://127.0.0.1:9" }, { hook_event_name: "SessionStart", session_id: "s1" });
  const deadContext = contextOf(dead);
  check("a dead proxy exits 0", dead.code === 0, `code=${dead.code} stderr=${dead.stderr}`);
  check("the connection error is reported", /ECONNREFUSED/.test(deadContext), deadContext);
  check("the URL is reported", deadContext.includes(usageUrl), deadContext);
  check("the proxy route is reported", deadContext.includes("via proxy http://127.0.0.1:9"), deadContext);

  proxy.close();
}

// 14. Proxy selection rules, tested directly: these decide whether a request
//     reaches the API at all.
{
  const { proxyFor } = await import("../scripts/request.mjs");
  const https = new URL("https://api.anthropic.com/x");
  const plain = new URL("http://api.anthropic.com/x");

  check("https_proxy wins for https", proxyFor(https, { https_proxy: "http://p:1" })?.port === "1");
  check("http_proxy is the https fallback", proxyFor(https, { HTTP_PROXY: "http://p:2" })?.port === "2");
  check("https_proxy is not used for http", proxyFor(plain, { https_proxy: "http://p:3" }) === null);
  check("a bare host:port is accepted", proxyFor(https, { HTTPS_PROXY: "localhost:1235" })?.hostname === "localhost");
  check("NO_PROXY suffix matches", proxyFor(https, { HTTPS_PROXY: "http://p:1", NO_PROXY: ".anthropic.com" }) === null);
  check("NO_PROXY wildcard matches", proxyFor(https, { HTTPS_PROXY: "http://p:1", no_proxy: "*" }) === null);
  check("NO_PROXY non-match still proxies", proxyFor(https, { HTTPS_PROXY: "http://p:1", NO_PROXY: "example.com" })?.port === "1");
  check("garbage proxy value is ignored", proxyFor(https, { HTTPS_PROXY: "http://[" }) === null);
}

/* ------------------------------------------------------------------ done */

http.close();

// Rewrites the cache timestamp so the next hook is due for a poll, without
// the test having to sleep out the real interval.
function ageCache(dataDir, byMs = 120_000) {
  const path = join(dataDir, "cache.json");
  const cache = JSON.parse(readFileSync(path, "utf8"));
  cache.at -= byMs;
  writeFileSync(path, JSON.stringify(cache));
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
