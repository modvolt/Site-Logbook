import type { Request } from "express";
import type { UserRole } from "@workspace/db";

export interface AuthenticatedSessionUser {
  id: number;
  username: string;
  role: string;
  name: string;
  sessionGeneration: number;
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Logout must not report success while a still-valid server session survives.
 * If the session store cannot destroy the row, revoke the authenticated user's
 * session generation so every copy of that session fails on its next request.
 */
export async function destroySessionOrRevokeIdentity(
  req: Request,
  revokeIdentity: (userId: number) => Promise<void>,
): Promise<"destroyed" | "identity-revoked"> {
  try {
    await destroySession(req);
    return "destroyed";
  } catch (destroyError) {
    const userId = req.auth?.userId;
    if (!userId) throw destroyError;
    try {
      await revokeIdentity(userId);
      return "identity-revoked";
    } catch (revokeError) {
      throw new AggregateError(
        [destroyError, revokeError],
        "Session destruction and identity revocation both failed",
      );
    }
  }
}

/**
 * Rotate an anonymous/pre-authentication session before attaching identity.
 * The response must be sent only after the new session is persisted.
 */
export async function establishAuthenticatedSession(
  req: Request,
  user: AuthenticatedSessionUser,
): Promise<void> {
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role as UserRole;
  req.session.name = user.name;
  req.session.sessionGeneration = user.sessionGeneration;
  try {
    await saveSession(req);
  } catch (error) {
    await destroySession(req).catch(() => undefined);
    throw error;
  }
}

export const SESSION_ISSUANCE_LOCK_NAMESPACE = 8457;

/**
 * Serialize the final active/generation check and session-store write against
 * offboarding. The transaction holds only an advisory lock, not a users row
 * lock, so the session store can safely persist through its own pool client.
 */
export async function establishAuthenticatedSessionIfCurrent(
  req: Request,
  user: AuthenticatedSessionUser,
): Promise<boolean> {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  let transactionOpen = false;
  let sessionEstablished = false;
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("select pg_advisory_xact_lock($1, $2)", [
      SESSION_ISSUANCE_LOCK_NAMESPACE,
      user.id,
    ]);
    const current = await client.query<{
      is_active: boolean;
      session_generation: number;
    }>(
      `select is_active, session_generation
         from users
        where id = $1`,
      [user.id],
    );
    const row = current.rows[0];
    if (
      !row?.is_active ||
      row.session_generation !== user.sessionGeneration
    ) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return false;
    }

    await establishAuthenticatedSession(req, user);
    sessionEstablished = true;
    await client.query("COMMIT");
    transactionOpen = false;
    return true;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error
            ? rollbackError
            : new Error("Session issuance rollback failed");
      }
    }
    if (sessionEstablished) await destroySession(req).catch(() => undefined);
    throw error;
  } finally {
    client.release(releaseError);
  }
}
