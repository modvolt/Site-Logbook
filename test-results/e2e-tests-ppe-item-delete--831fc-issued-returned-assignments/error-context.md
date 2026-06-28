# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/tests/ppe-item-delete.spec.ts >> PPE item – archive guard (active assignments) >> returns 200 via API when item has only non-issued (returned) assignments
- Location: e2e/tests/ppe-item-delete.spec.ts:51:7

# Error details

```
TypeError: apiRequestContext.post: Invalid URL
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | 
  3  | test.describe("PPE item – archive guard (active assignments)", () => {
  4  |   test("returns 409 with Czech message via API when item has active assignments", async ({
  5  |     request,
  6  |   }) => {
  7  |     const itemRes = await request.post("/api/ppe/items", {
  8  |       data: { name: `E2E_PPE_DEL_${Date.now()}`, category: "ostatni" },
  9  |     });
  10 |     expect(itemRes.status()).toBe(201);
  11 |     const item = (await itemRes.json()) as { id: number };
  12 | 
  13 |     const personRes = await request.post("/api/people", {
  14 |       data: { name: `E2E_PPE_DEL_Person_${Date.now()}` },
  15 |     });
  16 |     expect(personRes.status()).toBe(201);
  17 |     const person = (await personRes.json()) as { id: number };
  18 | 
  19 |     const assignRes = await request.post("/api/ppe/assignments", {
  20 |       data: {
  21 |         ppeItemId: item.id,
  22 |         personId: person.id,
  23 |         quantity: 1,
  24 |         issuedAt: "2026-01-01",
  25 |       },
  26 |     });
  27 |     expect(assignRes.status()).toBe(201);
  28 | 
  29 |     const deleteRes = await request.delete(`/api/ppe/items/${item.id}`);
  30 |     expect(deleteRes.status()).toBe(409);
  31 | 
  32 |     const body = (await deleteRes.json()) as { error: string };
  33 |     expect(body.error).toMatch(/aktivní/);
  34 |     expect(body.error).toMatch(/nelze ji archivovat/);
  35 |   });
  36 | 
  37 |   test("returns 200 via API when item has no active assignments", async ({ request }) => {
  38 |     const itemRes = await request.post("/api/ppe/items", {
  39 |       data: { name: `E2E_PPE_DEL_Clean_${Date.now()}`, category: "ostatni" },
  40 |     });
  41 |     expect(itemRes.status()).toBe(201);
  42 |     const item = (await itemRes.json()) as { id: number };
  43 | 
  44 |     const deleteRes = await request.delete(`/api/ppe/items/${item.id}`);
  45 |     expect(deleteRes.status()).toBe(200);
  46 | 
  47 |     const body = (await deleteRes.json()) as { active: boolean };
  48 |     expect(body.active).toBe(false);
  49 |   });
  50 | 
  51 |   test("returns 200 via API when item has only non-issued (returned) assignments", async ({
  52 |     request,
  53 |   }) => {
> 54 |     const itemRes = await request.post("/api/ppe/items", {
     |                                   ^ TypeError: apiRequestContext.post: Invalid URL
  55 |       data: { name: `E2E_PPE_DEL_Returned_${Date.now()}`, category: "ostatni" },
  56 |     });
  57 |     expect(itemRes.status()).toBe(201);
  58 |     const item = (await itemRes.json()) as { id: number };
  59 | 
  60 |     const personRes = await request.post("/api/people", {
  61 |       data: { name: `E2E_PPE_Ret_Person_${Date.now()}` },
  62 |     });
  63 |     expect(personRes.status()).toBe(201);
  64 |     const person = (await personRes.json()) as { id: number };
  65 | 
  66 |     const assignRes = await request.post("/api/ppe/assignments", {
  67 |       data: {
  68 |         ppeItemId: item.id,
  69 |         personId: person.id,
  70 |         quantity: 1,
  71 |         issuedAt: "2026-01-01",
  72 |       },
  73 |     });
  74 |     expect(assignRes.status()).toBe(201);
  75 |     const assignment = (await assignRes.json()) as { id: number };
  76 | 
  77 |     const returnRes = await request.patch(`/api/ppe/assignments/${assignment.id}`, {
  78 |       data: { status: "returned", returnedAt: "2026-06-01" },
  79 |     });
  80 |     expect(returnRes.status()).toBe(200);
  81 | 
  82 |     const deleteRes = await request.delete(`/api/ppe/items/${item.id}`);
  83 |     expect(deleteRes.status()).toBe(200);
  84 | 
  85 |     const body = (await deleteRes.json()) as { active: boolean };
  86 |     expect(body.active).toBe(false);
  87 |   });
  88 | });
  89 | 
```