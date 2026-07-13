import type { NextFunction, Request, Response } from "express";
import type { Permission } from "@workspace/db";

type ModuleRule = {
  prefixes: readonly string[];
  view: Permission;
  manage?: Permission;
};

const MODULE_RULES: readonly ModuleRule[] = [
  { prefixes: ["/users", "/admin/sessions"], view: "users.manage", manage: "users.manage" },
  { prefixes: ["/audit-logs"], view: "audit.view", manage: "audit.view" },
  { prefixes: ["/stats"], view: "statistics.view", manage: "statistics.view" },
  { prefixes: ["/client-errors", "/health", "/admin/health"], view: "diagnostics.view", manage: "diagnostics.manage" },
  { prefixes: ["/device-credentials"], view: "credentials.view", manage: "credentials.manage" },
  { prefixes: ["/quotes"], view: "quotes.view", manage: "quotes.manage" },
  {
    prefixes: ["/billing"],
    view: "billing.view",
    manage: "billing.manage",
  },
  {
    prefixes: ["/email-settings", "/email-import-settings", "/email-import-log", "/backups", "/gdpr"],
    view: "settings.view",
    manage: "settings.manage",
  },
  {
    prefixes: ["/jobs", "/dashboard", "/job-groups", "/tasks", "/attachments", "/materials", "/time-entries", "/visits", "/risks"],
    view: "jobs.view",
    manage: "jobs.manage",
  },
  {
    prefixes: ["/activities", "/activity-visits"],
    view: "activities.view",
    manage: "activities.manage",
  },
  {
    prefixes: ["/customers", "/customer-contacts", "/customer-sites", "/customer-documents"],
    view: "customers.view",
    manage: "customers.manage",
  },
  {
    prefixes: ["/people", "/leaves", "/ppe"],
    view: "people.view",
    manage: "people.manage",
  },
  {
    prefixes: ["/warehouse"],
    view: "warehouse.view",
    manage: "warehouse.manage",
  },
  { prefixes: ["/machines"], view: "machines.view", manage: "machines.manage" },
  { prefixes: ["/switchboard-events"], view: "switchboards.audit.view", manage: "switchboards.audit.view" },
  { prefixes: ["/switchboards"], view: "switchboards.view", manage: "switchboards.update" },
];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function startsWithPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}-`);
}

function permissionForRequest(req: Request): Permission | null {
  const path = req.path;
  if (path.startsWith("/auth/") || path === "/preferences" || path.startsWith("/me/")) {
    return null;
  }

  if (path.startsWith("/storage/objects/cost-documents")) return "billing.view";
  if (path === "/switchboards" && req.method === "POST") return "switchboards.create";
  if (/^\/switchboards\/\d+\/archive$/.test(path)) return "switchboards.archive";
  if (path.startsWith("/switchboards/field-registry")) return "switchboards.parser.manage";
  if (/^\/switchboards\/\d+\/extractions(?:\/|$)/.test(path)) return READ_METHODS.has(req.method) ? "switchboards.extraction.review" : "switchboards.extraction.correct";
  if (/^\/switchboards\/\d+\/documents\/compare$/.test(path)) return "switchboards.extraction.review";
  if (/^\/switchboards\/\d+\/documents\/\d+\/reprocess$/.test(path)) return "switchboards.extraction.review";
  if (/^\/switchboards\/\d+\/documents\/\d+\/public$/.test(path)) return "switchboards.documents.publish";
  if (/^\/switchboards\/\d+\/qr(?:\/|$)/.test(path)) return "switchboards.qr.manage";
  if (/^\/switchboards\/\d+\/labels\/generate$/.test(path)) return "switchboards.labels.generate";
  if (/^\/switchboards\/\d+\/labels\/\d+\/approve$/.test(path)) return "switchboards.labels.approve";
  if (/^\/switchboards\/checklist-templates(?:\/|$)/.test(path)) return READ_METHODS.has(req.method) ? "switchboards.templates.manage" : "switchboards.templates.manage";
  if (/^\/switchboards\/\d+\/checklist\/phases\/[^/]+\/complete$/.test(path)) return "switchboards.phases.complete";
  if (/^\/switchboards\/\d+\/checklist(?:\/|$)/.test(path)) return READ_METHODS.has(req.method) ? "switchboards.view" : "switchboards.checklist.fill";
  if (/^\/switchboards\/\d+\/measurements(?:\/|$)/.test(path)) return READ_METHODS.has(req.method) ? "switchboards.view" : "switchboards.measurements.create";
  if (/^\/switchboards\/\d+\/photos(?:\/|$)/.test(path)) return READ_METHODS.has(req.method) ? "switchboards.view" : "switchboards.photos.create";
  if (/^\/switchboards\/\d+\/defects\/\d+\/(?:close|reopen)$/.test(path)) return "switchboards.defects.close";
  if (/^\/switchboards\/\d+\/defects(?:\/|$)/.test(path)) return READ_METHODS.has(req.method) ? "switchboards.view" : "switchboards.defects.create";
  if (/^\/switchboards\/\d+\/operations$/.test(path)) return "switchboards.view";
  if (/^\/switchboards\/\d+\/protocols\/generate$/.test(path)) return "switchboards.protocol.complete";
  if (/^\/switchboards\/\d+\/protocols(?:\/|$)/.test(path)) return "switchboards.view";
  if (/^\/switchboards\/\d+\/documents(?:\/|$)/.test(path)) {
    return READ_METHODS.has(req.method) ? "switchboards.documents.view" : "switchboards.documents.upload";
  }
  if (/^\/warehouse-movements\/(?:job-margin|jobs-margin|activity-margin)/.test(path)) {
    return "rates.cost.view";
  }
  if (path === "/storage/diagnose") {
    return READ_METHODS.has(req.method) ? "diagnostics.view" : "diagnostics.manage";
  }

  if (/\/(?:jobs|activities)\/\d+\/time-entries(?:\/|$)/.test(path)) {
    if (READ_METHODS.has(req.method)) return path.includes("/activities/") ? "activities.view" : "jobs.view";
    return "time.manage";
  }
  if (/\/(?:jobs|activities)\/\d+\/work-sessions(?:\/|$)/.test(path)) {
    if (READ_METHODS.has(req.method)) return path.includes("/activities/") ? "activities.view" : "jobs.view";
    return "time.manage";
  }
  if (/\/people\/\d+\/hourly-rates(?:\/|$)/.test(path)) {
    if (READ_METHODS.has(req.method)) return null;
    return "rates.manage";
  }

  if (path.startsWith("/billing/")) {
    if (
      path.startsWith("/billing/settings") ||
      path.startsWith("/billing/ai-extraction") ||
      path.startsWith("/billing/document-linking") ||
      path.startsWith("/billing/email-import")
    ) {
      return READ_METHODS.has(req.method) ? "billing.view" : "billing.settings";
    }
    if (!READ_METHODS.has(req.method) && /\/approve(?:\/|$)/.test(path)) {
      return "billing.approve";
    }
  }

  for (const rule of MODULE_RULES) {
    if (!rule.prefixes.some((prefix) => startsWithPath(path, prefix))) continue;
    if (READ_METHODS.has(req.method)) return rule.view;
    return rule.manage ?? rule.view;
  }
  return null;
}

function moduleViewPermission(path: string): Permission | null {
  if (path.startsWith("/storage/objects/cost-documents")) return "billing.view";
  if (path === "/storage/diagnose") return "diagnostics.view";
  const rule = MODULE_RULES.find((candidate) =>
    candidate.prefixes.some((prefix) => startsWithPath(path, prefix)),
  );
  return rule?.view ?? null;
}

export function enforceApiPermission(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Every signed-in client may report its own frontend crash.
  if (req.path === "/client-errors" && req.method === "POST") {
    next();
    return;
  }

  const required = permissionForRequest(req);
  const viewRequired = moduleViewPermission(req.path);
  if (viewRequired && !req.auth.permissions.includes(viewRequired)) {
    res.status(403).json({ error: "Forbidden", requiredPermission: viewRequired });
    return;
  }
  if (
    READ_METHODS.has(req.method) &&
    /\/people\/\d+\/hourly-rates(?:\/|$)/.test(req.path) &&
    !req.auth.permissions.includes("rates.cost.view") &&
    !req.auth.permissions.includes("rates.sale.view")
  ) {
    res.status(403).json({ error: "Forbidden", requiredPermission: "rates.cost.view or rates.sale.view" });
    return;
  }
  if (req.path.startsWith("/stats") && !req.auth.permissions.includes("billing.view")) {
    res.status(403).json({ error: "Forbidden", requiredPermission: "billing.view" });
    return;
  }
  if (required && !req.auth.permissions.includes(required)) {
    res.status(403).json({ error: "Forbidden", requiredPermission: required });
    return;
  }

  // Preserve the old read-only guest boundary for endpoints not catalogued yet.
  if (!required && !READ_METHODS.has(req.method) && req.auth.role === "guest") {
    res.status(403).json({ error: "Guests cannot modify data" });
    return;
  }
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!req.auth.permissions.includes(permission)) {
      res.status(403).json({ error: "Forbidden", requiredPermission: permission });
      return;
    }
    next();
  };
}
