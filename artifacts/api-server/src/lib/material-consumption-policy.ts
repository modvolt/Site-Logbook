export type MaterialStockSourceType = "material" | "activity_material";

/**
 * Job materials are only issued after explicit consumption. Activity materials
 * retain their established immediate-issue behaviour until that workflow is
 * migrated separately.
 */
export function materialShouldIssueStock(
  sourceType: MaterialStockSourceType,
  material: { done?: boolean },
): boolean {
  return sourceType === "activity_material" || material.done === true;
}
