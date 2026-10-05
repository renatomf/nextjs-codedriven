import { computeDeterministicMetrics, type DeterministicMetrics, type SourceFile } from "@/modules/analysis";

import { measureFunctions } from "./function-sizes";

export type { DeterministicMetrics, SourceFile };

/**
 * The deterministic analysis of a project: function sizes from the syntax
 * tree (native parser, server only), then the pure metrics and rules.
 */
export function computeProjectMetrics(files: SourceFile[]): DeterministicMetrics {
  return computeDeterministicMetrics(files, measureFunctions(files));
}
