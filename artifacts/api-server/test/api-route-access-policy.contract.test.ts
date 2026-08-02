import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_ROUTE_MANIFEST } from "../src/generated/api-route-manifest";
import {
  isRegisteredApiRoute,
  resolveApiRouteAccess,
} from "../src/lib/api-route-access-policy";

const routePattern =
  /router\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(["'])([^"']+)\2/gi;
const routeRegistrationPattern =
  /router\.(get|post|put|patch|delete|options|head|all)\s*\(/gi;

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function routeSources() {
  const routesDir = path.resolve(process.cwd(), "src", "routes");
  return readdirSync(routesDir)
    .filter((fileName) => fileName.endsWith(".ts") && fileName !== "index.ts")
    .sort()
    .map((fileName) => ({
      fileName,
      source: readFileSync(path.join(routesDir, fileName), "utf8"),
    }));
}

function sourceRoutes() {
  return routeSources()
    .flatMap(({ fileName, source }) => {
      return [...source.matchAll(routePattern)].map((match) => ({
        method: match[1].toUpperCase(),
        template: match[3],
        source: fileName,
      }));
    })
    .sort((a, b) =>
      compareCodeUnits(a.template, b.template) ||
      compareCodeUnits(a.method, b.method) ||
      compareCodeUnits(a.source, b.source),
    );
}

function materialize(template: string): string {
  return template
    .replace(/:sha256\b/g, "a".repeat(64))
    .replace(/:[A-Za-z0-9_]+/g, "1")
    .replace(/\*[A-Za-z0-9_]+/g, "known/path");
}

describe("generated API route manifest", () => {
  it("is an exact, duplicate-free snapshot of every literal router registration", () => {
    const source = sourceRoutes();
    const registrationCount = routeSources().reduce(
      (count, routeSource) =>
        count + [...routeSource.source.matchAll(routeRegistrationPattern)].length,
      0,
    );
    expect(source.length).toBeGreaterThan(390);
    expect(source.length).toBe(registrationCount);
    expect(new Set(source.map((route) => `${route.method} ${route.template}`)).size).toBe(
      source.length,
    );
    expect(source).toEqual([...API_ROUTE_MANIFEST]);
  });

  it("classifies every registered method and path without a default allow", () => {
    for (const route of API_ROUTE_MANIFEST) {
      const path = materialize(route.template);
      expect(
        resolveApiRouteAccess(route.method, path),
        `${route.method} ${route.template} (${route.source})`,
      ).not.toMatchObject({ kind: "deny" });
    }
  });

  it.each([
    ["POST", "/jobs/future-admin-action"],
    ["GET", "/billing/future-report"],
    ["GET", "/auth/future-route"],
    ["GET", "/me/future-route"],
    ["GET", "/storage/objects"],
    ["PATCH", "/switchboards/1/future-action"],
    ["GET", "/future-module/anything"],
  ])("denies unregistered near-miss %s %s", (method, routePath) => {
    expect(isRegisteredApiRoute(method, routePath)).toBe(false);
    expect(resolveApiRouteAccess(method, routePath)).toEqual({
      kind: "deny",
      reason: "unregistered",
    });
  });

  it("preserves explicit authenticated-only self-service and delegated routes", () => {
    expect(resolveApiRouteAccess("GET", "/events")).toEqual({ kind: "authenticated" });
    expect(resolveApiRouteAccess("GET", "/sessions")).toEqual({ kind: "authenticated" });
    expect(resolveApiRouteAccess("PUT", "/preferences")).toEqual({ kind: "authenticated" });
    expect(resolveApiRouteAccess("GET", "/storage/objects/uploads/known")).toEqual({
      kind: "authenticated",
    });
  });

  it("requires a staged-upload claim permission for upload intents", () => {
    expect(resolveApiRouteAccess("POST", "/storage/uploads")).toEqual({
      kind: "permissions",
      allOf: [],
      anyOf: ["jobs.work", "activities.manage", "customers.manage"],
    });
  });

  it("preserves composite permissions for sensitive route exceptions", () => {
    expect(resolveApiRouteAccess("POST", "/jobs/1/tasks")).toEqual({
      kind: "permissions",
      allOf: ["jobs.view", "jobs.work"],
    });
    expect(resolveApiRouteAccess("PATCH", "/jobs/1/billing-intent")).toEqual({
      kind: "permissions",
      allOf: ["jobs.view", "billing.manage"],
    });
    expect(resolveApiRouteAccess("GET", "/people/1/hourly-rates")).toEqual({
      kind: "permissions",
      allOf: ["people.view"],
      anyOf: ["rates.cost.view", "rates.sale.view"],
    });
    expect(resolveApiRouteAccess("POST", "/people/1/hourly-rates")).toEqual({
      kind: "permissions",
      allOf: ["people.view", "rates.manage"],
    });
    expect(resolveApiRouteAccess("GET", "/stats/overview")).toEqual({
      kind: "permissions",
      allOf: ["statistics.view", "billing.view"],
    });
    expect(resolveApiRouteAccess("POST", "/email-import/poll")).toEqual({
      kind: "permissions",
      allOf: ["settings.view", "settings.manage"],
    });
  });

  it("treats HEAD as the registered GET route without widening other methods", () => {
    expect(resolveApiRouteAccess("HEAD", "/jobs")).toEqual({
      kind: "permissions",
      allOf: ["jobs.view"],
    });
    expect(resolveApiRouteAccess("OPTIONS", "/jobs")).toEqual({
      kind: "deny",
      reason: "unregistered",
    });
  });
});
