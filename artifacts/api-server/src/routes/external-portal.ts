import { Router, type IRouter, type Request } from "express";
import { externalAccountsEnabled } from "../lib/external-accounts-feature";
import {
  getExternalPortalResource,
  listExternalPortalResources,
} from "../lib/external-portal-service";

const router: IRouter = Router();

function externalPortalAvailable(req: Request) {
  return externalAccountsEnabled() && req.auth?.accountType === "external";
}

router.get("/portal/resources", async (req, res): Promise<void> => {
  if (!externalPortalAvailable(req)) {
    res.status(403).json({ error: "Forbidden", code: "external_portal_disabled" });
    return;
  }
  res.json({
    items: await listExternalPortalResources(req.auth!.userId),
    cacheMode: "network-only",
  });
});

router.get("/portal/resources/:scopeId", async (req, res): Promise<void> => {
  if (!externalPortalAvailable(req)) {
    res.status(403).json({ error: "Forbidden", code: "external_portal_disabled" });
    return;
  }
  const scopeId = Number(req.params.scopeId);
  if (!Number.isSafeInteger(scopeId) || scopeId <= 0) {
    res.status(404).json({ error: "Resource not found" });
    return;
  }
  const resource = await getExternalPortalResource(req.auth!.userId, scopeId);
  if (!resource) {
    res.status(404).json({ error: "Resource not found" });
    return;
  }
  res.json({ resource, cacheMode: "network-only" });
});

export default router;
