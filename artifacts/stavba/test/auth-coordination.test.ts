import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import {
  createAuthTransitionOrderGuard,
  resetIdentityQueries,
} from "../src/lib/auth-coordination";

describe("auth transition coordination", () => {
  it("never lets an older changing event overwrite a completed transition", () => {
    const accept = createAuthTransitionOrderGuard();
    expect(accept({ transitionId: "new", issuedAt: 20, stage: "changed" })).toBe(true);
    expect(accept({ transitionId: "old", issuedAt: 10, stage: "changing" })).toBe(false);
    expect(accept({ transitionId: "new", issuedAt: 20, stage: "changing" })).toBe(false);
  });

  it("publishes the signed-out snapshot before asynchronous cancellation settles", async () => {
    const queryClient = new QueryClient();
    const authKey = getGetMeQueryKey();
    queryClient.setQueryData(authKey, { authenticated: true, user: { id: 7 } });
    queryClient.setQueryData(["jobs"], [{ id: 42, marker: "alice" }]);
    let releaseCancellation = () => undefined;
    vi.spyOn(queryClient, "cancelQueries").mockReturnValue(new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    }));

    const reset = resetIdentityQueries(queryClient);
    expect(queryClient.getQueryData(authKey)).toMatchObject({ authenticated: false, user: null });
    expect(queryClient.getQueryData(["jobs"])).toBeUndefined();

    releaseCancellation();
    await reset;
  });
});
