// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ segment: null as string | null }));

vi.mock("next/navigation", () => ({
  useSelectedLayoutSegment: () => mocks.segment,
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children?: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ProjectTabs, type ProjectTab } from "./project-tabs";

afterEach(cleanup);

const tabs = (alert: boolean): ProjectTab[] => [
  { label: "Overview", segment: null },
  { label: "Issues", segment: "issues", count: 7, alert },
];

function issuesCount() {
  return screen.getByRole("link", { name: /Issues/ }).querySelector("span")!;
}

// The hover turns other tabs green and the count dark. On the current tab
// nothing is painted, so a dark count vanished on the dark-mode background.
describe("ProjectTabs issue count", () => {
  it("keeps the count of the current tab as it is on hover", () => {
    mocks.segment = "issues";
    render(<ProjectTabs projectId="p" tabs={tabs(false)} />);

    expect(issuesCount().textContent).toBe("7");
    expect(issuesCount().className).not.toContain("group-hover/tab:text-[#050505]");
  });

  it("darkens the count over the green hover of another tab", () => {
    mocks.segment = null;
    render(<ProjectTabs projectId="p" tabs={tabs(false)} />);

    expect(issuesCount().className).toContain("group-hover/tab:text-[#050505]");
  });

  it("keeps critical issues red, border and number, current or not", () => {
    for (const segment of ["issues", null]) {
      mocks.segment = segment;
      render(<ProjectTabs projectId="p" tabs={tabs(true)} />);

      expect(issuesCount().className).toContain("ca-sev-critical");
      expect(issuesCount().className).toContain("border-(--ca-sev) text-(--ca-sev)");
      expect(issuesCount().className).not.toContain("group-hover/tab");
      cleanup();
    }
  });
});
