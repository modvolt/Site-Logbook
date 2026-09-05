import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  db,
  pool,
  usersTable,
  billingSettingsTable,
  quotesTable,
  quoteVersionsTable,
  publicAccessTokensTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import pg from "pg";
import { quoteLocalSinks, decodeEmail } from "./helpers/quote-local-sinks";
import {
  createQuote,
  updateQuote,
  sendQuote,
  acceptQuoteByToken,
  rejectQuoteByToken,
  acceptQuote,
} from "../src/lib/quote-service";
import {
  exportQuotePdf,
  reopenQuoteRevision,
} from "../src/lib/quote-version-service";
import quoteRoutes from "../src/routes/quotes";

let sinks: Awaited<ReturnType<typeof quoteLocalSinks>>;
let actor: number;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]{43})/.exec(text)![1];
const fixture = (title = "Žluťoučký kůň – elektroinstalace") =>
  createQuote({
    title,
    validUntil: "2026-12-31",
    notes: "Veřejná poznámka: Příliš žluťoučký kůň úpěl ďábelské ódy.",
    items: [
      { rowType: "section", description: "Rozvaděč a montáž" },
      {
        description:
          "Odborná montáž elektrického rozvaděče včetně výchozí revize",
        quantity: 2,
        unit: "hod",
        unitPrice: 100,
        purchaseUnitPrice: 37.13,
        vatRate: 21,
      },
      { rowType: "spacer", description: "" },
    ],
  });
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    url.hostname !== "127.0.0.1" ||
    !url.pathname.startsWith("/quote_hotfix_test") ||
    url.username !== "quote_hotfix_runtime"
  )
    throw new Error("Isolated runtime DB required");
  process.env.PUBLIC_APP_URL = "https://quotes.test";
  sinks = await quoteLocalSinks();
  await db
    .insert(billingSettingsTable)
    .values({ id: 1, supplierName: "MODVOLT test", vatPayer: true })
    .onConflictDoUpdate({
      target: billingSettingsTable.id,
      set: { supplierName: "MODVOLT test", vatPayer: true },
    });
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `quote-sink-${Date.now()}`,
      passwordHash: "unused",
      name: "Test",
      role: "admin",
      isActive: true,
    })
    .returning();
  actor = user.id;
});
afterAll(async () => {
  await sinks.close();
  await pool.end();
});

