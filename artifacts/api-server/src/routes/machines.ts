import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, machinesTable, peopleTable } from "@workspace/db";
import {
  CreateMachineBody,
  GetMachineParams,
  UpdateMachineParams,
  UpdateMachineBody,
  DeleteMachineParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function serializeMachine(m: typeof machinesTable.$inferSelect) {
  let assignedPersonName: string | null = null;
  if (m.assignedPersonId) {
    const [person] = await db
      .select({ name: peopleTable.name })
      .from(peopleTable)
      .where(eq(peopleTable.id, m.assignedPersonId));
    assignedPersonName = person?.name ?? null;
  }
  return {
    ...m,
    assignedPersonName,
    createdAt: m.createdAt.toISOString(),
  };
}

router.get("/machines", async (_req, res): Promise<void> => {
  const machines = await db.select().from(machinesTable).orderBy(machinesTable.name);
  res.json(await Promise.all(machines.map(serializeMachine)));
});

router.get("/machines/:id", async (req, res): Promise<void> => {
  const params = GetMachineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [machine] = await db.select().from(machinesTable).where(eq(machinesTable.id, params.data.id));
  if (!machine) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }

  res.json(await serializeMachine(machine));
});

router.post("/machines", async (req, res): Promise<void> => {
  const parsed = CreateMachineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [machine] = await db.insert(machinesTable).values(parsed.data).returning();
  res.status(201).json(await serializeMachine(machine));
});

router.patch("/machines/:id", async (req, res): Promise<void> => {
  const params = UpdateMachineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateMachineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [machine] = await db
    .update(machinesTable)
    .set(parsed.data)
    .where(eq(machinesTable.id, params.data.id))
    .returning();

  if (!machine) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }

  res.json(await serializeMachine(machine));
});

router.delete("/machines/:id", async (req, res): Promise<void> => {
  const params = DeleteMachineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [machine] = await db
    .delete(machinesTable)
    .where(eq(machinesTable.id, params.data.id))
    .returning();

  if (!machine) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
