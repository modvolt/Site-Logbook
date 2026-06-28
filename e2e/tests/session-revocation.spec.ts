import { test, expect, request } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:80";

function extractSid(setCookieHeader: string): string | null {
  const match = setCookieHeader.match(/stavba\.sid=s%3A([^.]+)\./);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

test.describe("Session revocation", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("revoking a session instantly locks out the device — even mid-use", async () => {
    const ctx1 = await request.newContext({ baseURL: BASE_URL });
    const ctx2 = await request.newContext({ baseURL: BASE_URL });

    try {
      const login1 = await ctx1.post("/api/auth/login", {
        data: { username: "admin", password: "admin" },
      });
      expect(login1.status(), "ctx1 login").toBe(200);

      const login2 = await ctx2.post("/api/auth/login", {
        data: { username: "admin", password: "admin" },
      });
      expect(login2.status(), "ctx2 login").toBe(200);

      const setCookie2 = login2.headers()["set-cookie"] ?? "";
      const sid2 = extractSid(setCookie2);
      expect(sid2, "ctx2 session ID extracted from cookie").toBeTruthy();

      const me2Before = await ctx2.get("/api/auth/me");
      expect(me2Before.status(), "ctx2 /auth/me before revocation").toBe(200);
      expect((await me2Before.json()).authenticated, "ctx2 authenticated before revocation").toBe(true);

      const protectedBefore = await ctx2.get("/api/users");
      expect(protectedBefore.status(), "ctx2 protected endpoint before revocation").toBe(200);

      const deleteResp = await ctx1.delete(`/api/sessions/${sid2}`);
      expect(deleteResp.status(), "DELETE session from ctx1").toBe(204);

      const me2After = await ctx2.get("/api/auth/me");
      expect(me2After.status(), "ctx2 /auth/me after revocation").toBe(200);
      expect((await me2After.json()).authenticated, "ctx2 reports not authenticated after revocation").toBe(false);

      const protectedAfter = await ctx2.get("/api/users");
      expect(protectedAfter.status(), "ctx2 protected endpoint returns 401 after revocation").toBe(401);

      const me1After = await ctx1.get("/api/auth/me");
      expect(me1After.status(), "ctx1 /auth/me still works").toBe(200);
      expect((await me1After.json()).authenticated, "ctx1 still authenticated after revoking ctx2").toBe(true);
    } finally {
      await ctx1.dispose();
      await ctx2.dispose();
    }
  });
});
