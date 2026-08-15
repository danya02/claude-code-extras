// A single GET, dependency-free, that respects the proxy environment.
//
// Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY unless the process was
// started with NODE_USE_ENV_PROXY=1 -- and that variable is read at startup,
// so a script cannot set it for itself, while putting `VAR=1 node ...` in a
// hook command breaks on Windows. Behind a proxy that means the request goes
// out direct and comes back 403 from the CDN rather than reaching the API.
//
// So the plugin does its own transport: a CONNECT tunnel for https, the
// absolute-URI form for http, and node:https to parse the response either way.

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Returns { status, headers, body } -- rejects only on transport failure, so
// a 429 or a 403 is a normal resolution the caller decides about.
export async function getJson(rawUrl, headers = {}, timeoutMs = 5000) {
  const url = new URL(rawUrl);
  const proxy = proxyFor(url);

  if (!proxy) return await plainGet(url, headers, timeoutMs);
  if (url.protocol === "http:") return await proxiedPlainGet(url, proxy, headers, timeoutMs);
  return await tunnelledGet(url, proxy, headers, timeoutMs);
}

// The proxy variables are conventionally lowercase-first; NO_PROXY wins over
// both. An unparseable proxy value is treated as no proxy rather than an error.
export function proxyFor(url, env = process.env) {
  const isHttps = url.protocol === "https:";
  const raw = isHttps
    ? env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
    : env.http_proxy || env.HTTP_PROXY;
  if (!raw) return null;
  if (isBypassed(url.hostname, env.no_proxy || env.NO_PROXY)) return null;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

function isBypassed(hostname, noProxy) {
  if (!noProxy) return false;
  for (const entry of noProxy.split(",")) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    const bare = rule.startsWith(".") ? rule.slice(1) : rule;
    if (hostname === bare || hostname.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/* --------------------------------------------------------------- variants */

function plainGet(url, headers, timeoutMs) {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return collect(send(url, { method: "GET", headers, timeout: timeoutMs }), timeoutMs);
}

// An http proxy expects the absolute URI on the request line; node:http emits
// exactly that when given a path of the full URL.
function proxiedPlainGet(url, proxy, headers, timeoutMs) {
  const req = httpRequest({
    host: proxy.hostname,
    port: proxy.port || 80,
    method: "GET",
    path: url.toString(),
    headers: { host: url.host, ...headers, ...proxyAuth(proxy) },
    timeout: timeoutMs,
  });
  return collect(req, timeoutMs);
}

// https through a proxy: CONNECT to open a raw tunnel, then run TLS and an
// ordinary request over the tunnelled socket. Certificates are verified
// against the real hostname (servername), so the proxy cannot silently read
// the token.
async function tunnelledGet(url, proxy, headers, timeoutMs) {
  const port = Number(url.port) || 443;
  const socket = await openTunnel(proxy, url.hostname, port, timeoutMs);
  const req = httpsRequest(url, {
    method: "GET",
    // Both of these matter. Given a custom createConnection, Node derives the
    // Host header from the options rather than the URL and defaults the port
    // to 80 -- so the origin receives `Host: api.anthropic.com:80` on a TLS
    // connection and Cloudflare answers 520. Setting the port and the header
    // explicitly is what makes the tunnelled request indistinguishable from a
    // direct one.
    port,
    headers: { host: url.host, ...headers },
    timeout: timeoutMs,
    createConnection: () => tlsConnect({ socket, servername: url.hostname, ALPNProtocols: ["http/1.1"] }),
  });
  return await collect(req, timeoutMs);
}

function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, ...proxyAuth(proxy) },
      timeout: timeoutMs,
      agent: false, // CONNECT must own its socket; a pooled one would be reused
    });

    const fail = (err) => {
      req.destroy();
      reject(err);
    };

    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`proxy CONNECT returned ${res.statusCode}`));
      }
      socket.setTimeout(0); // the tunnel outlives the CONNECT request's timeout
      resolve(socket);
    });
    req.on("timeout", () => fail(new Error("proxy CONNECT timed out")));
    req.on("error", fail);
    req.end();
  });
}

function proxyAuth(proxy) {
  if (!proxy.username && !proxy.password) return {};
  const raw = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { "proxy-authorization": `Basic ${Buffer.from(raw).toString("base64")}` };
}

/* ---------------------------------------------------------------- reading */

function collect(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    // A response that starts but never ends would otherwise hang the hook past
    // its own timeout, so the whole exchange is bounded, not just the connect.
    const timer = setTimeout(() => {
      req.destroy(new Error("request timed out"));
    }, timeoutMs);
    timer.unref?.();

    req.on("timeout", () => req.destroy(new Error("socket timed out")));
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(new Error("response too large"));
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.end();
  });
}
