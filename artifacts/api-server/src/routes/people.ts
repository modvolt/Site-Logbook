import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, peopleTable } from "@workspace/db";
import {
  CreatePersonBody,
  UpdatePersonParams,
  UpdatePersonBody,
  DeletePersonParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializePerson(p: typeof peopleTable.$inferSelect) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
  };
}

router.get("/people", async (_req, res): Promise<void> => {
  const people = await db.select().from(peopleTable).orderBy(peopleTable.name);
  res.json(people.map(serializePerson));
});

router.post("/people", async (req, res): Promise<void> => {
  const parsed = CreatePersonBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [person] = await db.insert(peopleTable).values(parsed.data).returning();
  res.status(201).json(serializePerson(person));
});

router.patch("/people/:id", async (req, res): Promise<void> => {
  const params = UpdatePersonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdatePersonBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [person] = await db
    .update(peopleTable)
    .set(parsed.data)
    .where(eq(peopleTable.id, params.data.id))
    .returning();

  if (!person) {
    res.status(404).json({ error: "Person not found" });
    return;
  }

  res.json(serializePerson(person));
});

router.delete("/people/:id", async (req, res): Promise<void> => {
  const params = DeletePersonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [person] = await db
    .delete(peopleTable)
    .where(eq(peopleTable.id, params.data.id))
    .returning();

  if (!person) {
    res.status(404).json({ error: "Person not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
