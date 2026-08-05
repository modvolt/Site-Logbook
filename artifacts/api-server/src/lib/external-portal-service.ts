import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { externalAccountsEnabled } from "./external-accounts-feature";

export type ExternalPortalResource =
  | {
      scopeId: number;
      resourceType: "job";
      capability: "read";
      expiresAt: string;
      resource: {
        id: number;
        title: string;
        shortName: string | null;
        date: string;
        status: string;
        clientSite: string | null;
        address: string | null;
      };
    }
  | {
      scopeId: number;
      resourceType: "quote";
      capability: "read";
      expiresAt: string;
      resource: {
        id: number;
        quoteNumber: string | null;
        title: string;
        status: string;
        validUntil: string | null;
      };
    }
  | {
      scopeId: number;
      resourceType: "switchboard";
      capability: "read";
      expiresAt: string;
      resource: {
        id: number;
        designation: string;
        installationLocation: string | null;
        manufacturer: string;
        status: string;
      };
    };

interface ScopedResourceRow {
  scope_id: number;
  capability: string;
  expires_at: Date;
  job_id: number | null;
  job_title: string | null;
  job_short_name: string | null;
  job_date: string | null;
  job_status: string | null;
  job_client_site: string | null;
  job_address: string | null;
  quote_id: number | null;
  quote_number: string | null;
  quote_title: string | null;
  quote_status: string | null;
  quote_valid_until: string | null;
  switchboard_id: number | null;
  switchboard_designation: string | null;
  switchboard_installation_location: string | null;
  switchboard_manufacturer: string | null;
  switchboard_status: string | null;
}

function serializeScopedResource(row: ScopedResourceRow): ExternalPortalResource {
  const common = {
    scopeId: row.scope_id,
    capability: "read" as const,
    expiresAt: row.expires_at.toISOString(),
  };
  if (row.job_id !== null && row.job_title !== null && row.job_date !== null && row.job_status !== null) {
    return {
      ...common,
      resourceType: "job",
      resource: {
        id: row.job_id,
        title: row.job_title,
        shortName: row.job_short_name,
        date: row.job_date,
        status: row.job_status,
        clientSite: row.job_client_site,
        address: row.job_address,
      },
    };
  }
  if (row.quote_id !== null && row.quote_title !== null && row.quote_status !== null) {
    return {
      ...common,
      resourceType: "quote",
      resource: {
        id: row.quote_id,
        quoteNumber: row.quote_number,
        title: row.quote_title,
        status: row.quote_status,
        validUntil: row.quote_valid_until,
      },
    };
  }
  if (
    row.switchboard_id !== null &&
    row.switchboard_designation !== null &&
    row.switchboard_manufacturer !== null &&
    row.switchboard_status !== null
  ) {
    return {
      ...common,
      resourceType: "switchboard",
      resource: {
        id: row.switchboard_id,
        designation: row.switchboard_designation,
        installationLocation: row.switchboard_installation_location,
        manufacturer: row.switchboard_manufacturer,
        status: row.switchboard_status,
      },
    };
  }
  throw new Error("External scope target is missing");
}

async function loadScopedResources(
  externalUserId: number,
  scopeId?: number,
): Promise<ExternalPortalResource[]> {
  if (!externalAccountsEnabled()) return [];
  const result = await db.execute(sql`
    select s.id as scope_id,
           s.capability,
           s.expires_at,
           j.id as job_id,
           j.title as job_title,
           j.short_name as job_short_name,
           j.date as job_date,
           j.status as job_status,
           j.client_site as job_client_site,
           j.address as job_address,
           q.id as quote_id,
           q.quote_number,
           q.title as quote_title,
           q.status as quote_status,
           q.valid_until as quote_valid_until,
           b.id as switchboard_id,
           b.designation as switchboard_designation,
           b.installation_location as switchboard_installation_location,
           b.manufacturer as switchboard_manufacturer,
           b.status as switchboard_status
      from external_accounts a
      join external_account_scopes s on s.external_user_id = a.user_id
      left join jobs j on j.id = s.job_id
      left join quotes q on q.id = s.quote_id
      left join switchboards b on b.id = s.switchboard_id
     where a.user_id = ${externalUserId}
       and a.status = 'active'
       and a.revoked_at is null
       and a.access_expires_at > now()
       and s.revoked_at is null
       and s.starts_at <= now()
       and s.expires_at > now()
       and (${scopeId ?? null}::int is null or s.id = ${scopeId ?? null})
     order by s.id
  `);
  return (result.rows as unknown as ScopedResourceRow[]).map(serializeScopedResource);
}

export async function listExternalPortalResources(externalUserId: number) {
  return loadScopedResources(externalUserId);
}

export async function getExternalPortalResource(
  externalUserId: number,
  scopeId: number,
) {
  const [resource] = await loadScopedResources(externalUserId, scopeId);
  return resource ?? null;
}
