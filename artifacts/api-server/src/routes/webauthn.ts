import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import {
  db,
  webauthnCredentialsTable,
  usersTable,
  auditLogTable,
  type UserRole,
} from "@workspace/db";
import { serializeUser } from "./auth";
import { getPermissionOverrides } from "../lib/permissions";
import rateLimit from "express-rate-limit";
import { establishAuthenticatedSessionIfCurrent } from "../lib/auth-session";
import { establishVaultStepUp } from "../lib/vault-step-up";
import {
  auditSecurityResponse,
  recordRateLimitAuditEvent,
  SECURITY_AUDIT_CODES,
} from "../lib/security-audit";
import {
  lockAndAuthorizeUserManager,
  UserOffboardingError,
} from "../lib/user-offboarding-service";
import { webauthnRelyingParty } from "../lib/webauthn-rp";

const router: IRouter = Router();

const webauthnLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: async (req, res) => {
    await recordRateLimitAuditEvent(req, "webauthn");
    res.status(429).json({ error: "Příliš mnoho pokusů. Zkuste to prosím za chvíli." });
  },
  skip: (req) => {
    const ip = req.ip ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});

function getRpId(req: Parameters<typeof webauthnRelyingParty>[0]): string {
  return webauthnRelyingParty(req).rpId;
}

function getRpOrigin(req: Parameters<typeof webauthnRelyingParty>[0]): string {
  return webauthnRelyingParty(req).origin;
}

function serializeCred(c: typeof webauthnCredentialsTable.$inferSelect) {
  return {
    id: c.id,
    userId: c.userId,
    deviceName: c.deviceName,
    createdAt: c.createdAt.toISOString(),
  };
}

const auditRegistrationComplete = auditSecurityResponse({
  succeededCode: SECURITY_AUDIT_CODES.webauthnRegistrationSucceeded,
  deniedCode: SECURITY_AUDIT_CODES.webauthnRegistrationDenied,
  actorUserId: (req) => req.auth?.userId,
  skipUnauthenticated: true,
  dedupeDeniedByActorAndSource: true,
});
const auditLoginComplete = auditSecurityResponse({
  succeededCode: SECURITY_AUDIT_CODES.webauthnLoginSucceeded,
  deniedCode: SECURITY_AUDIT_CODES.webauthnLoginDenied,
  actorUserId: (req) => req.session.userId,
});
const auditVerifyComplete = auditSecurityResponse({
  succeededCode: SECURITY_AUDIT_CODES.webauthnVerifySucceeded,
  deniedCode: SECURITY_AUDIT_CODES.webauthnVerifyDenied,
  actorUserId: (req) => req.auth?.userId,
  skipUnauthenticated: true,
  dedupeDeniedByActorAndSource: true,
});

router.post("/auth/webauthn/register/begin", async (req, res): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [user] = await db
    .select({ id: usersTable.id, username: usersTable.username, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, req.auth.userId));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const existingCreds = await db
    .select({ credentialId: webauthnCredentialsTable.credentialId })
    .from(webauthnCredentialsTable)
    .where(eq(webauthnCredentialsTable.userId, user.id));

  const options = await generateRegistrationOptions({
    rpName: "Stavba",
    rpID: getRpId(req),
    userName: user.username,
    userDisplayName: user.name ?? user.username,
    excludeCredentials: existingCreds.map((c) => ({
      id: c.credentialId,
    })),
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      userVerification: "required",
      // "preferred" ensures the authenticator stores a resident/discoverable
      // credential on the device, which is required for the no-username
      // (passkey) login flow to work reliably across all devices.
      residentKey: "preferred",
    },
  });

  req.session.webauthnChallenge = options.challenge;
  res.json(options);
});

