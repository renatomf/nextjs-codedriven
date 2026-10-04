import { describe, expect, it } from "vitest";

import {
  analysisStart,
  codeRemovedMessage,
  STALE_AFTER_SECONDS,
  type ProjectStatus,
} from "./project";

const NOW = new Date("2026-09-29T12:00:00Z");
const secondsBefore = (s: number) => new Date(NOW.getTime() - s * 1000);

function project(
  status: ProjectStatus,
  overrides: { fileCount?: number; updatedAt?: Date; codeRemovedAt?: Date | null } = {},
) {
  return { status, fileCount: 3, updatedAt: NOW, ...overrides };
}

describe("analysisStart", () => {
  it("never restarts a completed project", () => {
    expect(analysisStart(project("completed"), NOW)).toBe("completed");
  });

  it("leaves a live run alone", () => {
    expect(analysisStart(project("processing", { updatedAt: secondsBefore(60) }), NOW)).toBe(
      "running",
    );
  });

  it("lets a stale run restart once the window has passed", () => {
    const at = (s: number) => analysisStart(project("processing", { updatedAt: secondsBefore(s) }), NOW);
    expect(at(STALE_AFTER_SECONDS - 1)).toBe("running");
    expect(at(STALE_AFTER_SECONDS)).toBe("claimable");
  });

  describe("with the workflow run's status", () => {
    it("leaves a live run alone even past the stale window (a slow retry is not dead)", () => {
      const old = project("processing", { updatedAt: secondsBefore(STALE_AFTER_SECONDS * 3) });
      expect(analysisStart(old, NOW, "running")).toBe("running");
      expect(analysisStart(old, NOW, "pending")).toBe("running");
    });

    it.each(["completed", "failed", "cancelled"] as const)(
      "restarts at once when the run is %s but the project is still processing",
      (runStatus) => {
        const fresh = project("processing", { updatedAt: secondsBefore(5) });
        expect(analysisStart(fresh, NOW, runStatus)).toBe("claimable");
      },
    );

    it("does not let a run reopen a completed project", () => {
      expect(analysisStart(project("completed"), NOW, "failed")).toBe("completed");
    });
  });

  it("claims a queued project", () => {
    expect(analysisStart(project("queued"), NOW)).toBe("claimable");
  });

  it("retries a failed project only if its files were stored", () => {
    expect(analysisStart(project("failed", { fileCount: 3 }), NOW)).toBe("claimable");
    expect(analysisStart(project("failed", { fileCount: 0 }), NOW)).toBe("import-failed");
  });
});

describe("analysisStart after retention removed the code", () => {
  const removed = { codeRemovedAt: secondsBefore(60) };

  it("refuses to analyze stored files that are gone", () => {
    expect(analysisStart(project("failed", removed), NOW)).toBe("code-removed");
    expect(analysisStart(project("queued", removed), NOW)).toBe("code-removed");
  });

  it("refuses to restart a dead GitHub re-analysis that never downloaded the code", () => {
    const dead = project("processing", { ...removed, updatedAt: secondsBefore(5) });
    expect(analysisStart(dead, NOW, "failed")).toBe("code-removed");
  });

  it("still leaves a live run alone (it is downloading the code back)", () => {
    const live = project("processing", { ...removed, updatedAt: secondsBefore(5) });
    expect(analysisStart(live, NOW, "running")).toBe("running");
  });

  it("still reports a completed project as completed", () => {
    expect(analysisStart(project("completed", removed), NOW)).toBe("completed");
  });
});

describe("codeRemovedMessage", () => {
  it("tells how to get the code back for each source", () => {
    expect(codeRemovedMessage("github")).toMatch(/Analyze again.*GitHub/);
    expect(codeRemovedMessage("upload")).toMatch(/Upload the ZIP again/);
  });
});
