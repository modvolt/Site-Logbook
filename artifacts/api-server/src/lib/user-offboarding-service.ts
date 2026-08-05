import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import {
  auditLogTable,
  db,
  resolvePermissions,
  securityQuestionsTable,
  userPermissionOverridesTable,
  userSessionsTable,
  usersTable,
  webauthnCredentialsTable,
  type PermissionEffect,
  type UserRole,
} from "@workspace/db";
import { SESSION_ISSUANCE_LOCK_NAMESPACE } from "./auth-session";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const USER_OFFBOARDING_REASONS = ["employment_ended", "contract_ended", "access_no_longer_required", "security_response"] as const;
export type UserOffboardingReason = (typeof USER_OFFBOARDING_REASONS)[number];

export interface UserOffboardingAccessInventory {
  sessions: number;
  webauthnCredentials: number;
  permissionOverrides: number;
  securityQuestions: number;
}

export interface UserOffboardingHandoverInventory {
  primaryJobs: number;
  additionalJobs: number;
  plannedJobVisits: number;
  plannedActivityVisits: number;
  machines: number;
  issuedPpe: number;
  switchboardAssignments: number;
  openResponsibleSwitchboardDefects: number;
  activeWorkSessions: number;
}

export class UserOffboardingError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UserOffboardingError";
  }
}

interface LockedUser {
  id: number;
  username: string;
  personId: number | null;
  role: string;
  isActive: boolean;
  sessionGeneration: number;
}

interface RawInventory {
  sessions: unknown;
  webauthn_credentials: unknown;
  permission_overrides: unknown;
  security_questions: unknown;
  primary_jobs: unknown;
  additional_jobs: unknown;
  planned_job_visits: unknown;
  planned_activity_visits: unknown;
  machines: unknown;
  issued_ppe: unknown;
  switchboard_assignments: unknown;
  open_responsible_switchboard_defects: unknown;
  active_work_sessions: unknown;
}

const USER_MANAGEMENT_LOCK_NAMESPACE = 8456;
const USER_MANAGEMENT_LOCK_KEY = 1;

