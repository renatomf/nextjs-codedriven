import { describe, expect, it } from "vitest";

import { analyzeImportGraph, HIGH_FAN_OUT, type ImportNode } from "./import-graph";
import { diminishingPenaltyPolicy } from "./scoring";
import type { ProjectMeasures } from "./rules";

const graph = (edges: Record<string, string[]>, facades: string[] = []) =>
  new Map<string, ImportNode>(
    Object.entries(edges).map(([key, targets]) => [
      key,
      { filePath: `${key}.ts`, facade: false, reExportsMostly: facades.includes(key), targets },
    ]),
  );

// ADR-013: the structure measured on the project's own import graph.
describe("analyzeImportGraph", () => {
  it("finds every group of files that import each other, largest first", () => {
    const measures = analyzeImportGraph(
      graph({
        a: ["b"],
        b: ["c"],
        c: ["a", "d"],
        d: [],
        x: ["y"],
        y: ["x"],
        z: ["z"], // a file importing itself is not a cycle between files
      }),
    );

    expect(measures.moduleCount).toBe(7);
    expect(measures.importCycles).toEqual([
      ["a.ts", "b.ts", "c.ts"],
      ["x.ts", "y.ts"],
    ]);
  });

  it("ignores imports of packages and of files outside the project", () => {
    expect(analyzeImportGraph(graph({ a: ["react", "src/missing"], b: ["a"] })).importCycles).toEqual([]);
  });

  it("flags hubs importing more than HIGH_FAN_OUT modules, except facades that mostly re-export", () => {
    const leaves = Array.from({ length: HIGH_FAN_OUT + 1 }, (_, i) => `leaf${i}`);
    const edges: Record<string, string[]> = Object.fromEntries(leaves.map((leaf) => [leaf, []]));
    edges.hub = [...leaves, leaves[0]]; // repeated imports count once
    edges.index = leaves;

    expect(analyzeImportGraph(graph(edges, ["index"])).highFanOutModules).toEqual([
      { filePath: "hub.ts", fanOut: HIGH_FAN_OUT + 1 },
    ]);
  });
});

describe("Architecture base", () => {
  const architectureFor = (graphMeasures: Partial<ProjectMeasures>) =>
    diminishingPenaltyPolicy({
      measures: {
        largeFiles: [],
        complexFunctions: [],
        functionCount: 0,
        longFunctionCount: 0,
        testFileCount: 1,
        sourceFileCount: 10,
        testedSourceApproxPercent: 0,
        untestedCriticalPaths: [],
        secretHits: [],
        moduleCount: 100,
        importCycles: [],
        highFanOutModules: [],
        ...graphMeasures,
      },
      findings: [],
    }).categoryScores.architecture;

  it("is 100 for a graph without cycles or hubs", () => {
    expect(architectureFor({})).toBe(100);
  });

  it("loses 4 points per percent of modules in cycles and per percent of hubs", () => {
    const cycleOf = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`);
    expect(architectureFor({ importCycles: [cycleOf(3), cycleOf(2)] })).toBe(80);
    expect(architectureFor({ highFanOutModules: [{ filePath: "server.ts", fanOut: 91 }] })).toBe(96);
  });
});
