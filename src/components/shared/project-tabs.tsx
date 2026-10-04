"use client";

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";

import { cn } from "@/lib/utils";

export type ProjectTab = {
  label: string;
  /** Route folder under /projects/[id]; null is the overview. */
  segment: string | null;
  /** Why the tab is not available yet. Locked tabs stay in place, dimmed. */
  lockedReason?: string;
  count?: number;
  /** Highlights the count in red (there are issues to look at). */
  alert?: boolean;
};

const TAB_CLASS =
  "relative inline-flex h-10.5 shrink-0 items-center gap-2 px-3.5 font-mono text-[0.72rem] tracking-[0.05em] uppercase outline-none";

export function ProjectTabs({
  projectId,
  tabs,
}: {
  projectId: string;
  tabs: ProjectTab[];
}) {
  const active = useSelectedLayoutSegment();
  const base = `/projects/${projectId}`;

  return (
    // Full-width bottom rule, but no background of its own. `relative` keeps
    // the rule above the layout's panel that hides the guide lines.
    <div className="relative border-b border-(--ca-line)">
      <div className="ca-container">
        <nav
          aria-label="Project sections"
          // Scrolls sideways on narrow screens; the bar itself is hidden. The
          // active underline sits inside the tab, so nothing overflows
          // vertically. `ml-px` keeps the left edge guide line visible.
          className="ml-px flex w-fit max-w-full gap-0.5 overflow-x-auto overflow-y-hidden bg-(--ca-paper) scrollbar-none [&::-webkit-scrollbar]:hidden"
        >
        {tabs.map((tab) => {
          const current = active === tab.segment;
          const count =
            tab.count !== undefined ? (
              <span
                className={cn(
                  "border px-1.5 py-px text-[0.66rem] tabular-nums",
                  tab.alert
                    ? "ca-sev-critical border-(--ca-sev) text-(--ca-sev)"
                    : "border-(--ca-line) bg-(--ca-card) text-(--ca-muted)",
                  // Dark text only over the green hover of another tab: the
                  // current tab is not painted, so in dark mode the count
                  // would vanish on its own background.
                  !tab.alert &&
                    !current &&
                    "group-hover/tab:border-[#050505]/25 group-hover/tab:bg-transparent group-hover/tab:text-[#050505]",
                )}
              >
                {tab.count}
              </span>
            ) : null;

          if (tab.lockedReason) {
            return (
              <span
                key={tab.label}
                aria-disabled="true"
                title={tab.lockedReason}
                className={cn(TAB_CLASS, "cursor-not-allowed text-(--ca-soft) opacity-55")}
              >
                {tab.label}
                <span className="font-sans text-[0.66rem] tracking-normal normal-case">
                  · {tab.lockedReason}
                </span>
              </span>
            );
          }

          return (
            <Link
              key={tab.label}
              href={tab.segment ? `${base}/${tab.segment}` : base}
              aria-current={current ? "page" : undefined}
              className={cn(
                TAB_CLASS,
                "group/tab transition-colors",
                current
                  ? "text-(--ca-ink) after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-(--ca-green-deep)"
                  : "text-(--ca-muted) hover:bg-(--ca-green) hover:text-[#050505] focus-visible:bg-(--ca-green) focus-visible:text-[#050505]",
              )}
            >
              {tab.label}
              {count}
            </Link>
          );
        })}
        </nav>
      </div>
    </div>
  );
}
