import type { RequestHandler } from "express";

export const PRIVACY_CASE_REQUIRED_CODE = "privacy_case_required";
export const PRIVACY_CASE_REQUIRED_MESSAGE =
  "Přímé smazání osobních údajů je vypnuté. Výmaz musí proběhnout přes ověřený privacy case s kontrolou zákonné retence a legal hold.";

export const DIRECT_PRIVACY_DELETION_OPERATIONS = [
  "gdpr_direct_erase",
  "customer_hard_delete",
  "customer_contact_hard_delete",
  "customer_site_hard_delete",
  "person_hard_delete",
] as const;

export type DirectPrivacyDeletionOperation =
  (typeof DIRECT_PRIVACY_DELETION_OPERATIONS)[number];

/**
 * Fail-closed containment for legacy direct-deletion endpoints.
 *
 * A future privacy-case executor must use a new, separately reviewed route.
 * This middleware deliberately has no environment flag or bypass header that
 * could silently re-enable the unsafe legacy handlers.
 */
export function blockDirectPrivacyDeletion(
  operation: DirectPrivacyDeletionOperation,
): RequestHandler {
  return (_req, res): void => {
    res.status(409).json({
      error: PRIVACY_CASE_REQUIRED_MESSAGE,
      code: PRIVACY_CASE_REQUIRED_CODE,
      operation,
    });
  };
}
