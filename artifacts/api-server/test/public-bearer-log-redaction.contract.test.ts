import express from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  values: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  auditLogTable: {},
  db: {
    insert: mocks.insert,
  },
}));

import {
  redactPublicBearerPath,
  serializeRequestForLog,
} from "../src/lib/request-log-redaction";
import { auditMutations } from "../src/middlewares/audit";

const RAW_TOKEN = "rawBearerToken_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

describe("public bearer request-log redaction", () => {
  it.each([
    [`/api/sign/${RAW_TOKEN}`, "/api/sign/:token"],
    [`/sign/${RAW_TOKEN}`, "/sign/:token"],
    [`/api/ppe/sign/${RAW_TOKEN}`, "/api/ppe/sign/:token"],
    [`/oopp/sign/${RAW_TOKEN}`, "/oopp/sign/:token"],
    [`/api/quotes/public/${RAW_TOKEN}`, "/api/quotes/public/:token"],
    [
      `/api/quotes/public/${RAW_TOKEN}/accept`,
      "/api/quotes/public/:token/accept",
    ],
    [`/quote-share/${RAW_TOKEN}`, "/quote-share/:token"],
    [`/api/q/board/${RAW_TOKEN}`, "/api/q/board/:token"],
    [
      `/api/q/board/${RAW_TOKEN}/documents/${"a".repeat(64)}`,
      `/api/q/board/:token/documents/${"a".repeat(64)}`,
    ],
    [`/api/ppe/confirm?token=${RAW_TOKEN}`, "/api/ppe/confirm"],
  ])("removes the raw credential from %s", (url, expected) => {
    const serialized = serializeRequestForLog({
      id: "request-id",
      method: "GET",
      url,
    });

    expect(serialized.url).toBe(expected);
    expect(JSON.stringify(serialized)).not.toContain(RAW_TOKEN);
  });

  it("preserves non-token paths while retaining the existing query omission", () => {
    expect(redactPublicBearerPath("/api/jobs/42?view=detail")).toBe(
      "/api/jobs/42",
    );
    expect(redactPublicBearerPath("/api/quotes/42/send")).toBe(
      "/api/quotes/42/send",
    );
  });

  it("never serializes the Authorization header on canonical public routes", () => {
    const serialized = serializeRequestForLog({
      id: "request-id",
      method: "GET",
      url: "/api/sign",
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    } as Parameters<typeof serializeRequestForLog>[0]);

    expect(serialized.url).toBe("/api/sign");
    expect(JSON.stringify(serialized)).not.toContain(RAW_TOKEN);
    expect(serialized).not.toHaveProperty("headers");
  });

  it("wires the sanitizer into request logging, the 5xx ring buffer, and explicit error logs", () => {
    const appSource = readFileSync(
      new URL("../src/app.ts", import.meta.url),
      "utf8",
    );

    expect(appSource).toContain("req: serializeRequestForLog");
    expect(appSource).toContain(
      "route: redactPublicBearerPath(_req.path) ?? _req.path",
    );
    expect(appSource).toContain(
      "const path = redactPublicBearerPath(req.path) ?? req.path",
    );
  });

  it("suppresses only public bearer routes in the inner nginx access log", () => {
    const nginxSource = readFileSync(
      new URL("../../stavba/nginx.conf", import.meta.url),
      "utf8",
    );
    const guardedAccessLogs = nginxSource.match(
      /access_log \/var\/log\/nginx\/access\.log combined if=\$log_public_bearer_request;/g,
    );

    expect(nginxSource).toContain("map $uri $log_public_bearer_request");
    expect(nginxSource).toContain(
      "~^/(?:api/(?:sign|ppe/sign|ppe/confirm|quotes/public|q/board)|sign|oopp/sign|oopp/potvrdit|quote-share|q/board)(?:/|$) 0;",
    );
    expect(nginxSource).toContain("default 1;");
    expect(guardedAccessLogs).toHaveLength(2);
  });

  it("prevents legacy bearer URLs from being sent in the Referer header", () => {
    const headersSource = readFileSync(
      new URL("../../stavba/security-headers.conf", import.meta.url),
      "utf8",
    );

    expect(headersSource).toContain('Referrer-Policy "no-referrer"');
  });
});

