import type { Advisory, Dependency, DependencyScan, IssueSeverity, VulnerableDependency } from "@/modules/analysis";
import { logger } from "@/shared/logger";

// OSV (osv.dev, Google, free, no key): the same database as the CI's
// osv-scanner. Only public npm package names and versions are sent (ADR-012).
const OSV_API = "https://api.osv.dev/v1";
const BATCH_SIZE = 1_000;
const DETAIL_CONCURRENCY = 8;
// The scan must not hold the report: past this, it is "unavailable".
const SCAN_TIMEOUT_MS = 20_000;

// GitHub advisories (most npm entries) carry a severity label.
const SEVERITY: Record<string, IssueSeverity> = {
  CRITICAL: "critical",
  HIGH: "high",
  MODERATE: "medium",
  LOW: "low",
};

async function postJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`OSV ${response.status}`);
  return (await response.json()) as T;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`OSV ${response.status}`);
  return (await response.json()) as T;
}

/** Severity of one advisory; null when it was withdrawn. */
async function advisory(id: string, signal: AbortSignal): Promise<Advisory | null> {
  const vuln = await getJson<{ withdrawn?: string; database_specific?: { severity?: string } }>(
    `${OSV_API}/vulns/${encodeURIComponent(id)}`,
    signal,
  );
  if (vuln.withdrawn) return null;
  // No label (some non-GitHub entries): counted, at the lowest weight.
  return { id, severity: SEVERITY[vuln.database_specific?.severity?.toUpperCase() ?? ""] ?? "low" };
}

/** Known advisories of the dependencies, or "unavailable" when OSV fails. */
export async function scanDependencies(dependencies: Dependency[]): Promise<DependencyScan> {
  const signal = AbortSignal.timeout(SCAN_TIMEOUT_MS);
  try {
    const ids: string[][] = [];
    for (let i = 0; i < dependencies.length; i += BATCH_SIZE) {
      const batch = dependencies.slice(i, i + BATCH_SIZE);
      const { results } = await postJson<{ results: Array<{ vulns?: Array<{ id: string }> }> }>(
        `${OSV_API}/querybatch`,
        { queries: batch.map((d) => ({ package: { name: d.name, ecosystem: "npm" }, version: d.version })) },
        signal,
      );
      ids.push(...results.map((result) => (result.vulns ?? []).map((v) => v.id)));
    }

    const unique = [...new Set(ids.flat())];
    const advisories = new Map<string, Advisory | null>();
    for (let i = 0; i < unique.length; i += DETAIL_CONCURRENCY) {
      const slice = unique.slice(i, i + DETAIL_CONCURRENCY);
      const found = await Promise.all(slice.map((id) => advisory(id, signal)));
      slice.forEach((id, j) => advisories.set(id, found[j]));
    }

    const vulnerable: VulnerableDependency[] = dependencies
      .map((dependency, i) => ({
        ...dependency,
        advisories: ids[i].map((id) => advisories.get(id)).filter((a): a is Advisory => !!a),
      }))
      .filter((dependency) => dependency.advisories.length > 0);
    return { status: "scanned", dependencyCount: dependencies.length, vulnerable };
  } catch (error) {
    logger.warn("osv.scan_failed", { err: error });
    return { status: "unavailable" };
  }
}
