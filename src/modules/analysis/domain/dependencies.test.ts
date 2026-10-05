import { describe, expect, it } from "vitest";

import { dependencySeverity, parseNpmLockfile, type VulnerableDependency } from "./dependencies";
import { vulnerableDependencyRule, type ProjectMeasures } from "./rules";

const registry = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

// ADR-012: production dependencies from the lockfile, direct or transitive.
describe("parseNpmLockfile", () => {
  it("reads lockfile v2/v3: production only, direct when the project declares it", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { express: "^4" }, devDependencies: { vitest: "^1" } },
        "node_modules/express": { version: "4.17.1", resolved: registry("express", "4.17.1") },
        "node_modules/qs": { version: "6.7.0", resolved: registry("qs", "6.7.0") },
        "node_modules/express/node_modules/debug": { version: "2.6.9", resolved: registry("debug", "2.6.9") },
        "node_modules/vitest": { version: "1.0.0", dev: true },
        "node_modules/internal-lib": { version: "1.0.0", resolved: "https://npm.acme.internal/internal-lib-1.0.0.tgz" },
        "node_modules/local": { version: "0.0.0", link: true },
        "packages/app": { version: "1.0.0" },
      },
    };

    expect(parseNpmLockfile(JSON.stringify(lock))).toEqual([
      { name: "express", version: "4.17.1", direct: true },
      { name: "qs", version: "6.7.0", direct: false },
      { name: "debug", version: "2.6.9", direct: false },
    ]);
  });

  it("reads lockfile v1 with the manifest telling the direct dependencies", () => {
    const lock = {
      lockfileVersion: 1,
      dependencies: {
        express: { version: "4.16.0", resolved: registry("express", "4.16.0"), dependencies: { qs: { version: "6.5.1" } } },
        mocha: { version: "5.0.0", dev: true },
      },
    };
    const manifest = { dependencies: { express: "4.16.0" }, devDependencies: { mocha: "5" } };

    expect(parseNpmLockfile(JSON.stringify(lock), JSON.stringify(manifest))).toEqual([
      { name: "express", version: "4.16.0", direct: true },
      { name: "qs", version: "6.5.1", direct: false },
    ]);
  });

  it("returns null for text that is not a lockfile", () => {
    expect(parseNpmLockfile("not json")).toBeNull();
    expect(parseNpmLockfile(JSON.stringify({ name: "x" }))).toBeNull();
  });
});

describe("dependencySeverity", () => {
  const dependency = (direct: boolean, ...severities: VulnerableDependency["advisories"][number]["severity"][]) => ({
    name: "x",
    version: "1.0.0",
    direct,
    advisories: severities.map((severity, i) => ({ id: `GHSA-${i}`, severity })),
  });

  it("takes the worst advisory, one level lower for a transitive dependency", () => {
    expect(dependencySeverity(dependency(true, "medium", "critical"))).toBe("critical");
    expect(dependencySeverity(dependency(false, "medium", "critical"))).toBe("high");
    expect(dependencySeverity(dependency(false, "high"))).toBe("medium");
    expect(dependencySeverity(dependency(false, "low"))).toBe("low");
  });
});

describe("vulnerableDependencyRule", () => {
  const measures = (dependencyScan: ProjectMeasures["dependencyScan"]) => ({ dependencyScan }) as ProjectMeasures;

  it("reports one security finding per vulnerable dependency, the most severe first", () => {
    const findings = vulnerableDependencyRule.findings(
      measures({
        status: "scanned",
        dependencyCount: 10,
        vulnerable: [
          { name: "braces", version: "3.0.3", direct: false, advisories: [{ id: "GHSA-a", severity: "high" }] },
          { name: "express", version: "4.0.0", direct: true, advisories: [{ id: "GHSA-b", severity: "critical" }] },
        ],
      }),
    );

    expect(findings.map((f) => [f.title, f.severity, f.category])).toEqual([
      ["Vulnerable dependency express@4.0.0", "critical", "security"],
      ["Vulnerable dependency braces@3.0.3", "medium", "security"],
    ]);
  });

  it("reports nothing when the dependencies were not scanned", () => {
    for (const status of ["no-lockfile", "unavailable", "not-scanned"] as const) {
      expect(vulnerableDependencyRule.findings(measures({ status }))).toEqual([]);
    }
  });
});
