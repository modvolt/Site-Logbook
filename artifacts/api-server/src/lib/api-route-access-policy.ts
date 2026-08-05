import type { Permission } from "@workspace/db";
import { API_ROUTE_MANIFEST } from "../generated/api-route-manifest";
import { isPublicApiRequest } from "./public-api-policy";

type ModuleRule = {
  prefixes: readonly string[];
  view: Permission;
  manage?: Permission;
};

export type ApiRouteAccessPolicy =
  | { kind: "public" }
  | {
      kind: "authenticated";
      audience: "internal" | "shared" | "external";
    }
  | {
      kind: "permissions";
      allOf: readonly Permission[];
      anyOf?: readonly Permission[];
    }
  | { kind: "deny"; reason: "unregistered" | "unclassified" };

const MODULE_RULES: readonly ModuleRule[] = [
  { prefixes: ["/external-grants"], view: "users.manage", manage: "users.manage" },
  { prefixes: ["/external-accounts"], view: "users.manage", manage: "users.manage" },
  { prefixes: ["/users", "/admin/sessions"], view: "users.manage", manage: "users.manage" },
  { prefixes: ["/audit-logs"], view: "audit.view", manage: "audit.view" },
  { prefixes: ["/stats"], view: "statistics.view", manage: "statistics.view" },
  { prefixes: ["/client-errors", "/health", "/admin/health"], view: "diagnostics.view", manage: "diagnostics.manage" },
  { prefixes: ["/device-credentials"], view: "credentials.view", manage: "credentials.manage" },
  { prefixes: ["/quotes"], view: "quotes.view", manage: "quotes.manage" },
  { prefixes: ["/billing"], view: "billing.view", manage: "billing.manage" },
  {
    prefixes: [
      "/email-settings",
      "/email-import",
      "/email-import-settings",
      "/email-import-log",
      "/backups",
      "/gdpr",
    ],
    view: "settings.view",
    manage: "settings.manage",
  },
  {
    prefixes: [
      "/jobs",
      "/dashboard",
      "/job-groups",
      "/tasks",
      "/attachments",
      "/materials",
      "/time-entries",
      "/visits",
      "/risks",
    ],
    view: "jobs.view",
    manage: "jobs.manage",
  },
  { prefixes: ["/activities", "/activity-visits"], view: "activities.view", manage: "activities.manage" },
  {
    prefixes: [
      "/customers",
      "/customer-contacts",
      "/customer-sites",
      "/customer-documents",
    ],
    view: "customers.view",
    manage: "customers.manage",
  },
  { prefixes: ["/people", "/leaves", "/ppe"], view: "people.view", manage: "people.manage" },
  { prefixes: ["/warehouse"], view: "warehouse.view", manage: "warehouse.manage" },
  { prefixes: ["/machines"], view: "machines.view", manage: "machines.manage" },
  { prefixes: ["/switchboard-events"], view: "switchboards.audit.view", manage: "switchboards.audit.view" },
  { prefixes: ["/switchboards"], view: "switchboards.view", manage: "switchboards.update" },
];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const STAGED_UPLOAD_CLAIM_PERMISSIONS: readonly Permission[] = [
  "jobs.work",
  "activities.manage",
  "customers.manage",
];

type AuthenticatedRouteRule = {
  methods: ReadonlySet<string>;
  path: RegExp;
};

/**
 * Self-service routes whose handlers enforce ownership against req.auth.userId.
 * They are the only existing authenticated routes shared with external accounts.
 */
const SHARED_AUTHENTICATED_ROUTES: readonly AuthenticatedRouteRule[] = [
  { methods: new Set(["GET", "HEAD"]), path: /^\/auth\/webauthn\/credentials$/ },
  { methods: new Set(["DELETE"]), path: /^\/auth\/webauthn\/credentials\/[^/]+$/ },
  {
    methods: new Set(["POST"]),
    path: /^\/auth\/webauthn\/register\/(?:begin|complete)$/,
  },
  { methods: new Set(["GET", "HEAD"]), path: /^\/sessions$/ },
  { methods: new Set(["DELETE"]), path: /^\/sessions\/[^/]+$/ },
];

/**
 * Authenticated routes that do not use module permissions but still belong to
 * the internal application. External accounts fail closed at the global gate.
 */
const INTERNAL_AUTHENTICATED_ROUTES: readonly AuthenticatedRouteRule[] = [
  { methods: new Set(["POST"]), path: /^\/auth\/vault\/verify-password$/ },
  {
    methods: new Set(["POST"]),
    path: /^\/auth\/webauthn\/verify\/(?:begin|complete)$/,
  },
  { methods: new Set(["GET", "HEAD"]), path: /^\/me\/(?:jobs|ppe\/assignments|stats|visits)$/ },
  { methods: new Set(["POST"]), path: /^\/me\/ppe\/assignments\/[^/]+\/sign$/ },
  { methods: new Set(["GET", "HEAD", "PUT"]), path: /^\/preferences$/ },
  { methods: new Set(["GET", "HEAD"]), path: /^\/(?:events|public-holidays)$/ },
  { methods: new Set(["GET", "HEAD"]), path: /^\/storage\/objects\/.+$/ },
  { methods: new Set(["POST"]), path: /^\/client-errors$/ },
];

