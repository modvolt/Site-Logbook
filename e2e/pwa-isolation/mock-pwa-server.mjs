import { createHash } from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "../../artifacts/stavba/dist/public");
const port = Number(process.argv[2] ?? 4192);
const host = "127.0.0.1";

if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(`Invalid loopback port: ${process.argv[2] ?? ""}`);
}

const identities = {
  alice: {
    cookie: "A",
    id: 101,
    username: "alice",
    name: "Alice R14",
    marker: "ALICE_ONLY_R14",
    scope: "a".repeat(64),
  },
  bob: {
    cookie: "B",
    id: 202,
    username: "bob",
    name: "Bob R14",
    marker: "BOB_ONLY_R14",
    scope: "b".repeat(64),
  },
};

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

let state;
let heldMutation;

function resetState() {
  if (heldMutation) {
    heldMutation();
    heldMutation = undefined;
  }
  state = {
    swVersion: 1,
    holdFirstMutation: false,
    dropFirstResponseAfterCommit: false,
    delayBobToday: false,
    jobResponseScopeFault: "none",
    revoked: new Set(),
    requests: [],
    mutationAttempts: [],
    ledgers: new Map(),
    effects: [],
    replays: 0,
    logoutCompletions: 0,
    scopeRejections: [],
  };
}

resetState();

function identityFromRequest(request) {
  const cookie = request.headers.cookie ?? "";
  const match = /(?:^|;\s*)r14\.identity=([AB])(?:;|$)/.exec(cookie);
  if (!match) return null;
  return Object.values(identities).find((identity) => identity.cookie === match[1]) ?? null;
}

function userResponse(identity) {
  return {
    authenticated: true,
    needsSetup: false,
    offlineScope: identity.scope,
    user: {
      id: identity.id,
      username: identity.username,
      name: identity.name,
      personId: identity.id,
      email: null,
      role: "guest",
      isActive: true,
      createdAt: "2026-08-04T00:00:00.000Z",
      permissions: ["jobs.view", "jobs.work"],
      permissionOverrides: [],
    },
  };
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sanitizedState() {
  return {
    swVersion: state.swVersion,
    requests: state.requests,
    mutationAttempts: state.mutationAttempts,
    ledgerCount: state.ledgers.size,
    effectCount: state.effects.length,
    effects: state.effects,
    replays: state.replays,
    logoutCompletions: state.logoutCompletions,
    scopeRejections: state.scopeRejections,
    heldMutation: Boolean(heldMutation),
  };
}

function requestRecord(request, url, identity) {
  return {
    method: request.method,
    path: url.pathname,
    identity: identity?.username ?? "anonymous",
  };
}

async function serveApi(request, response, url) {
  const identity = identityFromRequest(request);
  state.requests.push(requestRecord(request, url, identity));

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const body = await readJson(request);
    const next = identities[body.username];
    if (!next || body.password !== "R14-local-only") {
      json(response, 401, { error: "Invalid synthetic credentials" });
      return;
    }
    response.setHeader(
      "Set-Cookie",
      `r14.identity=${next.cookie}; Path=/; HttpOnly; SameSite=Lax`,
    );
    json(response, 200, userResponse(next).user);
    return;
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    response.setHeader(
      "Set-Cookie",
      "r14.identity=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    response.writeHead(204, { "Cache-Control": "private, no-store" });
    state.logoutCompletions += 1;
    response.end();
    return;
  }

  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    if (!identity || state.revoked.has(identity.username)) {
      json(response, 200, { authenticated: false, needsSetup: false });
      return;
    }
    json(response, 200, userResponse(identity), {
      "X-Stavba-Offline-Scope": identity.scope,
    });
    return;
  }

  if (!identity || state.revoked.has(identity.username)) {
    if (identity) {
      response.setHeader(
        "Set-Cookie",
        "r14.identity=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      );
    }
    json(response, 401, { error: "Unauthorized" });
    return;
  }

  const scopeHeaders = { "X-Stavba-Offline-Scope": identity.scope };

  if (url.pathname === "/api/events" && request.method === "GET") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...scopeHeaders,
    });
    response.write("retry: 60000\n\n");
    const heartbeat = setInterval(() => response.write(": r14\n\n"), 20_000);
    response.on("close", () => clearInterval(heartbeat));
    return;
  }

  const suppliedScope = String(request.headers["x-stavba-offline-scope"] ?? "");
  if (!suppliedScope) {
    state.scopeRejections.push({ path: url.pathname, code: "identity_scope_required" });
    json(response, 428, { error: "Identity scope required", code: "identity_scope_required" });
    return;
  }
  if (suppliedScope !== identity.scope) {
    state.scopeRejections.push({ path: url.pathname, code: "offline_scope_mismatch" });
    json(response, 409, { error: "Offline identity changed", code: "offline_scope_mismatch" });
    return;
  }

  if (url.pathname === "/api/dashboard/today" && request.method === "GET") {
    if (identity.username === "bob" && state.delayBobToday) {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
    json(response, 200, [{
      id: 42,
      jobNumber: 42,
      title: identity.marker,
      shortName: identity.marker,
      type: "other",
      date: "2026-08-04",
      status: "planned",
      assignedPersonId: identity.id,
      assignedPersonName: identity.name,
      assigneeIds: [identity.id],
      assigneeNames: [identity.name],
      taskCount: 0,
      taskDoneCount: 0,
      materialCount: 0,
      consumedMaterialCount: 0,
      attachmentCount: 0,
      createdAt: "2026-08-04T00:00:00.000Z",
    }], scopeHeaders);
    return;
  }

  if (url.pathname === "/api/jobs/42" && request.method === "GET") {
    const responseIdentity = state.jobResponseScopeFault === "mismatch" ? identities.bob : identity;
    const responseHeaders = state.jobResponseScopeFault === "missing"
      ? {}
      : { "X-Stavba-Offline-Scope": responseIdentity.scope };
    json(response, 200, {
      id: 42,
      title: responseIdentity.marker,
      ownerMarker: responseIdentity.marker,
    }, responseHeaders);
    return;
  }

  if (url.pathname === "/api/jobs/42/materials" && request.method === "POST") {
    const body = await readJson(request);
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
    const bodySha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const fingerprint = `${request.method}:${url.pathname}:${bodySha256}`;
    const ledgerKey = `${identity.username}:${idempotencyKey}`;
    const attempt = {
      identity: identity.username,
      suppliedScope,
      idempotencyKey,
      bodySha256,
      fingerprint,
    };
    state.mutationAttempts.push(attempt);

    if (!idempotencyKey) {
      json(response, 400, { error: "Idempotency key required", code: "idempotency_key_required" });
      return;
    }
    if (suppliedScope !== identity.scope) {
      json(response, 409, { error: "Offline identity changed", code: "offline_scope_mismatch" });
      return;
    }

    const existing = state.ledgers.get(ledgerKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        json(response, 409, { error: "Idempotency key reused", code: "idempotency_key_reused" });
        return;
      }
      state.replays += 1;
      json(response, 201, existing.responseBody, {
        "Idempotency-Replayed": "true",
      });
      return;
    }

    if (state.holdFirstMutation && !heldMutation) {
      await new Promise((resolve) => {
        heldMutation = resolve;
      });
      heldMutation = undefined;
    }

    const responseBody = { id: state.effects.length + 1, jobId: 42 };
    state.ledgers.set(ledgerKey, { fingerprint, responseBody });
    state.effects.push({ identity: identity.username, idempotencyKey, bodySha256 });

    if (state.dropFirstResponseAfterCommit) {
      state.dropFirstResponseAfterCommit = false;
      response.destroy();
      return;
    }

    json(response, 201, responseBody);
    return;
  }

  json(response, 404, { error: `Unexpected mock API request: ${request.method} ${url.pathname}` });
}

