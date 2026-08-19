export interface ProductionHostOperatorDependencies {
  sourceSha: string;
  runHostEvidence?: (
    argv: string[],
    sourceSha: string,
  ) => Promise<unknown>;
  publication?: {
    syncDirectory?: (directory: string) => Promise<void>;
  };
}

export function productionHostOperatorUsage(): string;

export function runProductionHostOperator(
  argv: string[],
  dependencies: ProductionHostOperatorDependencies,
): Promise<unknown>;
