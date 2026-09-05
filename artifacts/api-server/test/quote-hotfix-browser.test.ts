import { describe, it, expect, afterAll } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import express from "express";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { db, pool, usersTable } from "@workspace/db";
import { createQuote, sendQuote, updateQuote } from "../src/lib/quote-service";
import { exportQuotePdf, reopenQuoteRevision } from "../src/lib/quote-version-service";
import { quoteLocalSinks } from "./helpers/quote-local-sinks";
import quoteRoutes from "../src/routes/quotes";

afterAll(async () => {
  await pool.end();
});
describe.runIf(process.env.QUOTE_HOTFIX_BROWSER_TEST_ENABLED === "true")(
  "quote browser download with isolated authenticated fixture",
  () => {
    it("downloads via the shared identity client at desktop/mobile sizes and blocks unsaved export", async () => {
      const dbUrl = new URL(process.env.DATABASE_URL!);
      if (
        dbUrl.hostname !== "127.0.0.1" ||
        !dbUrl.pathname.startsWith("/quote_hotfix_test") ||
        dbUrl.username !== "quote_hotfix_runtime"
      )
        throw new Error("Isolated runtime DB required");
      const [user] = await db
        .insert(usersTable)
        .values({
          username: `browser-quote-${Date.now()}`,
          passwordHash: "unused",
          name: "Lokální test",
          role: "admin",
          isActive: true,
        })
        .returning();
      const quote = (await createQuote({
        title: "Test stažení PDF",
        items: [
          {
            description: "Montáž rozvaděče",
            unitPrice: 250,
            quantity: 2,
            vatRate: 21,
          },
        ],
      }))!;
    const sinks = await quoteLocalSinks();
    process.env.PUBLIC_APP_URL = "https://quotes.test";
    await sendQuote(quote.id, { to: "customer@example.test", createdByUserId: user.id });
    const archive = await exportQuotePdf(quote.id, 1);
    await reopenQuoteRevision({ quoteId: quote.id, reason: "Test pracovní revize", actor: { userId: user.id, name: user.name } });
    await updateQuote(quote.id, { notes: "Aktuální uložená pracovní podoba" });
    const app = express();
      app.use(express.json());
      const scope = "a".repeat(64);
      const pdfRequests: string[] = [];
      let failPdf = false;
      app.get("/api/auth/me", (_req, res) =>
        res.json({
          authenticated: true,
          needsSetup: false,
          offlineScope: scope,
          user: {
            ...user,
            permissions: ["quotes.view", "quotes.manage", "customers.view"],
            permissionOverrides: [],
          },
        }),
      );
      app.use("/api", (req, res, next) => {
        if (!req.headers.cookie?.includes("quote-test-session=local")) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        if (req.path.endsWith("/pdf")) {
          pdfRequests.push(req.get("x-stavba-offline-scope") ?? "");
          if (req.get("x-stavba-offline-scope") !== scope) {
            res.status(428).json({ error: "Identity header required" });
            return;
          }
          if (failPdf) {
            res.status(503).json({ error: "Test: archiv dočasně nedostupný" });
            return;
          }
        }
        req.auth = {
          userId: user.id,
          accountType: "internal",
          name: user.name,
          permissions: ["quotes.view", "quotes.manage"],
        } as typeof req.auth;
        req.log = { error() {}, info() {}, warn() {} } as typeof req.log;
        next();
      });
      app.get("/api/customers", (_req, res) => res.json([]));
      app.use("/api", quoteRoutes);
      app.use("/api", (_req, res) => res.json({}));
      const web = resolve("../stavba/dist/public");
      app.use(express.static(web));
      app.use((_req, res) => res.sendFile(resolve(web, "index.html")));
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", r));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const browser = await chromium.launch({
        headless: true,
        ...(process.env.QUOTE_TEST_CHROMIUM
          ? { executablePath: process.env.QUOTE_TEST_CHROMIUM }
          : {}),
      });
      mkdirSync("../../.local/browser", { recursive: true });
      try {
        for (const viewport of [
          { width: 1440, height: 1000 },
          { width: 390, height: 844 },
        ]) {
          const context = await browser.newContext({
            viewport,
            acceptDownloads: true,
            serviceWorkers: "block",
          });
          await context.addCookies([
            {
              name: "quote-test-session",
              value: "local",
              url: origin,
              httpOnly: true,
            },
          ]);
          const page = await context.newPage();
          await page.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin
              ? route.continue()
              : route.abort(),
          );
          await page.goto(`${origin}/quotes/${quote.id}`);
          const button = page.getByRole("button", {
            name: "Stáhnout PDF",
            exact: true,
          });
          await browserExpect(button).toBeVisible();
          const downloadPromise = page.waitForEvent("download");
          await button.evaluate((element: HTMLButtonElement) => {
            element.click();
            element.click();
          });
          const download = await downloadPromise;
          const file = `../../.local/browser/quote-${viewport.width}.pdf`;
          await download.saveAs(file);
          expect(readFileSync(file).subarray(0, 5).toString()).toBe("%PDF-");
        expect(pdfRequests.at(-1)).toBe(scope);
        await page.getByRole("button", { name: "Archiv PDF" }).click();
        const archivedDownloadPromise = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: /Verze 1/ }).click();
        const archivedDownload = await archivedDownloadPromise;
        const archivedFile = `../../.local/browser/archive-${viewport.width}.pdf`;
        await archivedDownload.saveAs(archivedFile);
        expect(readFileSync(archivedFile)).toEqual(archive.buffer);
        expect(readFileSync(file)).not.toEqual(archive.buffer);
          await page.screenshot({
            path: `../../.local/browser/quote-${viewport.width}.png`,
            fullPage: true,
          });
          await page
            .getByRole("button", { name: "Upravit", exact: true })
            .click();
          const count = pdfRequests.length;
          await button.click();
          await browserExpect(
            page
              .getByText("Nejprve uložte úpravy nabídky.", { exact: true })
              .first(),
          ).toBeVisible();
          expect(pdfRequests).toHaveLength(count);
          await page.reload();
          await browserExpect(button).toBeVisible();
          failPdf = true;
          let unexpectedDownload = false;
          page.on("download", () => {
            unexpectedDownload = true;
          });
          await button.click();
          await browserExpect(
            page
              .getByText("Test: archiv dočasně nedostupný", { exact: true })
              .first(),
          ).toBeVisible();
          expect(unexpectedDownload).toBe(false);
          failPdf = false;
          await context.close();
        }
      } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
      await sinks.close();
      }
    }, 60000);
  },
);
