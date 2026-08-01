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
