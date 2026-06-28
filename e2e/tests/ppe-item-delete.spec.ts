import { test, expect } from "@playwright/test";
import { cleanupPpeAssignment, cleanupPpeItem, cleanupPerson } from "./helpers";

test.describe("PPE item – archive guard (active assignments)", () => {
  test("returns 409 with Czech message via API when item has active assignments", async ({
    request,
  }) => {
    let itemId: number | undefined;
    let personId: number | undefined;
    let assignmentId: number | undefined;

    try {
      const itemRes = await request.post("/api/ppe/items", {
        data: { name: `E2E_PPE_DEL_${Date.now()}`, category: "ostatni" },
      });
      expect(itemRes.status()).toBe(201);
      const item = (await itemRes.json()) as { id: number };
      itemId = item.id;

      const personRes = await request.post("/api/people", {
        data: { name: `E2E_PPE_DEL_Person_${Date.now()}` },
      });
      expect(personRes.status()).toBe(201);
      const person = (await personRes.json()) as { id: number };
      personId = person.id;

      const assignRes = await request.post("/api/ppe/assignments", {
        data: {
          ppeItemId: item.id,
          personId: person.id,
          quantity: 1,
          issuedAt: "2026-01-01",
        },
      });
      expect(assignRes.status()).toBe(201);
      const assignment = (await assignRes.json()) as { id: number };
      assignmentId = assignment.id;

      const deleteRes = await request.delete(`/api/ppe/items/${item.id}`);
      expect(deleteRes.status()).toBe(409);

      const body = (await deleteRes.json()) as { error: string };
      expect(body.error).toMatch(/aktivní/);
      expect(body.error).toMatch(/nelze ji archivovat/);
    } finally {
      if (assignmentId !== undefined) await cleanupPpeAssignment(request, assignmentId);
      if (itemId !== undefined) await cleanupPpeItem(request, itemId);
      if (personId !== undefined) await cleanupPerson(request, personId);
    }
  });

  test("returns 200 via API when item has no active assignments", async ({ request }) => {
    const itemRes = await request.post("/api/ppe/items", {
      data: { name: `E2E_PPE_DEL_Clean_${Date.now()}`, category: "ostatni" },
    });
    expect(itemRes.status()).toBe(201);
    const item = (await itemRes.json()) as { id: number };

    const deleteRes = await request.delete(`/api/ppe/items/${item.id}`);
    expect(deleteRes.status()).toBe(200);

    const body = (await deleteRes.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });

  test("returns 200 via API when item has only non-issued (returned) assignments", async ({
    request,
  }) => {
    let itemId: number | undefined;
    let personId: number | undefined;
    let assignmentId: number | undefined;

    try {
      const itemRes = await request.post("/api/ppe/items", {
        data: { name: `E2E_PPE_DEL_Returned_${Date.now()}`, category: "ostatni" },
      });
      expect(itemRes.status()).toBe(201);
      const item = (await itemRes.json()) as { id: number };
      itemId = item.id;

      const personRes = await request.post("/api/people", {
        data: { name: `E2E_PPE_Ret_Person_${Date.now()}` },
      });
      expect(personRes.status()).toBe(201);
      const person = (await personRes.json()) as { id: number };
      personId = person.id;

      const assignRes = await request.post("/api/ppe/assignments", {
        data: {
          ppeItemId: item.id,
          personId: person.id,
          quantity: 1,
          issuedAt: "2026-01-01",
        },
      });
      expect(assignRes.status()).toBe(201);
      const assignment = (await assignRes.json()) as { id: number };
      assignmentId = assignment.id;

      const returnRes = await request.patch(`/api/ppe/assignments/${assignmentId}`, {
        data: { status: "returned", returnedAt: "2026-06-01" },
      });
      expect(returnRes.status()).toBe(200);

      const deleteRes = await request.delete(`/api/ppe/items/${itemId}`);
      expect(deleteRes.status()).toBe(200);

      const body = (await deleteRes.json()) as { active: boolean };
      expect(body.active).toBe(false);
    } finally {
      if (assignmentId !== undefined) await cleanupPpeAssignment(request, assignmentId);
      if (itemId !== undefined) await cleanupPpeItem(request, itemId);
      if (personId !== undefined) await cleanupPerson(request, personId);
    }
  });
});
