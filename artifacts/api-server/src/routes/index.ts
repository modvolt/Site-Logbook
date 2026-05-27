import { Router, type IRouter } from "express";
import healthRouter from "./health";
import jobsRouter from "./jobs";
import tasksRouter from "./tasks";
import attachmentsRouter from "./attachments";
import materialsRouter from "./materials";
import peopleRouter from "./people";
import customersRouter from "./customers";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(jobsRouter);
router.use(tasksRouter);
router.use(attachmentsRouter);
router.use(materialsRouter);
router.use(peopleRouter);
router.use(customersRouter);
router.use(dashboardRouter);

export default router;