router.post("/auth/webauthn/register/complete", auditRegistrationComplete, async (req, res): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const challenge = req.session.webauthnChallenge;
  if (!challenge) {
    res.status(400).json({ error: "No pending challenge" });
    return;
  }
  delete req.session.webauthnChallenge;

  const { response, deviceName } = req.body as {
    response: unknown;
    deviceName?: string;
  };

  if (!response || typeof response !== "object") {
    res.status(400).json({ error: "Missing response" });
    return;
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: getRpOrigin(req as any),
      expectedRPID: getRpId(req),
      requireUserVerification: true,
    });
  } catch {
    res.status(400).json({ error: "Registraci bezpečnostního klíče nelze ověřit" });
    return;
  }

  if (!verification.verified || !verification.registrationInfo) {
    res.status(400).json({ error: "Registration not verified" });
    return;
  }

  const { credential } = verification.registrationInfo;

  const saved = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${req.auth!.userId} for update`);
    const [lockedUser] = await tx
      .select({
        isActive: usersTable.isActive,
        sessionGeneration: usersTable.sessionGeneration,
      })
      .from(usersTable)
      .where(eq(usersTable.id, req.auth!.userId));
    if (!lockedUser?.isActive || req.session.sessionGeneration !== lockedUser.sessionGeneration) {
      return { status: "access_revoked" } as const;
    }

    const [existing] = await tx
      .select({ id: webauthnCredentialsTable.id })
      .from(webauthnCredentialsTable)
      .where(eq(webauthnCredentialsTable.credentialId, credential.id));
    if (existing) return { status: "duplicate" } as const;

    const [inserted] = await tx
      .insert(webauthnCredentialsTable)
      .values({
        userId: req.auth!.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64"),
        counter: credential.counter,
        deviceName: deviceName?.trim() || null,
      })
      .returning();
    if (!inserted) throw new Error("WebAuthn credential was not inserted");
    return { status: "saved", value: inserted } as const;
  });

  if (saved.status === "access_revoked") {
    res.status(403).json({ error: "Přístup byl mezitím odvolán", code: "access_revoked" });
    return;
  }
  if (saved.status === "duplicate") {
    res.status(409).json({ error: "Zařízení je již registrováno" });
    return;
  }

  res.status(201).json(serializeCred(saved.value));
});

router.post("/auth/webauthn/login/begin", webauthnLimiter, async (req, res): Promise<void> => {
  const { username } = req.body as { username?: string };
  const trimmedUsername = username?.trim() ?? "";

  if (trimmedUsername) {
    const [user] = await db
      .select({ id: usersTable.id, username: usersTable.username, isActive: usersTable.isActive })
      .from(usersTable)
      .where(eq(usersTable.username, trimmedUsername));

    const creds =
      user && user.isActive
        ? await db
            .select({ credentialId: webauthnCredentialsTable.credentialId })
            .from(webauthnCredentialsTable)
            .where(eq(webauthnCredentialsTable.userId, user.id))
        : [];

    const options = await generateAuthenticationOptions({
      rpID: getRpId(req),
      userVerification: "required",
      allowCredentials: creds.map((c) => ({ id: c.credentialId })),
    });

    req.session.webauthnChallenge = options.challenge;
    req.session.webauthnUsername = trimmedUsername;
    res.json(options);
    return;
  }

  // Discoverable / resident-credential flow: no username supplied.
  // Return allow-list from ALL active users so the authenticator can match
  // the stored credential without needing the user to type a username first.
  const allCreds = await db
    .select({ credentialId: webauthnCredentialsTable.credentialId })
    .from(webauthnCredentialsTable)
    .innerJoin(usersTable, eq(webauthnCredentialsTable.userId, usersTable.id))
    .where(eq(usersTable.isActive, true));

  const options = await generateAuthenticationOptions({
    rpID: getRpId(req),
    userVerification: "required",
    allowCredentials: allCreds.map((c) => ({ id: c.credentialId })),
  });

  req.session.webauthnChallenge = options.challenge;
  // webauthnUsername intentionally not set — login/complete will resolve by credential id
  res.json(options);
});

router.post("/auth/webauthn/login/complete", webauthnLimiter, auditLoginComplete, async (req, res): Promise<void> => {
  const challenge = req.session.webauthnChallenge;
  const username = req.session.webauthnUsername;

  if (!challenge) {
    res.status(400).json({ error: "No pending challenge" });
    return;
  }
  delete req.session.webauthnChallenge;
  delete req.session.webauthnUsername;

  const { response } = req.body as { response: unknown };
  if (!response || typeof response !== "object") {
    res.status(400).json({ error: "Missing response" });
    return;
  }

  const responseObj = response as { id?: string; rawId?: string };
  const credId = responseObj.id ?? responseObj.rawId ?? "";

  let cred: typeof webauthnCredentialsTable.$inferSelect | undefined;
  let user: typeof usersTable.$inferSelect | undefined;

  if (username) {
    // Username-scoped flow: look up user first, then verify credential belongs to them
    const [foundUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.username, username));

    if (!foundUser || !foundUser.isActive) {
      res.status(401).json({ error: "Neplatné přihlašovací údaje" });
      return;
    }
    user = foundUser;

    const [foundCred] = await db
      .select()
      .from(webauthnCredentialsTable)
      .where(
        and(
          eq(webauthnCredentialsTable.userId, foundUser.id),
          eq(webauthnCredentialsTable.credentialId, credId),
        ),
      );

    if (!foundCred) {
      res.status(401).json({ error: "Zařízení není registrováno" });
      return;
    }
    cred = foundCred;
  } else {
    // Discoverable flow: look up credential by id, then resolve the owning user
    const [foundCred] = await db
      .select()
      .from(webauthnCredentialsTable)
      .where(eq(webauthnCredentialsTable.credentialId, credId));

    if (!foundCred) {
      res.status(401).json({ error: "Zařízení není registrováno" });
      return;
    }
    cred = foundCred;

    const [foundUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, foundCred.userId));

    if (!foundUser || !foundUser.isActive) {
      res.status(401).json({ error: "Neplatné přihlašovací údaje" });
      return;
    }
    user = foundUser;
  }

  if (!cred || !user) {
    res.status(401).json({ error: "Neplatné přihlašovací údaje" });
    return;
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: getRpOrigin(req as any),
      expectedRPID: getRpId(req),
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: Buffer.from(cred.publicKey, "base64"),
        counter: cred.counter,
      },
    });
  } catch {
    res.status(401).json({ error: "Biometrické ověření selhalo" });
    return;
  }

  if (!verification.verified) {
    res.status(401).json({ error: "Biometrické ověření selhalo" });
    return;
  }

  await db
    .update(webauthnCredentialsTable)
    .set({ counter: verification.authenticationInfo.newCounter })
    .where(eq(webauthnCredentialsTable.id, cred.id));

  if (!(await establishAuthenticatedSessionIfCurrent(req, user))) {
    res.status(401).json({ error: "Neplatné přihlašovací údaje" });
    return;
  }
  const overrides = await getPermissionOverrides(user.id);
  res.json(serializeUser(user, overrides));
});

router.post("/auth/webauthn/verify/begin", async (req, res): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const creds = await db
    .select({ credentialId: webauthnCredentialsTable.credentialId })
    .from(webauthnCredentialsTable)
    .where(eq(webauthnCredentialsTable.userId, req.auth.userId));

  if (creds.length === 0) {
    res.status(400).json({ error: "Žádná biometrická zařízení nejsou registrována" });
    return;
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(req),
    userVerification: "required",
    allowCredentials: creds.map((c) => ({ id: c.credentialId })),
  });

  req.session.webauthnChallenge = options.challenge;
  res.json(options);
});

router.post("/auth/webauthn/verify/complete", auditVerifyComplete, async (req, res): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const challenge = req.session.webauthnChallenge;
  if (!challenge) {
    res.status(400).json({ error: "No pending challenge" });
    return;
  }
  delete req.session.webauthnChallenge;

  const { response } = req.body as { response: unknown };
  if (!response || typeof response !== "object") {
    res.status(400).json({ error: "Missing response" });
    return;
  }

  const responseObj = response as { id?: string; rawId?: string };
  const credId = responseObj.id ?? responseObj.rawId ?? "";

  const [cred] = await db
    .select()
    .from(webauthnCredentialsTable)
    .where(
      and(
        eq(webauthnCredentialsTable.userId, req.auth.userId),
        eq(webauthnCredentialsTable.credentialId, credId),
      ),
    );

  if (!cred) {
    res.status(401).json({ error: "Zařízení není registrováno" });
    return;
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: getRpOrigin(req as any),
      expectedRPID: getRpId(req),
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: Buffer.from(cred.publicKey, "base64"),
        counter: cred.counter,
      },
    });
  } catch {
    res.status(401).json({ error: "Biometrické ověření selhalo" });
    return;
  }

  if (!verification.verified) {
    res.status(401).json({ error: "Biometrické ověření selhalo" });
    return;
  }

  await db
    .update(webauthnCredentialsTable)
    .set({ counter: verification.authenticationInfo.newCounter })
    .where(eq(webauthnCredentialsTable.id, cred.id));

  const result = await establishVaultStepUp(req, "webauthn");
  res.json({
    verified: true,
    method: "webauthn",
    expiresAt: new Date(result.expiresAt).toISOString(),
  });
});

router.get("/auth/webauthn/credentials", async (req, res): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const canManageUsers = req.auth.permissions.includes("users.manage");
  const userIdParam = (req.query as { userId?: string }).userId;
  let targetUserId = req.auth.userId;

  if (userIdParam) {
    if (!canManageUsers) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const parsed = Number(userIdParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "Invalid userId" });
      return;
    }
    targetUserId = parsed;
  }

  let creds;
  try {
    creds = userIdParam
      ? await db.transaction(async (tx) => {
          await lockAndAuthorizeUserManager(tx, req.auth!.userId);
          return tx
            .select()
            .from(webauthnCredentialsTable)
            .where(eq(webauthnCredentialsTable.userId, targetUserId))
            .orderBy(webauthnCredentialsTable.createdAt);
        })
      : await db
          .select()
          .from(webauthnCredentialsTable)
          .where(eq(webauthnCredentialsTable.userId, targetUserId))
          .orderBy(webauthnCredentialsTable.createdAt);
  } catch (error) {
    if (error instanceof UserOffboardingError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  res.json(creds.map(serializeCred));
});

router.delete("/auth/webauthn/credentials/:id", async (req, res): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const canManageUsers = req.auth.permissions.includes("users.manage");
  try {
    const outcome = await db.transaction(async (tx) => {
      if (canManageUsers) {
        await lockAndAuthorizeUserManager(tx, req.auth!.userId);
        const [candidate] = await tx
          .select({ userId: webauthnCredentialsTable.userId })
          .from(webauthnCredentialsTable)
          .where(eq(webauthnCredentialsTable.id, id));
        if (!candidate) return { status: "not_found" } as const;
        await tx.execute(sql`select id from users where id = ${candidate.userId} for update`);
        await tx.execute(sql`select id from webauthn_credentials where id = ${id} for update`);
      } else {
        await tx.execute(sql`select id from users where id = ${req.auth!.userId} and is_active = true for update`);
        await tx.execute(sql`select id from webauthn_credentials where id = ${id} and user_id = ${req.auth!.userId} for update`);
      }

      const [credential] = await tx
        .select()
        .from(webauthnCredentialsTable)
        .where(eq(webauthnCredentialsTable.id, id));
      if (!credential) return { status: "not_found" } as const;
      const isOwner = credential.userId === req.auth!.userId;
      if (!isOwner && !canManageUsers) return { status: "not_found" } as const;

      await tx.delete(webauthnCredentialsTable).where(eq(webauthnCredentialsTable.id, id));
      if (!isOwner) {
        await tx.insert(auditLogTable).values({
          actorUserId: req.auth!.userId,
          actorName: null,
          action: "delete",
          entityType: "webauthn-credentials",
          entityId: id,
          summary: JSON.stringify({ targetUserId: credential.userId }),
          method: "DELETE",
          path: req.path,
        });
      }
      return { status: "deleted" } as const;
    });
    if (outcome.status === "not_found") {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
  } catch (error) {
    if (error instanceof UserOffboardingError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  res.sendStatus(204);
});

export default router;
