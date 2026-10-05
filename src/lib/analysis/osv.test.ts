import { afterEach, describe, expect, it, vi } from "vitest";

import { scanDependencies } from "@/lib/analysis/osv";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

// ADR-012: the advisories come from OSV; a failure never fails the report.
describe("scanDependencies", () => {
  it("returns each vulnerable dependency with its advisories' severities", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/querybatch")) return json({ results: [{ vulns: [{ id: "GHSA-1" }, { id: "GHSA-2" }] }, {}, { vulns: [{ id: "GHSA-3" }] }] });
      if (url.endsWith("/GHSA-1")) return json({ database_specific: { severity: "HIGH" } });
      if (url.endsWith("/GHSA-2")) return json({ database_specific: { severity: "MODERATE" } });
      return json({ withdrawn: "2024-01-01", database_specific: { severity: "CRITICAL" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scan = await scanDependencies([
      { name: "a", version: "1.0.0", direct: true },
      { name: "b", version: "1.0.0", direct: true },
      { name: "c", version: "1.0.0", direct: false },
    ]);

    expect(scan).toEqual({
      status: "scanned",
      dependencyCount: 3,
      vulnerable: [
        {
          name: "a",
          version: "1.0.0",
          direct: true,
          advisories: [
            { id: "GHSA-1", severity: "high" },
            { id: "GHSA-2", severity: "medium" },
          ],
        },
      ],
    });
    // Only public package names and versions are sent.
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      queries: ["a", "b", "c"].map((name) => ({ package: { name, ecosystem: "npm" }, version: "1.0.0" })),
    });
  });

  it("is unavailable, not a failure, when OSV does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 503)));

    await expect(scanDependencies([{ name: "a", version: "1.0.0", direct: true }])).resolves.toEqual({
      status: "unavailable",
    });
  });
});
