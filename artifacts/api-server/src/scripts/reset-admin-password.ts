import { stdin, stdout } from "node:process";
import bcrypt from "bcryptjs";
import { eq, or, sql } from "drizzle-orm";
import { auditLogTable, db, pool, usersTable, userSessionsTable } from "@workspace/db";

const MIN_PASSWORD_LENGTH = 12;

async function readHiddenLine(label: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Interactive password input requires a TTY.");
  }

  stdout.write(label);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Password reset cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPipedPair(): Promise<[string, string]> {
  let raw = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) raw += chunk;
  const lines = raw.replace(/\r/g, "").split("\n");
  return [lines[0] ?? "", lines[1] ?? ""];
}

async function main(): Promise<void> {
  const username = process.argv[2]?.trim();
  if (!username || process.argv.length > 3) {
    throw new Error(
      "Usage: pnpm --filter @workspace/api-server auth:reset-admin-password -- <admin-username>",
    );
  }

  const [password, confirmation] = stdin.isTTY
    ? [await readHiddenLine("New password: "), await readHiddenLine("Repeat password: ")]
    : await readPipedPair();

  if (password !== confirmation) throw new Error("Passwords do not match.");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must contain at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 128) throw new Error("Password must contain at most 128 characters.");

  const [target] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (!target || target.role !== "admin") {
    throw new Error("Active administrator account not found.");
  }
  if (!target.isActive) throw new Error("Administrator account is inactive; reactivate it separately.");

  const passwordHash = await bcrypt.hash(password, 12);
  const revokedCount = await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, target.id));
    const revoked = await tx
      .delete(userSessionsTable)
      .where(
        or(
          eq(userSessionsTable.userId, target.id),
          sql`${userSessionsTable.sess}->>'userId' = ${String(target.id)}`,
        ),
      )
      .returning({ sid: userSessionsTable.sid });
    await tx.insert(auditLogTable).values({
      actorUserId: null,
      actorName: "server-operator",
      action: "security_admin_password_reset",
      entityType: "users",
      entityId: target.id,
      summary: "Administrator password reset by local server operator; all sessions revoked.",
      method: "CLI",
      path: "auth:reset-admin-password",
    });
    return revoked.length;
  });

  stdout.write(`Administrator password reset; revoked sessions: ${revokedCount}.\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
