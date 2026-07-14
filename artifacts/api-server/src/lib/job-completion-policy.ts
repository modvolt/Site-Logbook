export interface CompletionPolicyIssue {
  code: string;
  message: string;
  count?: number;
}

export interface CompletionPolicyInput {
  customerId: number | null;
  activeSessionCount: number;
  unfinishedTaskCount: number;
  plannedMaterialCount: number;
  hoursSpent: number;
  pricingMode: string;
}

export function evaluateJobCompletion(input: CompletionPolicyInput): {
  blockers: CompletionPolicyIssue[];
  warnings: CompletionPolicyIssue[];
} {
  const blockers: CompletionPolicyIssue[] = [];
  const warnings: CompletionPolicyIssue[] = [];

  if (input.customerId == null) {
    blockers.push({ code: "missing_customer", message: "Zakázka nemá přiřazeného zákazníka." });
  }
  if (input.activeSessionCount > 0) {
    blockers.push({
      code: "active_work_sessions",
      message: "Na zakázce stále běží měření času.",
      count: input.activeSessionCount,
    });
  }
  if (input.unfinishedTaskCount > 0) {
    warnings.push({
      code: "unfinished_tasks",
      message: "Některé úkoly nejsou označené jako hotové.",
      count: input.unfinishedTaskCount,
    });
  }
  if (input.plannedMaterialCount > 0) {
    warnings.push({
      code: "planned_materials",
      message: "Některý materiál zůstal pouze plánovaný a nevstoupí do skladu ani fakturace.",
      count: input.plannedMaterialCount,
    });
  }
  if (input.pricingMode !== "fixed_price" && input.hoursSpent <= 0) {
    warnings.push({
      code: "missing_work_time",
      message: "U časové zakázky není zaznamenaný žádný odpracovaný čas.",
    });
  }

  return { blockers, warnings };
}
