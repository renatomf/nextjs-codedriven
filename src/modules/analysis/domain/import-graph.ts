/** A source file in the import graph: what it imports, by module key. */
export type ImportNode = {
  filePath: string;
  /** Named like a module facade (index.ts / server.ts): followed by the test reach. */
  facade: boolean;
  /** Most of its imports are re-exports (a public API): many imports by design. */
  reExportsMostly: boolean;
  targets: string[];
};

/** What the import graph says about the structure (ADR-013). */
export type ImportGraphMeasures = {
  moduleCount: number;
  /** Groups of files that import each other in a cycle, largest first. */
  importCycles: string[][];
  /** Files importing more than `HIGH_FAN_OUT` project modules to use them (re-exporting facades left out). */
  highFanOutModules: Array<{ filePath: string; fanOut: number }>;
};

/**
 * Above this many project modules imported, a file is a hub that knows too
 * much (Juice Shop's server.ts imports 91; this repository's largest
 * non-facade import list is under 12). ADR-013.
 */
export const HIGH_FAN_OUT = 20;

/** Strongly connected components with more than one file (Tarjan, iterative). */
function cycles(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];

  for (const start of graph.keys()) {
    if (indices.has(start)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    indices.set(start, index);
    low.set(start, index);
    index += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const targets = graph.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next];
        frame.next += 1;
        if (!indices.has(target)) {
          indices.set(target, index);
          low.set(target, index);
          index += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, indices.get(target)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        if (component.length > 1) found.push(component);
      }
    }
  }
  return found;
}

/** Cycles and hubs of the project's own import graph (packages left out). */
export function analyzeImportGraph(nodes: Map<string, ImportNode>): ImportGraphMeasures {
  // Only edges between project files, each counted once.
  const graph = new Map<string, string[]>();
  for (const [key, node] of nodes) {
    graph.set(key, [...new Set(node.targets.filter((target) => target !== key && nodes.has(target)))]);
  }
  const path = (key: string) => nodes.get(key)!.filePath;

  return {
    moduleCount: nodes.size,
    importCycles: cycles(graph)
      .map((component) => component.map(path).sort())
      .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0])),
    highFanOutModules: [...graph]
      .filter(([key, targets]) => !nodes.get(key)!.reExportsMostly && targets.length > HIGH_FAN_OUT)
      .map(([key, targets]) => ({ filePath: path(key), fanOut: targets.length }))
      .sort((a, b) => b.fanOut - a.fanOut),
  };
}