async function serveControl(request, response, url) {
  if (url.pathname === "/__test/health" && request.method === "GET") {
    json(response, 200, { ok: true, loopback: true });
    return;
  }
  if (url.pathname === "/__test/reset" && request.method === "POST") {
    resetState();
    json(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/__test/state" && request.method === "GET") {
    json(response, 200, sanitizedState());
    return;
  }
  if (url.pathname === "/__test/sw-version" && request.method === "POST") {
    const body = await readJson(request);
    if (body.version !== 1 && body.version !== 2) {
      json(response, 400, { error: "SW version must be 1 or 2" });
      return;
    }
    state.swVersion = body.version;
    json(response, 200, { ok: true, version: state.swVersion });
    return;
  }
  if (url.pathname === "/__test/faults" && request.method === "POST") {
    const body = await readJson(request);
    state.holdFirstMutation = body.holdFirstMutation === true;
    state.dropFirstResponseAfterCommit = body.dropFirstResponseAfterCommit === true;
    state.delayBobToday = body.delayBobToday === true;
    state.jobResponseScopeFault = ["missing", "mismatch"].includes(body.jobResponseScopeFault)
      ? body.jobResponseScopeFault
      : "none";
    json(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/__test/release-mutation" && request.method === "POST") {
    if (heldMutation) heldMutation();
    json(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/__test/revoke" && request.method === "POST") {
    const body = await readJson(request);
    if (!identities[body.username]) {
      json(response, 400, { error: "Unknown synthetic identity" });
      return;
    }
    state.revoked.add(body.username);
    json(response, 200, { ok: true });
    return;
  }
  json(response, 404, { error: `Unexpected test control request: ${request.method} ${url.pathname}` });
}

async function serveStatic(request, response, url) {
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const requested = path.resolve(root, relative);
  const fromRoot = path.relative(root, requested);
  if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
    response.writeHead(403);
    response.end();
    return;
  }

  try {
    let data = await readFile(requested);
    if (url.pathname === "/sw.js") {
      const marker = `R14_SW_V${state.swVersion}`;
      const instrumentation = `\nself.__R14_BUILD_MARKER__=${JSON.stringify(marker)};\nself.addEventListener("message",event=>{if(event.data?.type==="R14_GET_VERSION"&&event.source){event.source.postMessage({type:"R14_SW_VERSION",version:${JSON.stringify(marker)}})}});\n`;
      data = Buffer.concat([data, Buffer.from(instrumentation)]);
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(requested)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      ...(url.pathname === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
    });
    response.end(data);
  } catch {
    const data = await readFile(path.join(root, "index.html"));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(data);
  }
}

const server = http.createServer(async (request, response) => {
  const hostHeader = request.headers.host ?? "";
  if (hostHeader !== `${host}:${port}`) {
    json(response, 421, { error: "Loopback host required" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  try {
    if (url.pathname.startsWith("/__test/")) {
      await serveControl(request, response, url);
    } else if (url.pathname.startsWith("/api/")) {
      await serveApi(request, response, url);
    } else {
      await serveStatic(request, response, url);
    }
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : "Mock server failure" });
  }
});

server.listen(port, host, () => {
  console.log(`[pwa-isolation] http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