describe.runIf(process.env.QUOTE_HOTFIX_RUNTIME_TEST_ENABLED === "true")(
  "isolated quote integration",
  () => {
    it("integrates restricted DB, local SMTP and private storage; custom/default email and archive hashes match", async () => {
      for (const custom of [false, true]) {
        const quote = (await fixture())!;
        const before = sinks.emails.length;
        const options = {
          to: "customer@example.test",
          createdByUserId: actor,
          idempotencyKey: randomUUID(),
          subject: custom ? "Custom quote subject" : undefined,
          message: custom ? "Vlastní text zákazníkovi." : undefined,
        };
        const sent = await sendQuote(quote.id, options);
        expect(sinks.emails).toHaveLength(before + 1);
        const email = decodeEmail(sinks.emails.at(-1)!.raw);
        expect(sinks.emails.at(-1)!.recipient).toContain(
          "customer@example.test",
        );
        expect(email.headers).toContain(
          custom ? "Custom quote subject" : "Subject:",
        );
        expect(email.text).toContain(
          custom ? "Vlastní text zákazníkovi." : "Dobrý den,",
        );
        expect(
          email.text.match(/https:\/\/quotes.test\/quote-share#token=/g),
        ).toHaveLength(1);
        const archive = await exportQuotePdf(quote.id, sent.quoteVersion);
        expect(sha(email.pdf)).toBe(sent.pdfSha256);
        expect(sha(archive.buffer)).toBe(sent.pdfSha256);
        expect(await sendQuote(quote.id, options)).toEqual(sent);
        expect(sinks.emails).toHaveLength(before + 1);
        if (custom)
          await expect(
            rejectQuoteByToken(tokenFrom(email.text), {
              respondentName: "Test zákazníka",
            }),
          ).resolves.toMatchObject({ rejected: true });
        else {
          const decisions = await Promise.allSettled([
            acceptQuoteByToken(tokenFrom(email.text), {
              respondentName: "Test zákazníka",
            }),
            rejectQuoteByToken(tokenFrom(email.text), {
              respondentName: "Test zákazníka",
            }),
          ]);
          expect(
            decisions.filter((x) => x.status === "fulfilled"),
          ).toHaveLength(1);
        }
      }
    });

    it("exports a draft without email or storage IO and without any domain mutation, then reflects saved edits", async () => {
      const quote = (await fixture())!;
      const capture = async () =>
        (
          await db.execute(
            sql`select jsonb_build_object('quote',(select to_jsonb(q) from quotes q where id=${quote.id}), 'settings',(select to_jsonb(b) from billing_settings b where id=1), 'versions',(select count(*) from quote_versions where quote_id=${quote.id}), 'tokens',(select count(*) from public_access_tokens where resource_id=${quote.id} and purpose='quote_decision')) as state`,
          )
        ).rows[0].state;
      const before = await capture(),
        io = sinks.calls.length,
        mail = sinks.emails.length;
      const saved = {
        S3_BUCKET: process.env.S3_BUCKET,
        SMTP_HOST: process.env.SMTP_HOST,
      };
      delete process.env.S3_BUCKET;
      delete process.env.SMTP_HOST;
      let pdf: Awaited<ReturnType<typeof exportQuotePdf>>;
      try {
        pdf = await exportQuotePdf(quote.id);
      } finally {
        Object.assign(process.env, saved);
      }
      expect(await capture()).toEqual(before);
      expect(sinks.calls).toHaveLength(io);
      expect(sinks.emails).toHaveLength(mail);
      await updateQuote(quote.id, {
        title: "Nově uložená nabídka",
        items: [
          { description: "Jiný uložený obsah", quantity: 1, unitPrice: 555 },
        ],
      });
      expect(sha((await exportQuotePdf(quote.id)).buffer)).not.toBe(
        sha(pdf.buffer),
      );
      mkdirSync("../../.local/pdf", { recursive: true });
      writeFileSync("../../.local/pdf/short.pdf", pdf.buffer);
    });

    it("preserves original archive after reopening and failed reissue; missing archive never regenerates", async () => {
      const quote = (await fixture())!;
      await sendQuote(quote.id, {
        to: "customer@example.test",
        createdByUserId: actor,
      });
      const original = await exportQuotePdf(quote.id);
      sinks.refuse(true);
      await expect(
        sendQuote(quote.id, {
          to: "customer@example.test",
          createdByUserId: actor,
        }),
      ).rejects.toThrow();
      sinks.refuse(false);
      expect((await exportQuotePdf(quote.id)).buffer).toEqual(original.buffer);
      await acceptQuote(quote.id, { userId: actor, name: "Admin" });
      await reopenQuoteRevision({
        quoteId: quote.id,
        reason: "Oprava pracovní nabídky",
        actor: { userId: actor, name: "Admin" },
      });
      await updateQuote(quote.id, { title: "Pracovní revize" });
      expect((await exportQuotePdf(quote.id, 1)).buffer).toEqual(
        original.buffer,
      );
      expect((await exportQuotePdf(quote.id)).buffer).not.toEqual(
        original.buffer,
      );
      const [version] = await db
        .select()
        .from(quoteVersionsTable)
        .where(eq(quoteVersionsTable.quoteId, quote.id));
      await expect(
        db
          .update(quoteVersionsTable)
          .set({ pdfSha256: "0".repeat(64) })
          .where(eq(quoteVersionsTable.id, version.id)),
      ).rejects.toThrow();
      const puts = sinks.calls.filter((c) => c.startsWith("PUT")).length;
      sinks.objects.delete(
        `/quote-test/private/${version.pdfObjectPath.slice("/objects/".length)}`,
      );
      await expect(exportQuotePdf(quote.id, 1)).rejects.toThrow();
      expect(sinks.calls.filter((c) => c.startsWith("PUT"))).toHaveLength(puts);
    });

    it("enforces HTTP authorization and PDF headers; errors are JSON without attachment headers", async () => {
      const quote = (await fixture())!;
      const app = express();
      app.use((req, _res, next) => {
        if (req.get("Authorization") === "Bearer isolated-test")
          req.auth = {
            userId: actor,
            accountType: "internal",
            name: "Test",
            permissions: ["quotes.view"],
          } as typeof req.auth;
        if (req.get("Authorization") === "Bearer forbidden-test")
          req.auth = {
            userId: actor,
            accountType: "internal",
            name: "Test",
            permissions: [],
          } as typeof req.auth;
        next();
      });
      app.use("/api", quoteRoutes);
      await request(app).get(`/api/quotes/${quote.id}/pdf`).expect(401);
      await request(app)
        .get(`/api/quotes/${quote.id}/pdf`)
        .set("Authorization", "Bearer forbidden-test")
        .expect(403);
      const ok = await request(app)
        .get(`/api/quotes/${quote.id}/pdf`)
        .set("Authorization", "Bearer isolated-test")
        .expect(200);
      expect(ok.headers["content-type"]).toContain("application/pdf");
      expect(ok.headers["content-disposition"]).toContain("attachment;");
      expect(ok.headers["cache-control"]).toBe("private, no-store");
      const error = await request(app)
        .get(`/api/quotes/${quote.id}/pdf?version=9999`)
        .set("Authorization", "Bearer isolated-test")
        .expect(404);
      expect(error.headers["content-type"]).toContain("application/json");
      expect(error.headers["content-disposition"]).toBeUndefined();
    });

    it("renders long Czech descriptions, structural rows and multi-page notes for visual QA", async () => {
      const quote = (await createQuote({
        title: "Vícestránková nabídka – dlouhé české popisy",
        notes:
          "Poznámka s diakritikou: žluťoučký kůň, přípojka, měření. ".repeat(
            60,
          ),
        items: Array.from({ length: 65 }, (_, i) =>
          i % 10 === 0
            ? {
                rowType: "section" as const,
                description: `Sekce ${i / 10 + 1} – rozvaděče a příslušenství`,
              }
            : {
                description: `${i}. Montáž a měření elektrického zařízení včetně zapojení všech přívodů a kontrolního měření izolace.`,
                quantity: 2,
                unit: "ks",
                unitPrice: 100,
                purchaseUnitPrice: 37.13,
                vatRate: 21,
              },
        ),
      }))!;
      const pdf = await exportQuotePdf(quote.id);
      writeFileSync("../../.local/pdf/multipage.pdf", pdf.buffer);
      expect(pdf.buffer.length).toBeGreaterThan(10000);
    });
    it("keeps immutable triggers effective even for the table owner", async () => {
      const url = new URL(process.env.QUOTE_HOTFIX_ADMIN_URL!);
      if (
        url.hostname !== "127.0.0.1" ||
        !url.pathname.startsWith("/quote_hotfix_test") ||
        url.search
      )
        throw new Error("Disposable local admin connection required");
      const admin = new pg.Client({ connectionString: url.toString() });
      await admin.connect();
      try {
        const result = await admin.query(
          "select id from quote_versions limit 1",
        );
        expect(result.rows).toHaveLength(1);
        for (const change of [
          "pdf_sha256 = repeat('0',64)",
          "pdf_object_path = '/objects/wrong.pdf'",
          "data_snapshot = '{}'::jsonb",
          "snapshot_sha256 = repeat('0',64)",
        ]) {
          await expect(
            admin.query(`update quote_versions set ${change} where id=$1`, [
              result.rows[0].id,
            ]),
          ).rejects.toThrow(/immutable/);
        }
        await expect(
          admin.query("delete from quote_versions where id=$1", [
            result.rows[0].id,
          ]),
        ).rejects.toThrow(/immutable/);
      } finally {
        await admin.end();
      }
    });
  },
);