describe("generic audit-log minimization", () => {
  beforeEach(() => {
    mocks.values.mockReset().mockResolvedValue(undefined);
    mocks.insert.mockReset().mockReturnValue({ values: mocks.values });
  });

  function testApp() {
    const app = express();
    app.use(express.json());
    app.use(auditMutations);
    app.use((_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  it.each([
    [`/sign/${RAW_TOKEN}`, "/sign/:token"],
    [`/ppe/sign/${RAW_TOKEN}`, "/ppe/sign/:token"],
    [`/quotes/public/${RAW_TOKEN}/accept`, "/quotes/public/:token/accept"],
    [`/quotes/public/${RAW_TOKEN}/reject`, "/quotes/public/:token/reject"],
  ])(
    "keeps the raw path token out of audit_log for %s",
    async (path, expectedPath) => {
      await request(testApp())
        .post(path)
        .send({ respondentName: "Jan Test", marker: "preserved" })
        .expect(200);

      await vi.waitFor(() => expect(mocks.values).toHaveBeenCalledTimes(1));
      const row = mocks.values.mock.calls[0]![0] as {
        path: string;
        summary: string;
      };
      expect(row.path).toBe(expectedPath);
      expect(row.path).not.toContain(RAW_TOKEN);
      expect(row.summary).toBe(`POST ${expectedPath}`);
      expect(row.summary).not.toContain("respondentName");
      expect(row.summary).not.toContain("Jan Test");
      expect(row.summary).not.toContain("marker");
      expect(row.summary).not.toContain("preserved");
    },
  );

  it("omits the PPE confirmation body from generic audit metadata", async () => {
    await request(testApp())
      .post("/ppe/confirm")
      .send({ token: RAW_TOKEN, marker: "preserved" })
      .expect(200);

    await vi.waitFor(() => expect(mocks.values).toHaveBeenCalledTimes(1));
    const row = mocks.values.mock.calls[0]![0] as {
      path: string;
      summary: string;
    };
    expect(row.path).toBe("/ppe/confirm");
    expect(row.summary).toBe("POST /ppe/confirm");
    expect(row.summary).not.toContain(RAW_TOKEN);
    expect(row.summary).not.toContain("token");
    expect(row.summary).not.toContain("marker");
    expect(row.summary).not.toContain("preserved");
  });

  it("omits signature image data carried by public signing routes", async () => {
    const signatureDataUrl = `data:image/png;base64,${"A".repeat(1200)}`;

    await request(testApp())
      .post(`/sign/${RAW_TOKEN}`)
      .send({ signatureDataUrl, marker: "preserved" })
      .expect(200);

    await vi.waitFor(() => expect(mocks.values).toHaveBeenCalledTimes(1));
    const row = mocks.values.mock.calls[0]![0] as {
      path: string;
      summary: string;
    };
    expect(row.path).toBe("/sign/:token");
    expect(row.summary).toBe("POST /sign/:token");
    expect(row.summary).not.toContain(signatureDataUrl);
    expect(row.summary).not.toContain("signatureDataUrl");
    expect(row.summary).not.toContain("marker");
    expect(row.summary).not.toContain("preserved");
  });

  it("keeps a non-token path but omits arbitrary nested request data", async () => {
    await request(testApp())
      .post("/jobs/42/tasks")
      .send({
        title: "preserved",
        AccessToken: RAW_TOKEN,
        nested: { arbitrarySecret: "must-not-persist" },
        values: ["also-not-persisted"],
      })
      .expect(200);

    await vi.waitFor(() => expect(mocks.values).toHaveBeenCalledTimes(1));
    const row = mocks.values.mock.calls[0]![0] as {
      path: string;
      summary: string;
    };
    expect(row.path).toBe("/jobs/42/tasks");
    expect(row.summary).toBe("POST /jobs/42/tasks");
    expect(row.summary).not.toContain("title");
    expect(row.summary).not.toContain("preserved");
    expect(row.summary).not.toContain("AccessToken");
    expect(row.summary).not.toContain(RAW_TOKEN);
    expect(row.summary).not.toContain("arbitrarySecret");
    expect(row.summary).not.toContain("must-not-persist");
    expect(row.summary).not.toContain("also-not-persisted");
  });

  it.each([
    "/billing/documents/42/disposition",
    "/billing/documents/42/status",
  ])(
    "leaves restricted accounting reasons to the caller-owned audit path for %s",
    async (path) => {
      await request(testApp())
        .post(path)
        .send({ reason: "restricted readable accounting reason" })
        .expect(200);

      expect(mocks.values).not.toHaveBeenCalled();
    },
  );
});
