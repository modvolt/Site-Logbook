import type { Agent } from "supertest";
import { isPublicApiRequest } from "../src/lib/public-api-policy";

const OFFLINE_SCOPE_HEADER = "X-Stavba-Offline-Scope";
const IDEMPOTENCY_HEADER = "Idempotency-Key";
const OFFLINE_SCOPE_PATTERN = /^[0-9a-f]{64}$/;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
let requestSequence = 0;

interface ScopeAwareRequest {
  method: string;
  url: string;
  set(name: string, value: string): unknown;
}

const configuredAgents = new WeakSet<object>();
const scopes = new WeakMap<object, string>();

/**
 * Mirror the browser identity-fetch contract in DB-backed SuperTest suites.
 * Public auth routes stay headerless; every later private request carries the
 * exact server-issued scope learned from the agent's own /api/auth/me session.
 */
export async function bindAuthenticatedAgent(agent: Agent): Promise<Agent> {
  const me = await agent.get("/api/auth/me");
  const scope = me.body?.offlineScope;
  if (me.status !== 200 || me.body?.authenticated !== true || !OFFLINE_SCOPE_PATTERN.test(scope)) {
    throw new Error("Authenticated SuperTest agent did not receive a valid offline scope");
  }

  scopes.set(agent, scope);
  if (!configuredAgents.has(agent)) {
    agent.use((request: ScopeAwareRequest) => {
      const currentScope = scopes.get(agent);
      if (!currentScope) return;
      const url = new URL(request.url, "http://supertest.local");
      if (!isPublicApiRequest(request.method, url.pathname + url.search)) {
        request.set(OFFLINE_SCOPE_HEADER, currentScope);
        if (MUTATION_METHODS.has(request.method.toUpperCase())) {
          requestSequence += 1;
          request.set(
            IDEMPOTENCY_HEADER,
            `db-test-${process.pid}-${Date.now().toString(36)}-${requestSequence.toString(36)}`,
          );
        }
      }
    });
    configuredAgents.add(agent);
  }
  return agent;
}