function count(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid user offboarding inventory count: ${field}`);
  }
  return parsed;
}

function inventoryFromRaw(raw: RawInventory): {
  access: UserOffboardingAccessInventory;
  handover: UserOffboardingHandoverInventory;
} {
  return {
    access: {
      sessions: count(raw.sessions, "sessions"),
      webauthnCredentials: count(raw.webauthn_credentials, "webauthnCredentials"),
      permissionOverrides: count(raw.permission_overrides, "permissionOverrides"),
      securityQuestions: count(raw.security_questions, "securityQuestions"),
    },
    handover: {
      primaryJobs: count(raw.primary_jobs, "primaryJobs"),
      additionalJobs: count(raw.additional_jobs, "additionalJobs"),
      plannedJobVisits: count(raw.planned_job_visits, "plannedJobVisits"),
      plannedActivityVisits: count(raw.planned_activity_visits, "plannedActivityVisits"),
      machines: count(raw.machines, "machines"),
      issuedPpe: count(raw.issued_ppe, "issuedPpe"),
      switchboardAssignments: count(raw.switchboard_assignments, "switchboardAssignments"),
      openResponsibleSwitchboardDefects: count(raw.open_responsible_switchboard_defects, "openResponsibleSwitchboardDefects"),
      activeWorkSessions: count(raw.active_work_sessions, "activeWorkSessions"),
    },
  };
}

async function loadInventory(tx: Transaction, targetUserId: number, personId: number | null): Promise<ReturnType<typeof inventoryFromRaw>> {
  const result = await tx.execute(sql`
    select
      (select count(*)::int from user_sessions s
        where s.user_id = ${targetUserId}
           or s.sess->>'userId' = ${String(targetUserId)}) as sessions,
      (select count(*)::int from webauthn_credentials c
        where c.user_id = ${targetUserId}) as webauthn_credentials,
      (select count(*)::int from user_permission_overrides p
        where p.user_id = ${targetUserId}) as permission_overrides,
      (select count(*)::int from security_questions q
        where q.user_id = ${targetUserId}) as security_questions,
      (select count(*)::int from jobs j
        where ${personId}::int is not null
          and j.assigned_person_id = ${personId}
          and j.archived_at is null
          and j.status in ('planned', 'in_progress')) as primary_jobs,
      (select count(*)::int from job_assignees ja
        join jobs j on j.id = ja.job_id
        where ${personId}::int is not null
          and ja.person_id = ${personId}
          and j.archived_at is null
          and j.status in ('planned', 'in_progress')) as additional_jobs,
      (select count(*)::int from job_visits v
        where ${personId}::int is not null
          and v.person_id = ${personId}
          and v.status = 'planned') as planned_job_visits,
      (select count(*)::int from activity_visits v
        where ${personId}::int is not null
          and v.person_id = ${personId}
          and v.status = 'planned') as planned_activity_visits,
      (select count(*)::int from machines m
        where ${personId}::int is not null
          and m.assigned_person_id = ${personId}) as machines,
      (select count(*)::int from ppe_assignments p
        where ${personId}::int is not null
          and p.person_id = ${personId}
          and p.status = 'issued') as issued_ppe,
      (select count(*)::int from switchboard_assignees a
        join switchboards b on b.id = a.switchboard_id
        where ${personId}::int is not null
          and a.person_id = ${personId}
          and b.archived_at is null) as switchboard_assignments,
      (select count(*)::int from switchboard_defects d
        where ${personId}::int is not null
          and d.responsible_person_id = ${personId}
          and d.status <> 'closed') as open_responsible_switchboard_defects,
      (select count(*)::int from work_sessions w
        where ${personId}::int is not null
          and w.person_id = ${personId}
          and w.status = 'active') as active_work_sessions
  `);
  const raw = result.rows[0] as unknown as RawInventory | undefined;
  if (!raw) throw new Error("User offboarding inventory query returned no row");
  return inventoryFromRaw(raw);
}

async function lockedUser(tx: Transaction, userId: number): Promise<LockedUser | null> {
  const result = await tx.execute(sql`
    select id,
           username,
           person_id as "personId",
           role,
           is_active as "isActive",
           session_generation as "sessionGeneration"
      from users
     where id = ${userId}
     for update
  `);
  const row = result.rows[0] as unknown as LockedUser | undefined;
  return row ?? null;
}

/**
 * Serializes every access-management mutation and revalidates the actor inside
 * the same transaction. This closes the mutual-offboarding race where two
 * managers could otherwise remove each other's final effective permission.
 */
export async function lockAndAuthorizeUserManager(tx: Transaction, actorUserId: number): Promise<LockedUser> {
  await tx.execute(sql`select pg_advisory_xact_lock(${USER_MANAGEMENT_LOCK_NAMESPACE}, ${USER_MANAGEMENT_LOCK_KEY})`);
  const actor = await lockedUser(tx, actorUserId);
  if (!actor?.isActive) {
    throw new UserOffboardingError(403, "actor_access_revoked", "Správa uživatelů již není povolena.");
  }
  const rows = await tx
    .select({
      permission: userPermissionOverridesTable.permission,
      effect: userPermissionOverridesTable.effect,
    })
    .from(userPermissionOverridesTable)
    .where(eq(userPermissionOverridesTable.userId, actorUserId));
  const overrides = rows.flatMap((row) => (row.effect === "allow" || row.effect === "deny" ? [{ permission: row.permission, effect: row.effect as PermissionEffect }] : []));
  if (!resolvePermissions(actor.role as UserRole, overrides).includes("users.manage")) {
    throw new UserOffboardingError(403, "actor_access_revoked", "Správa uživatelů již není povolena.");
  }
  return actor;
}

export async function getUserOffboardingPreview(input: { actorUserId: number; targetUserId: number }) {
  return db.transaction(async (tx) => {
    await lockAndAuthorizeUserManager(tx, input.actorUserId);
    const target = await lockedUser(tx, input.targetUserId);
    if (!target) {
      throw new UserOffboardingError(404, "user_not_found", "User not found");
    }
    const inventory = await loadInventory(tx, target.id, target.personId);
    return {
      userId: target.id,
      username: target.username,
      personId: target.personId,
      isActive: target.isActive,
      sessionGeneration: target.sessionGeneration,
      ...inventory,
    };
  });
}

export async function offboardUserAccess(input: {
  actorUserId: number;
  targetUserId: number;
  expectedUsername: string;
  expectedSessionGeneration: number;
  reason: UserOffboardingReason;
}) {
  if (
    !Number.isSafeInteger(input.actorUserId) ||
    input.actorUserId <= 0 ||
    !Number.isSafeInteger(input.targetUserId) ||
    input.targetUserId <= 0 ||
    !Number.isSafeInteger(input.expectedSessionGeneration) ||
    input.expectedSessionGeneration < 1 ||
    !USER_OFFBOARDING_REASONS.includes(input.reason)
  ) {
    throw new UserOffboardingError(409, "invalid_offboarding_precondition", "Neplatné podmínky offboardingu.");
  }
  if (input.actorUserId === input.targetUserId) {
    throw new UserOffboardingError(409, "self_offboarding_forbidden", "Vlastní účet nelze odpojit.");
  }

  // Produce an unknowable replacement before taking any database lock. The
  // plaintext is never returned or persisted, so a later reactivation cannot
  // silently revive the old password.
  const replacementPasswordHash = await bcrypt.hash(randomBytes(32).toString("base64url"), 12);

  return db.transaction(async (tx) => {
    await lockAndAuthorizeUserManager(tx, input.actorUserId);
    await tx.execute(
      sql`select pg_advisory_xact_lock(${SESSION_ISSUANCE_LOCK_NAMESPACE}, ${input.targetUserId})`,
    );
    const target = await lockedUser(tx, input.targetUserId);
    if (!target) {
      throw new UserOffboardingError(404, "user_not_found", "User not found");
    }
    if (!target.isActive) {
      throw new UserOffboardingError(409, "user_already_inactive", "Uživatel již není aktivní.");
    }
    if (target.username !== input.expectedUsername || target.sessionGeneration !== input.expectedSessionGeneration) {
      throw new UserOffboardingError(409, "offboarding_precondition_failed", "Účet se od náhledu změnil.");
    }

    const inventory = await loadInventory(tx, target.id, target.personId);
    const [updated] = await tx
      .update(usersTable)
      .set({
        isActive: false,
        passwordHash: replacementPasswordHash,
        sessionGeneration: sql`${usersTable.sessionGeneration} + 1`,
      })
      .where(eq(usersTable.id, target.id))
      .returning({ sessionGeneration: usersTable.sessionGeneration });
    if (!updated) throw new Error("Offboarded user row was not updated");

    const sessions = await tx
      .delete(userSessionsTable)
      .where(sql`${userSessionsTable.userId} = ${target.id} or ${userSessionsTable.sess}->>'userId' = ${String(target.id)}`)
      .returning({ sid: userSessionsTable.sid });
    const credentials = await tx.delete(webauthnCredentialsTable).where(eq(webauthnCredentialsTable.userId, target.id)).returning({ id: webauthnCredentialsTable.id });
    const overrides = await tx
      .delete(userPermissionOverridesTable)
      .where(eq(userPermissionOverridesTable.userId, target.id))
      .returning({ permission: userPermissionOverridesTable.permission });
    const questions = await tx.delete(securityQuestionsTable).where(eq(securityQuestionsTable.userId, target.id)).returning({ id: securityQuestionsTable.id });

    const revokedAccess: UserOffboardingAccessInventory = {
      sessions: sessions.length,
      webauthnCredentials: credentials.length,
      permissionOverrides: overrides.length,
      securityQuestions: questions.length,
    };

    await tx.insert(auditLogTable).values({
      actorUserId: input.actorUserId,
      actorName: null,
      action: "user.access.offboarded",
      entityType: "users",
      entityId: target.id,
      summary: JSON.stringify({
        reason: input.reason,
        previousSessionGeneration: target.sessionGeneration,
        newSessionGeneration: updated.sessionGeneration,
        revokedAccess,
        handover: inventory.handover,
      }),
      method: "POST",
      path: `/users/${target.id}/offboard`,
    });

    return {
      userId: target.id,
      isActive: false as const,
      newSessionGeneration: updated.sessionGeneration,
      revokedAccess,
      handover: inventory.handover,
    };
  });
}
