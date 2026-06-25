import { request } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:80";
const AUTH_FILE = path.join(__dirname, ".auth/admin.json");

export default async function globalSetup() {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  const ctx = await request.newContext({ baseURL: BASE_URL });
  const resp = await ctx.post("/api/auth/login", {
    data: { username: "admin", password: "admin" },
  });
  if (resp.status() !== 200) {
    throw new Error(`Global setup: login failed with HTTP ${resp.status()}`);
  }
  await ctx.storageState({ path: AUTH_FILE });
  await ctx.dispose();
}