function normalizePath(pathOrUrl: string): string {
  let path = pathOrUrl.split("?", 1)[0] || "/";
  if (path === "/api") path = "/";
  else if (path.startsWith("/api/")) path = path.slice(4);
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return normalized === "HEAD" ? "GET" : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileRouteTemplate(template: string): RegExp {
  const segments = template.split("/").slice(1);
  const pattern = segments
    .map((segment) => {
      if (segment.startsWith(":")) return "[^/]+";
      if (segment.startsWith("*")) return ".+";
      return escapeRegExp(segment);
    })
    .join("/");
  return new RegExp(`^/${pattern}$`, "i");
}

const compiledRouteManifest = API_ROUTE_MANIFEST.map((route) => ({
  method: route.method,
  path: compileRouteTemplate(route.template),
}));

export function isRegisteredApiRoute(method: string, pathOrUrl: string): boolean {
  const normalizedMethod = normalizeMethod(method);
  const path = normalizePath(pathOrUrl);
  return compiledRouteManifest.some(
    (route) => route.method === normalizedMethod && route.path.test(path),
  );
}

function startsWithPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}-`);
}

function moduleRuleForPath(path: string): ModuleRule | undefined {
  return MODULE_RULES.find((candidate) =>
    candidate.prefixes.some((prefix) => startsWithPath(path, prefix)),
  );
}

function specificPermission(method: string, path: string): Permission | null {
  if (path === "/switchboards" && method === "POST") return "switchboards.create";
  if (/^\/switchboards\/\d+\/archive$/.test(path)) return "switchboards.archive";
  if (path.startsWith("/switchboards/field-registry")) return "switchboards.parser.manage";
  if (/^\/switchboards\/\d+\/extractions(?:\/|$)/.test(path)) {
    return READ_METHODS.has(method)
      ? "switchboards.extraction.review"
      : "switchboards.extraction.correct";
  }
  if (/^\/switchboards\/\d+\/documents\/compare$/.test(path)) return "switchboards.extraction.review";
  if (/^\/switchboards\/\d+\/documents\/\d+\/reprocess$/.test(path)) return "switchboards.extraction.review";
  if (/^\/switchboards\/\d+\/documents\/\d+\/public$/.test(path)) return "switchboards.documents.publish";
  if (/^\/switchboards\/\d+\/qr(?:\/|$)/.test(path)) return "switchboards.qr.manage";
  if (/^\/switchboards\/\d+\/labels\/generate$/.test(path)) return "switchboards.labels.generate";
  if (/^\/switchboards\/\d+\/labels\/\d+\/approve$/.test(path)) return "switchboards.labels.approve";
  if (/^\/switchboards\/checklist-templates(?:\/|$)/.test(path)) return "switchboards.templates.manage";
  if (/^\/switchboards\/\d+\/checklist\/phases\/[^/]+\/complete$/.test(path)) return "switchboards.phases.complete";
  if (/^\/switchboards\/\d+\/checklist(?:\/|$)/.test(path)) {
    return READ_METHODS.has(method) ? "switchboards.view" : "switchboards.checklist.fill";
  }
  if (/^\/switchboards\/\d+\/measurements(?:\/|$)/.test(path)) {
    return READ_METHODS.has(method) ? "switchboards.view" : "switchboards.measurements.create";
  }
  if (/^\/switchboards\/\d+\/photos(?:\/|$)/.test(path)) {
    return READ_METHODS.has(method) ? "switchboards.view" : "switchboards.photos.create";
  }
  if (/^\/switchboards\/\d+\/defects\/\d+\/(?:close|reopen)$/.test(path)) return "switchboards.defects.close";
  if (/^\/switchboards\/\d+\/defects(?:\/|$)/.test(path)) {
    return READ_METHODS.has(method) ? "switchboards.view" : "switchboards.defects.create";
  }
  if (/^\/switchboards\/\d+\/operations$/.test(path)) return "switchboards.view";
  if (/^\/switchboards\/\d+\/protocols\/generate$/.test(path)) return "switchboards.protocol.complete";
  if (/^\/switchboards\/\d+\/protocols(?:\/|$)/.test(path)) return "switchboards.view";
  if (/^\/switchboards\/\d+\/documents(?:\/|$)/.test(path)) {
    return READ_METHODS.has(method)
      ? "switchboards.documents.view"
      : "switchboards.documents.upload";
  }
  if (/^\/warehouse-movements\/(?:job-margin|jobs-margin|activity-margin)/.test(path)) return "rates.cost.view";
  if (path === "/storage/diagnose") return "diagnostics.view";

  if (/^\/jobs\/\d+\/tasks$/.test(path) && method === "POST") return "jobs.work";
  if (/^\/jobs\/\d+\/tasks\/\d+$/.test(path) && method === "PATCH") return "jobs.work";
  if (/^\/jobs\/\d+\/attachments$/.test(path) && method === "POST") return "jobs.work";
  if (/^\/jobs\/\d+\/documents\/(?:upload|merge-pages)$/.test(path) && method === "POST") return "jobs.work";
  if (/^\/jobs\/\d+\/materials$/.test(path) && method === "POST") return "jobs.work";
  if (/^\/jobs\/\d+\/materials\/\d+$/.test(path) && method === "PATCH") return "jobs.work";
  if (/^\/jobs\/\d+\/time-entries\/\d+\/(?:start|stop)$/.test(path) && method === "POST") return "jobs.work";
  if (/^\/jobs\/\d+\/billing-intent$/.test(path) && method === "PATCH") return "billing.manage";

  if (/\/(?:jobs|activities)\/\d+\/time-entries(?:\/|$)/.test(path)) {
    if (READ_METHODS.has(method)) return path.includes("/activities/") ? "activities.view" : "jobs.view";
    return "time.manage";
  }
  if (/\/(?:jobs|activities)\/\d+\/work-sessions(?:\/|$)/.test(path)) {
    if (READ_METHODS.has(method)) return path.includes("/activities/") ? "activities.view" : "jobs.view";
    return "time.manage";
  }
  if (/^\/people\/\d+\/hourly-rates(?:\/|$)/.test(path)) {
    return READ_METHODS.has(method) ? null : "rates.manage";
  }

  if (path.startsWith("/billing/")) {
    if (!READ_METHODS.has(method) && /\/delivery-note-resolution$/.test(path)) {
      return "billing.approve";
    }
    if (
      path.startsWith("/billing/settings") ||
      path.startsWith("/billing/ai-extraction") ||
      path.startsWith("/billing/document-linking") ||
      path.startsWith("/billing/email-import")
    ) {
      return READ_METHODS.has(method) ? "billing.view" : "billing.settings";
    }
    if (!READ_METHODS.has(method) && /\/approve(?:\/|$)/.test(path)) {
      return "billing.approve";
    }
  }

  const moduleRule = moduleRuleForPath(path);
  if (!moduleRule) return null;
  return READ_METHODS.has(method) ? moduleRule.view : (moduleRule.manage ?? moduleRule.view);
}

function matchesAuthenticatedRoute(
  routes: readonly AuthenticatedRouteRule[],
  method: string,
  path: string,
): boolean {
  return routes.some(
    (route) => route.methods.has(method) && route.path.test(path),
  );
}

const EXTERNAL_PORTAL_ROUTES: readonly AuthenticatedRouteRule[] = [
  { methods: new Set(["GET", "HEAD"]), path: /^\/portal\/resources$/ },
  { methods: new Set(["GET", "HEAD"]), path: /^\/portal\/resources\/[^/]+$/ },
];

export function resolveApiRouteAccess(
  method: string,
  pathOrUrl: string,
): ApiRouteAccessPolicy {
  const normalizedMethod = method.toUpperCase();
  const policyMethod = normalizeMethod(normalizedMethod);
  const path = normalizePath(pathOrUrl);

  if (!isRegisteredApiRoute(policyMethod, path)) {
    return { kind: "deny", reason: "unregistered" };
  }
  if (isPublicApiRequest(normalizedMethod, `/api${path}`)) return { kind: "public" };
  if (matchesAuthenticatedRoute(EXTERNAL_PORTAL_ROUTES, normalizedMethod, path)) {
    return { kind: "authenticated", audience: "external" };
  }
  if (matchesAuthenticatedRoute(SHARED_AUTHENTICATED_ROUTES, normalizedMethod, path)) {
    return { kind: "authenticated", audience: "shared" };
  }
  if (matchesAuthenticatedRoute(INTERNAL_AUTHENTICATED_ROUTES, normalizedMethod, path)) {
    return { kind: "authenticated", audience: "internal" };
  }
  if (normalizedMethod === "POST" && path === "/storage/uploads") {
    return {
      kind: "permissions",
      allOf: [],
      anyOf: [...STAGED_UPLOAD_CLAIM_PERMISSIONS],
    };
  }

  const moduleRule = moduleRuleForPath(path);
  const specific = specificPermission(policyMethod, path);
  const allOf = new Set<Permission>();
  if (moduleRule) allOf.add(moduleRule.view);
  if (specific) allOf.add(specific);

  if (
    READ_METHODS.has(policyMethod) &&
    /^\/people\/\d+\/hourly-rates(?:\/|$)/.test(path)
  ) {
    if (allOf.size === 0) return { kind: "deny", reason: "unclassified" };
    return {
      kind: "permissions",
      allOf: [...allOf],
      anyOf: ["rates.cost.view", "rates.sale.view"],
    };
  }
  if (path.startsWith("/stats")) allOf.add("billing.view");

  if (allOf.size === 0) return { kind: "deny", reason: "unclassified" };
  return { kind: "permissions", allOf: [...allOf] };
}
