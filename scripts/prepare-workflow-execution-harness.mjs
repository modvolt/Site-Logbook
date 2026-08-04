import {
  prepareWorkflowHarnessImage,
  WORKFLOW_HARNESS_IMAGE,
} from "./workflow-execution-harness.mjs";

const image = prepareWorkflowHarnessImage();
if (image !== WORKFLOW_HARNESS_IMAGE) {
  throw new Error("Workflow harness preparation returned an unexpected image.");
}
console.log(`Prepared ${image}`);
