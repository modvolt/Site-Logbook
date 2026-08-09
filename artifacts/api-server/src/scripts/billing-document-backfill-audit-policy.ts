export interface BillingDocumentBackfillAuditOptions {
  database: string;
  since: string | null;
}

export type BillingDocumentBackfillAuditDecision =
  | "PASS"
  | "REVIEW"
  | "BLOCK";

export type BillingLineEligibilityState =
  | "eligible"
  | "line_not_approved";

const MUTATING_ARGUMENT_PREFIXES = ["--apply", "--execute"] as const;

function parseIsoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("--since must use the exact YYYY-MM-DD format.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("--since must be a real calendar date.");
  }
  return value;
}

export function parseBillingDocumentBackfillAuditOptions(
  args: readonly string[],
): BillingDocumentBackfillAuditOptions {
  for (const value of args) {
    if (
      MUTATING_ARGUMENT_PREFIXES.some(
        (prefix) => value === prefix || value.startsWith(`${prefix}=`),
      )
    ) {
      throw new Error(
        `${value.split("=")[0]} is forbidden: this command is read-only and has no apply mode.`,
      );
    }
  }

  const databaseArgs = args.filter((value) =>
    value.startsWith("--database="),
  );
  if (databaseArgs.length !== 1) {
    throw new Error(
      "Audit requires exactly one --database=<exact database name> argument.",
    );
  }
  const database = databaseArgs[0].slice("--database=".length);
  if (!database || database !== database.trim() || database.includes("\0")) {
    throw new Error("--database must contain an exact, non-empty database name.");
  }

  const sinceArgs = args.filter((value) => value.startsWith("--since="));
  if (sinceArgs.length > 1) {
    throw new Error("Audit accepts at most one --since=YYYY-MM-DD argument.");
  }
  const since = sinceArgs.length
    ? parseIsoDate(sinceArgs[0].slice("--since=".length))
    : null;

  const known = new Set([...databaseArgs, ...sinceArgs]);
  const unknown = args.filter((value) => !known.has(value));
  if (unknown.length > 0) {
    throw new Error(`Unsupported audit argument ${JSON.stringify(unknown[0])}.`);
  }

  return Object.freeze({ database, since });
}

export function databaseNameFromPostgresUrl(raw: string | undefined): string {
  if (!raw) throw new Error("DATABASE_URL is required.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL must name a database.");
  return database;
}

export function classifyBillingDocumentBackfillAudit(input: {
  hardBlockers: number;
  reviewFindings: number;
}): BillingDocumentBackfillAuditDecision {
  if (input.hardBlockers > 0) return "BLOCK";
  return input.reviewFindings > 0 ? "REVIEW" : "PASS";
}

export function classifyBillingLineEligibility(
  lineApproved: number,
): BillingLineEligibilityState {
  return lineApproved === 1 ? "eligible" : "line_not_approved";
}

export const BILLING_DOCUMENT_AUDIT_BEGIN_SQL =
  "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";

const AUDIT_WINDOW_CTE = `
audit_window as (
  select coalesce(
    $1::date::timestamp,
    date_trunc(
      'day',
      (now() at time zone 'Europe/Prague') - interval '2 months'
    )
  ) as cutoff_local
)`;

const CANDIDATE_DOCUMENTS_CTE = `
${AUDIT_WINDOW_CTE},
candidate_documents as (
  select d.*
  from billing_documents d
  cross join audit_window w
  where d.status = 'approved'
    and d.primary_document_id is null
    and coalesce(d.reviewed_at, d.created_at) >= w.cutoff_local
)`;

export const BILLING_DOCUMENT_AUDIT_CONTEXT_SQL = `
with ${AUDIT_WINDOW_CTE}
select
  current_database() as database,
  current_setting('transaction_read_only') as transaction_read_only,
  current_setting('transaction_isolation') as transaction_isolation,
  'Europe/Prague'::text as timezone,
  to_char(
    now() at time zone 'Europe/Prague',
    'YYYY-MM-DD"T"HH24:MI:SS.US'
  ) as db_now_local,
  to_char(cutoff_local, 'YYYY-MM-DD"T"HH24:MI:SS.US') as cutoff_local
from audit_window
`;

