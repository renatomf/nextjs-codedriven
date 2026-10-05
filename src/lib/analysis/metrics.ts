import {
  computeDeterministicMetrics,
  type DependencyScan,
  type DeterministicMetrics,
  type SourceFile,
} from "@/modules/analysis";

import { measureFunctions } from "./function-sizes";

export type { DeterministicMetrics, SourceFile };

/**
 * The deterministic analysis of a project: function sizes from the syntax
 * tree (native parser, server only), then the pure metrics and rules.
 * `dependencyScan` comes from `scanDependencies` (osv.ts); without it the
 * dependencies are not checked (ADR-012).
 */
export function computeProjectMetrics(
  files: SourceFile[],
  dependencyScan: DependencyScan = { status: "not-scanned" },
): DeterministicMetrics {
  return computeDeterministicMetrics(files, measureFunctions(files), dependencyScan);
}
