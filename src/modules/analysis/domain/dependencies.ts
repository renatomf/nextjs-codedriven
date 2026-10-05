import type { IssueSeverity } from "./finding";

/** A production dependency resolved in the project's lockfile. */
export type Dependency = {
  name: string;
  version: string;
  /** Declared by the project itself (not pulled in by another package). */
  direct: boolean;
};

export type Advisory = { id: string; severity: IssueSeverity };

export type VulnerableDependency = Dependency & { advisories: Advisory[] };

/**
 * Known vulnerabilities of the project's dependencies (ADR-012):
 * - scanned: the lockfile was read and the advisories looked up;
 * - no-lockfile: the project has no npm lockfile, so versions are unknown;
 * - unavailable: the advisory database did not answer;
 * - not-scanned: the analysis did not look (no score effect).
 */
export type DependencyScan =
  | { status: "scanned"; dependencyCount: number; vulnerable: VulnerableDependency[] }
  | { status: "no-lockfile" | "unavailable" | "not-scanned" };

// Only packages from the public registry are looked up: a private or git
// dependency's name would tell a third party about internal code (ADR-012).
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

type LockPackage = {
  version?: string;
  name?: string;
  resolved?: string;
  dev?: boolean;
  link?: boolean;
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};

const isPublic = (meta: LockPackage) => !meta.resolved || meta.resolved.startsWith(PUBLIC_REGISTRY);

/**
 * Production dependencies of an npm lockfile (v2/v3 `packages`; v1
 * `dependencies`, where `manifest` tells the direct ones). Dev dependencies
 * are left out: they do not ship. Null when the text is not a lockfile.
 */
export function parseNpmLockfile(lockfileText: string, manifestText?: string): Dependency[] | null {
  let lock: { packages?: Record<string, LockPackage>; dependencies?: Record<string, LockPackage> };
  try {
    lock = JSON.parse(lockfileText);
  } catch {
    return null;
  }
  if (!lock || typeof lock !== "object") return null;

  const found = new Map<string, Dependency>();
  const add = (name: string, version: string, direct: boolean) => {
    const key = `${name}@${version}`;
    const seen = found.get(key);
    found.set(key, { name, version, direct: direct || (seen?.direct ?? false) });
  };

  if (lock.packages && typeof lock.packages === "object") {
    const root = lock.packages[""] ?? {};
    const declared = new Set(Object.keys({ ...root.dependencies, ...root.optionalDependencies }));
    for (const [path, meta] of Object.entries(lock.packages)) {
      // "" is the project; paths without node_modules are workspace packages.
      if (!path.includes("node_modules/") || !meta?.version || meta.link || meta.dev || !isPublic(meta)) continue;
      const name = meta.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      add(name, meta.version, path === `node_modules/${name}` && declared.has(name));
    }
    return [...found.values()];
  }

  if (lock.dependencies && typeof lock.dependencies === "object") {
    let declared = new Set<string>();
    try {
      const manifest = manifestText ? JSON.parse(manifestText) : {};
      declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }));
    } catch {
      // Without a readable manifest every dependency counts as transitive.
    }
    const walk = (deps: Record<string, LockPackage>, topLevel: boolean) => {
      for (const [name, meta] of Object.entries(deps)) {
        if (!meta?.version || meta.dev || !isPublic(meta)) continue;
        add(name, meta.version, topLevel && declared.has(name));
        if (meta.dependencies) walk(meta.dependencies as Record<string, LockPackage>, false);
      }
    };
    walk(lock.dependencies, true);
    return [...found.values()];
  }

  return null;
}

const SEVERITY_STEPS: IssueSeverity[] = ["critical", "high", "medium", "low"];

/**
 * How much a vulnerable dependency weighs: its worst advisory, one level
 * lower when the dependency is transitive (often not reachable from the
 * project's code; ADR-012).
 */
export function dependencySeverity(dependency: VulnerableDependency): IssueSeverity {
  const worst = Math.min(...dependency.advisories.map((a) => SEVERITY_STEPS.indexOf(a.severity)));
  const step = dependency.direct ? worst : Math.min(worst + 1, SEVERITY_STEPS.length - 1);
  return SEVERITY_STEPS[step] ?? "low";
}