export const BILLING_DOCUMENT_AUDIT_SCOPE_SQL = `
with ${CANDIDATE_DOCUMENTS_CTE}
select
  d.id,
  d.doc_type,
  d.document_number,
  d.supplier_name,
  d.supplier_ic,
  d.job_id,
  d.reviewed_at,
  d.created_at
from candidate_documents d
order by d.id
`;

export const BILLING_DOCUMENT_AUDIT_REFERENCES_SQL = `
with ${CANDIDATE_DOCUMENTS_CTE},
delivery_references as (
  select
    r.*,
    coalesce(
      nullif(
        upper(regexp_replace(r.reference_number, '[^A-Za-z0-9]', '', 'g')),
        ''
      ),
      lower(btrim(r.reference_number))
    ) as logical_key
  from billing_document_references r
  inner join candidate_documents d on d.id = r.document_id
  where d.doc_type in ('invoice', 'credit_note')
    and r.reference_type in ('delivery_note', 'summary_delivery_note', 'delivery')
),
logical_references as (
  select
    r.document_id,
    r.logical_key,
    array_agg(r.id order by r.id) as reference_ids,
    array_agg(r.reference_type order by r.id) as reference_types,
    array_agg(r.reference_number order by r.id) as reference_numbers,
    (count(*) > 1) as duplicate,
    (
      count(distinct r.matched_document_id) filter (
        where r.match_confirmed = 1
          and r.rejected <> 1
          and r.matched_document_id is not null
      ) > 1
      or count(distinct r.matched_job_id) filter (
        where r.match_confirmed = 1
          and r.rejected <> 1
          and r.matched_job_id is not null
      ) > 1
      or count(distinct r.matched_attachment_id) filter (
        where r.match_confirmed = 1
          and r.rejected <> 1
          and r.matched_attachment_id is not null
      ) > 1
    ) as conflicting,
    (
      count(*) filter (where r.rejected <> 1) > 0
      and not (
        count(distinct r.matched_document_id) filter (
          where r.rejected <> 1
            and r.match_confirmed = 1
            and r.matched_document_id is not null
        ) = 1
        and count(distinct r.matched_document_id) filter (
          where r.rejected <> 1
            and r.match_confirmed = 1
            and matched.doc_type = 'delivery_note'
            and matched.status = 'approved'
        ) = 1
      )
    ) as unresolved,
    (count(*) filter (where r.rejected <> 1) = 0) as rejected_only,
    coalesce(
      array_agg(distinct r.matched_document_id order by r.matched_document_id)
        filter (
          where r.match_confirmed = 1
            and r.rejected <> 1
            and r.matched_document_id is not null
        ),
      array[]::integer[]
    ) as confirmed_document_ids,
    coalesce(
      array_agg(distinct r.matched_job_id order by r.matched_job_id)
        filter (
          where r.match_confirmed = 1
            and r.rejected <> 1
            and r.matched_job_id is not null
        ),
      array[]::integer[]
    ) as confirmed_job_ids,
    coalesce(
      array_agg(r.id order by r.id)
        filter (
          where r.match_confirmed = 1
            and r.rejected <> 1
            and r.matched_job_id is null
            and (
              r.matched_document_id is not null
              or r.matched_attachment_id is not null
            )
        ),
      array[]::integer[]
    ) as missing_matched_job_reference_ids
  from delivery_references r
  left join billing_documents matched on matched.id = r.matched_document_id
  group by r.document_id, r.logical_key
),
delivery_note_numbers as (
  select
    d.id,
    d.status,
    d.job_id,
    d.supplier_ic,
    number.logical_key
  from billing_documents d
  cross join lateral (
    select coalesce(
      nullif(
        upper(regexp_replace(d.delivery_note_number, '[^A-Za-z0-9]', '', 'g')),
        ''
      ),
      nullif(
        upper(regexp_replace(d.document_number, '[^A-Za-z0-9]', '', 'g')),
        ''
      )
    ) as logical_key
  ) number
  where d.doc_type = 'delivery_note'
    and d.primary_document_id is null
    and d.status not in ('duplicate', 'ignored')
    and number.logical_key is not null
),
exact_candidates as (
  select
    lr.document_id,
    lr.logical_key,
    count(*) filter (
      where source.supplier_ic is null
        or candidate.supplier_ic is null
        or regexp_replace(source.supplier_ic, '[^0-9]', '', 'g') =
          regexp_replace(candidate.supplier_ic, '[^0-9]', '', 'g')
    )::integer as compatible_candidate_count,
    jsonb_agg(
      jsonb_build_object(
        'documentId', candidate.id,
        'status', candidate.status,
        'jobId', candidate.job_id,
        'supplierIc', candidate.supplier_ic,
        'supplierCompatible',
          source.supplier_ic is null
          or candidate.supplier_ic is null
          or regexp_replace(source.supplier_ic, '[^0-9]', '', 'g') =
            regexp_replace(candidate.supplier_ic, '[^0-9]', '', 'g')
      )
      order by candidate.id
    ) as candidates
  from logical_references lr
  inner join candidate_documents source on source.id = lr.document_id
  inner join delivery_note_numbers candidate
    on candidate.logical_key = lr.logical_key
   and candidate.id <> lr.document_id
  group by lr.document_id, lr.logical_key
)
select
  lr.document_id,
  source.doc_type,
  source.document_number,
  lr.logical_key,
  lr.reference_ids,
  lr.reference_types,
  lr.reference_numbers,
  lr.duplicate,
  lr.conflicting,
  lr.unresolved,
  lr.rejected_only,
  lr.confirmed_document_ids,
  lr.confirmed_job_ids,
  lr.missing_matched_job_reference_ids,
  coalesce(ec.compatible_candidate_count, 0) as compatible_candidate_count,
  coalesce(ec.candidates, '[]'::jsonb) as exact_candidates
from logical_references lr
inner join candidate_documents source on source.id = lr.document_id
left join exact_candidates ec
  on ec.document_id = lr.document_id
 and ec.logical_key = lr.logical_key
order by lr.document_id, lr.logical_key
`;

