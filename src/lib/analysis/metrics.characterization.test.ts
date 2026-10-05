import { describe, expect, it } from "vitest";

import { computeProjectMetrics } from "@/lib/analysis/metrics";
import { analysisFixtureFiles } from "@/test/fixtures/analysis-project";

// Pins the complete output of today's deterministic analysis (every
// heuristic, the per-rule caps and the known false positives) before the
// heuristics become `Rule`s. A refactor must leave the snapshot untouched;
// an intended fix (TD-31, `src/test/`, secrets in fixtures) updates it, and
// the snapshot diff shows exactly what changed.

describe("computeProjectMetrics (characterization)", () => {
  it("produces the same metrics, issues and summaries", () => {
    expect(computeProjectMetrics(analysisFixtureFiles())).toMatchSnapshot();
  });
});
