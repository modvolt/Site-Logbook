import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  db,
  pool,
  usersTable,
  billingSettingsTable,
  quotesTable,
  quoteItemsTable,
  quoteVersionsTable,
} from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { ObjectStorageService } from "../src/lib/objectStorage";
import pg from "pg";
import { readQuoteSnapshot } from "../src/lib/quote-version-service";

const smtp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../src/lib/email", () => ({ sendEmailWithPdf: smtp }));
const { createQuote, updateQuote, sendQuote, acceptQuote } =
  await import("../src/lib/quote-service");
let actor: number;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    url.hostname !== "127.0.0.1" ||
    !url.pathname.startsWith("/quote_hotfix_test") ||
    url.username !== "quote_hotfix_runtime"
  )
    throw new Error("Isolated restricted runtime DB required");
  process.env.PUBLIC_APP_URL = "https://quotes.test";
  await db.insert(billingSettingsTable).values({ id: 1 }).onConflictDoNothing();
  [actor] = (
    await db
      .insert(usersTable)
      .values({
        username: `quote-hotfix-${Date.now()}`,
        passwordHash: "unused",
        name: "Test",
        role: "admin",
        isActive: true,
      })
      .returning()
  ).map((x) => x.id);
  vi.spyOn(
    ObjectStorageService.prototype,
    "putPrivateObject",
  ).mockResolvedValue();
  vi.spyOn(
    ObjectStorageService.prototype,
    "deletePrivateObject",
  ).mockResolvedValue(true);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await pool.end();
});
describe.runIf(process.env.QUOTE_HOTFIX_RUNTIME_TEST_ENABLED === "true")(
  "quote restricted runtime hotfix",
  () => {
    it("reproduces the original PostgreSQL row-lock permission conflict", async () => {
      const permissions = await db.execute(
        sql`select current_user, has_table_privilege(current_user, 'quote_items', 'UPDATE') as items_update, has_any_column_privilege(current_user, 'quote_versions', 'UPDATE') as versions_update`,
      );
      expect(permissions.rows[0]).toMatchObject({
        current_user: "quote_hotfix_runtime",
        items_update: false,
        versions_update: false,
      });
      await expect(
        db.select().from(quoteItemsTable).for("share"),
      ).rejects.toThrow();
      await expect(
        db.select().from(quoteVersionsTable).for("key share"),
      ).rejects.toThrow();
    });
    it("sends as the restricted runtime role", async () => {
      const quote = await createQuote({
        title: "Žluťoučký kůň",
        items: [
          {
            description: "Elektroinstalace",
            quantity: 2,
            unitPrice: 100,
            vatRate: 21,
          },
        ],
      });
      await expect(
        sendQuote(quote!.id, {
          to: "customer@example.test",
          createdByUserId: actor,
        }),
      ).resolves.toMatchObject({ sent: true });
      expect(
        (
          await db
            .select()
            .from(quotesTable)
            .where(eq(quotesTable.id, quote!.id))
        )[0].status,
      ).toBe("sent");
    });
    it("keeps domain DB connections available for more concurrent sends than the coordination limit", async () => {
      const quotes = await Promise.all(Array.from({ length: 10 }, (_, i) => createQuote({ title: `Parallel send ${i}` })));
      let entered = 0;
      let ready!: () => void, release!: () => void;
      const firstFour = new Promise<void>(r => { ready = r; });
      const barrier = new Promise<void>(r => { release = r; });
      smtp.mockImplementation(async () => { if (++entered === 4) ready(); await barrier; });
      const sends = quotes.map(quote => sendQuote(quote!.id, { to: "customer@example.test", createdByUserId: actor }));
      try { await firstFour; release(); expect(await Promise.all(sends)).toHaveLength(10); }
      finally { release(); smtp.mockResolvedValue(undefined); }
    });
    for (const change of ["replace", "insert", "delete"] as const)
      it(`rejects concurrent item ${change} during generation without SMTP or mixed version`, async () => {
        const quote = (await createQuote({
          title: "Concurrent",
          items: [{ description: "Původní položka", unitPrice: 100 }],
        }))!;
        const before = smtp.mock.calls.length;
        vi.mocked(
          ObjectStorageService.prototype.putPrivateObject,
        ).mockImplementationOnce(async () => {
          await updateQuote(quote.id, {
            items:
              change === "delete"
                ? []
                : change === "replace"
                  ? [{ description: "Nová položka", unitPrice: 200 }]
                  : [
                      { description: "Původní položka", unitPrice: 100 },
                      { description: "Přidaná položka", unitPrice: 300 },
                    ],
          });
        });
        await expect(
          sendQuote(quote.id, {
            to: "customer@example.test",
            createdByUserId: actor,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(smtp.mock.calls).toHaveLength(before);
        expect(
          await db
            .select()
            .from(quoteVersionsTable)
            .where(eq(quoteVersionsTable.quoteId, quote.id)),
        ).toHaveLength(0);
      });
    it("rejects concurrent sends while SMTP is pending, then replays the completed attempt", async () => {
      const quote = (await createQuote({ title: "Double click" }))!;
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const barrier = new Promise<void>((r) => {
        release = r;
      });
      smtp.mockImplementationOnce(async () => {
        enter();
        await barrier;
      });
      const options = {
        to: "customer@example.test",
        createdByUserId: actor,
        idempotencyKey: `duplicate-${quote.id}`,
      };
      const first = sendQuote(quote.id, options);
      await entered;
      await expect(
        sendQuote(quote.id, {
          ...options,
          idempotencyKey: `other-${quote.id}`,
        }),
      ).rejects.toMatchObject({ code: "quote_delivery_in_progress" });
      release();
      const sent = await first;
      const calls = smtp.mock.calls.length;
      expect(await sendQuote(quote.id, options)).toEqual(sent);
      expect(smtp.mock.calls).toHaveLength(calls);
    });
    it("does not overwrite an accepted older version when reissue finishes", async () => {
      const quote = (await createQuote({ title: "Concurrent decision" }))!;
      await sendQuote(quote.id, {
        to: "customer@example.test",
        createdByUserId: actor,
      });
      const [before] = await db
        .select()
        .from(quotesTable)
        .where(eq(quotesTable.id, quote.id));
      smtp.mockImplementationOnce(async () => {
        await acceptQuote(quote.id, { userId: actor, name: "Admin" });
      });
      await expect(
        sendQuote(quote.id, {
          to: "customer@example.test",
          createdByUserId: actor,
        }),
      ).rejects.toMatchObject({ code: "quote_delivery_unknown" });
      const [after] = await db
        .select()
        .from(quotesTable)
        .where(eq(quotesTable.id, quote.id));
      expect(after.status).toBe("accepted");
      expect(after.pdfObjectPath).toBe(before.pdfObjectPath);
    });
    it("retains immutable PDF and refuses automatic replay after an ambiguous SMTP result", async () => {
      const quote = (await createQuote({ title: "Ambiguous SMTP" }))!;
      const options = {
        to: "customer@example.test",
        createdByUserId: actor,
        idempotencyKey: `unknown-${quote.id}`,
      };
      smtp.mockRejectedValueOnce(new Error("connection lost after DATA"));
      const deletes = vi.mocked(
        ObjectStorageService.prototype.deletePrivateObject,
      ).mock.calls.length;
      await expect(sendQuote(quote.id, options)).rejects.toMatchObject({
        code: "quote_delivery_unknown",
      });
      const calls = smtp.mock.calls.length;
      await expect(sendQuote(quote.id, options)).rejects.toMatchObject({
        code: "quote_delivery_unknown",
      });
      expect(smtp.mock.calls).toHaveLength(calls);
      expect(
        vi.mocked(ObjectStorageService.prototype.deletePrivateObject).mock
          .calls,
      ).toHaveLength(deletes);
      expect(
        (
          await db
            .select()
            .from(quotesTable)
            .where(eq(quotesTable.id, quote.id))
        )[0].status,
      ).toBe("draft");
    });
    it("does not call SMTP when storage fails", async () => {
      const quote = (await createQuote({ title: "Storage failure" }))!;
      vi.mocked(
        ObjectStorageService.prototype.putPrivateObject,
      ).mockRejectedValueOnce(new Error("isolated storage failure"));
      const before = smtp.mock.calls.length;
      await expect(
        sendQuote(quote.id, {
          to: "customer@example.test",
          createdByUserId: actor,
        }),
      ).rejects.toThrow("isolated storage failure");
      expect(smtp.mock.calls).toHaveLength(before);
    });
    it("does not resend when the final DB write fails after SMTP acceptance", async () => {
      const quote = (await createQuote({ title: "DB failure after SMTP" }))!;
      const options = {
        to: "customer@example.test",
        createdByUserId: actor,
        idempotencyKey: `db-failure-${quote.id}`,
      };
      let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
      smtp.mockImplementationOnce(async () => {
        transactionSpy = vi
          .spyOn(db, "transaction")
          .mockRejectedValueOnce(new Error("isolated final DB failure"));
      });
      try {
        await expect(sendQuote(quote.id, options)).rejects.toMatchObject({
          code: "quote_delivery_unknown",
        });
      } finally {
        transactionSpy?.mockRestore();
      }
      const calls = smtp.mock.calls.length;
      await expect(sendQuote(quote.id, options)).rejects.toMatchObject({
        code: "quote_delivery_unknown",
      });
      expect(smtp.mock.calls).toHaveLength(calls);
    });
    it("reads a single MVCC snapshot even when the quote and items change between SELECTs", async () => {
      const quote = (await createQuote({
        title: "Původní název",
        items: [{ description: "Původní položka", unitPrice: 100 }],
      }))!;
      const original = pg.Client.prototype.query;
      let changed = false;
      const querySpy = vi
        .spyOn(pg.Client.prototype, "query")
        .mockImplementation(function (this: pg.Client, ...args: any[]) {
          const query =
            typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
          if (!changed && query.includes('from "billing_settings"')) {
            changed = true;
            return updateQuote(quote.id, {
              title: "Nový název",
              items: [{ description: "Nová položka", unitPrice: 200 }],
            }).then(() => original.apply(this, args as any));
          }
          return original.apply(this, args as any);
        } as typeof original);
      try {
        const snapshot = await readQuoteSnapshot(quote.id);
        expect(changed).toBe(true);
        expect(snapshot.quote.title).toBe("Původní název");
        expect(snapshot.items.map((x) => x.description)).toEqual([
          "Původní položka",
        ]);
      } finally {
        querySpy.mockRestore();
      }
    });
  },
);