export const BILLING_DOCUMENT_AUDIT_LINES_SQL = `
with ${CANDIDATE_DOCUMENTS_CTE},
eligible_lines as (
  select
    l.*,
    d.doc_type,
    d.document_number,
    d.job_id as document_job_id
  from billing_document_lines l
  inner join candidate_documents d on d.id = l.document_id
  where l.line_type = 'material'
    and l.fee_type is null
    and l.allocation_type = 'rebill'
),
confirmed_candidate_references as (
  select r.*
  from billing_document_references r
  inner join candidate_documents d on d.id = r.document_id
  where r.match_confirmed = 1
    and r.rejected <> 1
),
relevant_document_ids as (
  select id from candidate_documents
  union
  select matched_document_id
  from confirmed_candidate_references
  where matched_document_id is not null
),
relevant_documents as (
  select d.*
  from billing_documents d
  inner join relevant_document_ids ids on ids.id = d.id
),
attachment_matches as (
  select
    d.id as document_id,
    a.id as attachment_id,
    a.job_id,
    case
      when a.billing_document_id = d.id then 1
      when d.object_path is not null and a.url = d.object_path then 2
      else 3
    end as match_priority
  from relevant_documents d
  inner join attachments a
    on a.type in ('document', 'invoice', 'receipt', 'delivery_note', 'credit_note')
   and (
     a.billing_document_id = d.id
     or (d.object_path is not null and a.url = d.object_path)
     or (d.file_name is not null and a.file_name = d.file_name)
   )
),
preferred_attachment_matches as (
  select match.document_id, match.attachment_id, match.job_id
  from attachment_matches match
  inner join (
    select document_id, min(match_priority) as match_priority
    from attachment_matches
    group by document_id
  ) preferred
    on preferred.document_id = match.document_id
   and preferred.match_priority = match.match_priority
),
linked_documents as (
  select
    r.document_id as source_document_id,
    linked.*
  from confirmed_candidate_references r
  inner join billing_documents linked on linked.id = r.matched_document_id
),
fallback_job_evidence as (
  select
    d.id as document_id,
    attachment.job_id,
    'document_attachment'::text as source,
    attachment.attachment_id as source_id
  from candidate_documents d
  inner join preferred_attachment_matches attachment
    on attachment.document_id = d.id
  where d.job_id is null

  union all

  select
    r.document_id,
    r.matched_job_id,
    'confirmed_reference_job'::text,
    r.id
  from confirmed_candidate_references r
  where r.matched_job_id is not null

  union all

  select
    r.document_id,
    attachment.job_id,
    'confirmed_reference_attachment'::text,
    r.matched_attachment_id
  from confirmed_candidate_references r
  inner join attachments attachment on attachment.id = r.matched_attachment_id

  union all

  select
    linked.source_document_id,
    linked.job_id,
    'linked_document_job'::text,
    linked.id
  from linked_documents linked
  where linked.job_id is not null

  union all

  select
    linked.source_document_id,
    attachment.job_id,
    'linked_document_attachment'::text,
    attachment.attachment_id
  from linked_documents linked
  inner join preferred_attachment_matches attachment
    on attachment.document_id = linked.id
  where linked.job_id is null

  union all

  select
    linked.source_document_id,
    r.matched_job_id,
    'linked_document_reference_job'::text,
    r.id
  from linked_documents linked
  inner join billing_document_references r on r.document_id = linked.id
  where r.match_confirmed = 1
    and r.rejected <> 1
    and r.matched_job_id is not null

  union all

  select
    linked.source_document_id,
    attachment.job_id,
    'linked_document_reference_attachment'::text,
    r.id
  from linked_documents linked
  inner join billing_document_references r on r.document_id = linked.id
  inner join attachments attachment on attachment.id = r.matched_attachment_id
  where r.match_confirmed = 1
    and r.rejected <> 1

  union all

  select
    linked.source_document_id,
    line.job_id,
    'linked_document_line'::text,
    line.id
  from linked_documents linked
  inner join billing_document_lines line on line.document_id = linked.id
  where line.job_id is not null
),
fallback_jobs as (
  select
    evidence.document_id,
    array_agg(distinct evidence.job_id order by evidence.job_id) as job_ids,
    jsonb_agg(
      jsonb_build_object(
        'jobId', evidence.job_id,
        'source', evidence.source,
        'sourceId', evidence.source_id
      )
      order by evidence.source, evidence.source_id, evidence.job_id
    ) as evidence
  from fallback_job_evidence evidence
  where evidence.job_id is not null
  group by evidence.document_id
),
resolved_lines as (
  select
    line.id as line_id,
    line.document_id,
    line.doc_type,
    line.document_number,
    line.description,
    line.approved as line_approved,
    line.match_confirmed as line_match_confirmed,
    line.invoiced_invoice_id as line_invoiced_invoice_id,
    line.job_id as line_job_id,
    line.activity_id as line_activity_id,
    line.document_job_id,
    coalesce(fallback.job_ids, array[]::integer[]) as fallback_job_ids,
    coalesce(fallback.evidence, '[]'::jsonb) as fallback_evidence,
    case
      when line.job_id is not null and line.activity_id is not null then 'ambiguous'
      when line.activity_id is not null then 'resolved'
      when line.job_id is not null then 'resolved'
      when line.document_job_id is not null then 'resolved'
      when cardinality(coalesce(fallback.job_ids, array[]::integer[])) = 0 then 'missing'
      when cardinality(coalesce(fallback.job_ids, array[]::integer[])) = 1 then 'resolved'
      else 'ambiguous'
    end as target_state,
    case
      when line.job_id is not null and line.activity_id is not null then 'invalid_line_job_and_activity'
      when line.activity_id is not null then 'line_activity'
      when line.job_id is not null then 'line_job'
      when line.document_job_id is not null then 'document_job'
      when cardinality(coalesce(fallback.job_ids, array[]::integer[])) = 1 then 'confirmed_fallback'
      else null
    end as target_source,
    case
      when line.activity_id is null and line.job_id is not null then line.job_id
      when line.activity_id is null and line.job_id is null
        and line.document_job_id is not null then line.document_job_id
      when line.activity_id is null and line.job_id is null
        and line.document_job_id is null
        and cardinality(coalesce(fallback.job_ids, array[]::integer[])) = 1
        then (fallback.job_ids)[1]
      else null
    end as expected_job_id,
    case
      when line.job_id is null then line.activity_id
      else null
    end as expected_activity_id
  from eligible_lines line
  left join fallback_jobs fallback on fallback.document_id = line.document_id
),
observed_materials as (
  select
    line.line_id,
    count(distinct material.id)::integer as material_count,
    count(distinct material.id) filter (
      where line.expected_job_id is not null
        and material.job_id = line.expected_job_id
        and material.done = true
    )::integer as correct_material_count,
    coalesce(
      array_agg(distinct material.id order by material.id)
        filter (where material.id is not null),
      array[]::integer[]
    ) as material_ids,
    coalesce(
      array_agg(distinct material.job_id order by material.job_id)
        filter (where material.id is not null),
      array[]::integer[]
    ) as material_job_ids,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'materialId', material.id,
          'jobId', material.job_id,
          'done', material.done,
          'origin', case
            when material.source_type = 'billing_document_line'
              and material.source_id = line.line_id
              and material.price_source_line_id = line.line_id
              then 'source_and_price'
            when material.source_type = 'billing_document_line'
              and material.source_id = line.line_id
              then 'source'
            else 'price_source'
          end,
          'invoicedInvoiceId', material.invoiced_invoice_id,
          'invoicedAt', material.invoiced_at
        )
        order by material.id
      ) filter (where material.id is not null),
      '[]'::jsonb
    ) as materials
  from resolved_lines line
  left join materials material
    on (
      material.source_type = 'billing_document_line'
      and material.source_id = line.line_id
    )
    or material.price_source_line_id = line.line_id
  group by line.line_id
),
observed_activity_materials as (
  select
    line.line_id,
    count(distinct material.id)::integer as activity_material_count,
    count(distinct material.id) filter (
      where line.expected_activity_id is not null
        and material.activity_id = line.expected_activity_id
    )::integer as correct_activity_material_count,
    coalesce(
      array_agg(distinct material.id order by material.id)
        filter (where material.id is not null),
      array[]::integer[]
    ) as activity_material_ids,
    coalesce(
      array_agg(distinct material.activity_id order by material.activity_id)
        filter (where material.id is not null),
      array[]::integer[]
    ) as activity_ids
  from resolved_lines line
  left join activity_materials material
    on material.source_type = 'billing_document_line'
   and material.source_id = line.line_id
  group by line.line_id
),
line_evaluation as (
  select
    line.*,
    observed.material_count,
    observed.correct_material_count,
    observed.material_ids,
    observed.material_job_ids,
    observed.materials,
    activity.activity_material_count,
    activity.correct_activity_material_count,
    activity.activity_material_ids,
    activity.activity_ids,
    case
      when line.target_state <> 'resolved' then 'not_evaluated'
      when line.expected_activity_id is not null
        and activity.activity_material_count = 1
        and activity.correct_activity_material_count = 1
        and observed.material_count = 0 then 'ok'
      when line.expected_activity_id is not null
        and activity.activity_material_count = 0
        and observed.material_count = 0 then 'missing'
      when line.expected_job_id is not null
        and observed.material_count = 1
        and observed.correct_material_count = 1
        and activity.activity_material_count = 0 then 'ok'
      when line.expected_job_id is not null
        and observed.material_count = 0
        and activity.activity_material_count = 0 then 'missing'
      else 'wrong'
    end as propagation_state
  from resolved_lines line
  inner join observed_materials observed on observed.line_id = line.line_id
  inner join observed_activity_materials activity on activity.line_id = line.line_id
),
blocker_evidence as (
  select
    line.line_id,
    'line_invoiced_marker'::text as blocker_type,
    line.line_invoiced_invoice_id as invoice_id,
    coalesce(invoice.status, 'missing_invoice') as invoice_status,
    invoice.invoice_number,
    'billing_document_line.invoiced_invoice_id'::text as provenance_type,
    line.line_id as provenance_id
  from line_evaluation line
  left join invoices invoice on invoice.id = line.line_invoiced_invoice_id
  where line.line_invoiced_invoice_id is not null

  union

  select
    line.line_id,
    'material_invoiced_marker'::text,
    material.invoiced_invoice_id,
    coalesce(invoice.status, 'missing_invoice'),
    invoice.invoice_number,
    'material.invoiced_invoice_id'::text,
    material.id
  from line_evaluation line
  inner join materials material
    on (
      material.source_type = 'billing_document_line'
      and material.source_id = line.line_id
    )
    or material.price_source_line_id = line.line_id
  left join invoices invoice on invoice.id = material.invoiced_invoice_id
  where material.invoiced_invoice_id is not null
     or material.invoiced_at is not null

  union

  select
    line.line_id,
    'invoice_line_document_provenance'::text,
    invoice.id,
    invoice.status,
    invoice.invoice_number,
    invoice_line.source_type,
    invoice_line.id
  from line_evaluation line
  inner join invoice_lines invoice_line
    on invoice_line.source_type = 'billing_document_line'
   and invoice_line.source_id = line.line_id
  inner join invoices invoice on invoice.id = invoice_line.invoice_id
  where invoice.status <> 'cancelled'

  union

  select
    line.line_id,
    'invoice_line_material_provenance'::text,
    invoice.id,
    invoice.status,
    invoice.invoice_number,
    invoice_line.source_type,
    invoice_line.id
  from line_evaluation line
  inner join materials material
    on (
      material.source_type = 'billing_document_line'
      and material.source_id = line.line_id
    )
    or material.price_source_line_id = line.line_id
  inner join invoice_lines invoice_line
    on invoice_line.source_type = 'material'
   and invoice_line.source_id = material.id
  inner join invoices invoice on invoice.id = invoice_line.invoice_id
  where invoice.status <> 'cancelled'

  union

  select
    line.line_id,
    'invoice_line_activity_material_provenance'::text,
    invoice.id,
    invoice.status,
    invoice.invoice_number,
    invoice_line.source_type,
    invoice_line.id
  from line_evaluation line
  inner join activity_materials material
    on material.source_type = 'billing_document_line'
   and material.source_id = line.line_id
  inner join invoice_lines invoice_line
    on invoice_line.source_type = 'activity_material'
   and invoice_line.source_id = material.id
  inner join invoices invoice on invoice.id = invoice_line.invoice_id
  where invoice.status <> 'cancelled'

  union

  select
    line.line_id,
    'invoice_line_target'::text,
    invoice.id,
    invoice.status,
    invoice.invoice_number,
    invoice_line.source_type,
    invoice_line.id
  from line_evaluation line
  inner join invoice_lines invoice_line
    on (
      line.expected_job_id is not null
      and invoice_line.job_id = line.expected_job_id
    )
    or (
      line.expected_activity_id is not null
      and invoice_line.activity_id = line.expected_activity_id
    )
  inner join invoices invoice on invoice.id = invoice_line.invoice_id
  where invoice.status <> 'cancelled'

  union

  select
    line.line_id,
    'invoice_source_link'::text,
    invoice.id,
    invoice.status,
    invoice.invoice_number,
    case
      when source_link.job_id is not null then 'job'
      else 'activity'
    end,
    source_link.id
  from line_evaluation line
  inner join invoice_source_links source_link
    on (
      line.expected_job_id is not null
      and source_link.job_id = line.expected_job_id
    )
    or (
      line.expected_activity_id is not null
      and source_link.activity_id = line.expected_activity_id
    )
  inner join invoices invoice on invoice.id = source_link.invoice_id
  where invoice.status <> 'cancelled'
),
blocker_summary as (
  select
    blocker.line_id,
    count(*)::integer as blocker_count,
    jsonb_agg(
      jsonb_build_object(
        'type', blocker.blocker_type,
        'invoiceId', blocker.invoice_id,
        'invoiceStatus', blocker.invoice_status,
        'invoiceNumber', blocker.invoice_number,
        'provenanceType', blocker.provenance_type,
        'provenanceId', blocker.provenance_id
      )
      order by blocker.invoice_id, blocker.blocker_type, blocker.provenance_id
    ) as blockers
  from blocker_evidence blocker
  group by blocker.line_id
)
select
  line.*,
  coalesce(blocker.blocker_count, 0) as blocker_count,
  coalesce(blocker.blockers, '[]'::jsonb) as blockers
from line_evaluation line
left join blocker_summary blocker on blocker.line_id = line.line_id
order by line.document_id, line.line_id
`;

export const BILLING_DOCUMENT_AUDIT_READ_QUERIES = Object.freeze([
  BILLING_DOCUMENT_AUDIT_CONTEXT_SQL,
  BILLING_DOCUMENT_AUDIT_SCOPE_SQL,
  BILLING_DOCUMENT_AUDIT_REFERENCES_SQL,
  BILLING_DOCUMENT_AUDIT_LINES_SQL,
]);
