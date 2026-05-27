import { Router, type IRouter } from "express";
import healthRouter from "./health";
import jobsRouter from "./jobs";
import tasksRouter from "./tasks";
import attachmentsRouter from "./attachments";
import materialsRouter from "./materials";
import peopleRouter from "./people";
import customersRouter from "./customers";
import dashboardRouter from "./dashboard";
import storageRouter from "./storage";
import authRouter from "./auth";
import usersRouter from "./users";
import preferencesRouter from "./preferences";
import activitiesRouter from "./activities";
import meRouter from "./me";

const router: IRouter = Router();

router.use(healthRouter);
router.use(jobsRouter);
router.use(tasksRouter);
router.use(attachmentsRouter);
router.use(materialsRouter);
router.use(peopleRouter);
router.use(customersRouter);
router.use(dashboardRouter);
router.use(storageRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(preferencesRouter);
router.use(activitiesRouter);
router.use(meRouter);

export default router;
