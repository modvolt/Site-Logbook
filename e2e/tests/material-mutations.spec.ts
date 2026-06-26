import { test, expect } from "@playwright/test";

type Material = {
  id: number;
  quantity: number;
  warehouseItemId: number | null;
};

type Movement = {
  id: number;
  direction: string;
  quantity: number;
  sourceType: string;
  sourceId: number | null;
};

test.describe("Job material-line mutations with warehouse stock", () => {
  let jobId: number;
  let warehouseItemId: number;
  let materialId: number;
  const itemName = `E2E_MAT_${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const jobRes = await request.post("/api/jobs", {
      data: {
        title: `E2E_MAT_Job_${Date.now()}`,
        date: "2026-01-15",
        type: "other",
        status: "planned",
      },
    });
    expect(jobRes.status()).toBe(201);
    const job = (await jobRes.json()) as { id: number };
    jobId = job.id;

    const itemRes = await request.post("/api/warehouse-items", {
      data: { name: itemName, quantity: "10" },
    });
    expect(itemRes.status()).toBe(201);
    const item = (await itemRes.json()) as { id: number };
    warehouseItemId = item.id;
  });

  test.afterAll(async ({ request }) => {
    if (materialId) {
      await request
        .delete(`/api/jobs/${jobId}/materials/${materialId}`)
        .catch(() => {});
    }
    if (warehouseItemId) {
      await request
        .delete(`/api/warehouse-items/${warehouseItemId}`)
        .catch(() => {});
    }
  });

  test("add material creates entry and 'out' stock movement", async ({
    request,
  }) => {
    const res = await request.post(`/api/jobs/${jobId}/materials`, {
      data: { name: itemName, quantity: 3, warehouseItemId },
    });
    expect(res.status()).toBe(201);
    const mat = (await res.json()) as Material;
    expect(mat.quantity).toBe(3);
    materialId = mat.id;

    const movRes = await request.get(
      `/api/warehouse-items/${warehouseItemId}/movements`,
    );
    expect(movRes.status()).toBe(200);
    const movements = (await movRes.json()) as Movement[];

    const outMovements = movements.filter(
      (m) => m.sourceType === "material" && m.sourceId === materialId,
    );
    expect(outMovements.length).toBeGreaterThanOrEqual(1);

    const netOut = movements
      .filter((m) => m.sourceType === "material" && m.sourceId === materialId)
      .reduce(
        (sum, m) =>
          sum + (m.direction === "out" ? m.quantity : -m.quantity),
        0,
      );
    expect(netOut).toBeCloseTo(3, 1);
  });

  test("edit quantity updates material and adjusts stock movements", async ({
    request,
  }) => {
    const res = await request.patch(
      `/api/jobs/${jobId}/materials/${materialId}`,
      { data: { quantity: 5 } },
    );
    expect(res.status()).toBe(200);
    const mat = (await res.json()) as Material;
    expect(mat.quantity).toBe(5);

    const movRes = await request.get(
      `/api/warehouse-items/${warehouseItemId}/movements`,
    );
    expect(movRes.status()).toBe(200);
    const movements = (await movRes.json()) as Movement[];

    const netOut = movements
      .filter((m) => m.sourceType === "material" && m.sourceId === materialId)
      .reduce(
        (sum, m) =>
          sum + (m.direction === "out" ? m.quantity : -m.quantity),
        0,
      );
    expect(netOut).toBeCloseTo(5, 1);
  });

  test("delete material reverses stock movements to net zero", async ({
    request,
  }) => {
    const res = await request.delete(
      `/api/jobs/${jobId}/materials/${materialId}`,
    );
    expect(res.status()).toBe(204);

    const movRes = await request.get(
      `/api/warehouse-items/${warehouseItemId}/movements`,
    );
    expect(movRes.status()).toBe(200);
    const movements = (await movRes.json()) as Movement[];

    const netOut = movements
      .filter((m) => m.sourceType === "material" && m.sourceId === materialId)
      .reduce(
        (sum, m) =>
          sum + (m.direction === "out" ? m.quantity : -m.quantity),
        0,
      );
    expect(netOut).toBeCloseTo(0, 1);

    materialId = 0;
  });
});
