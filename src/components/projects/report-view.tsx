import {
  Code2,
  FlaskConical,
  Gauge,
  Info,
  Layers,
  Shield,
} from "lucide-react";
import Link from "next/link";
import type { ComponentType } from "react";

import { IssueCard } from "@/components/projects/issue-card";
import { Button } from "@/components/ui/button";
import {
  CATEGORY_LABELS,
  SEVERITY_LABELS,
  sortIssues,
} from "@/lib/analysis/issue-utils";
import type {
  AiReviewSkip,
  CategoryScores,
  CategorySummaries,
  IssueCategory,
  ReportIssue,
} from "@/lib/analysis/report-types";
import {
  CATEGORY_ACCENT,
  scoreBarClass,
  scoreChipClass,
  scoreLabel,
  scoreTextClass,
  scoreTone,
} from "@/lib/analysis/score-ui";
import { cn } from "@/lib/utils";

const CATEGORY_ICONS: Record<
  IssueCategory,
  ComponentType<{ className?: string }>
> = {
  architecture: Layers,
  security: Shield,
  performance: Gauge,
  codeQuality: Code2,
  testing: FlaskConical,
};

// TD-50 item 4: a category without a measured signal (Performance) keeps its
// findings and summary but has no score.
const NOT_SCORED = "Not scored";

/**
 * The health report body: score, category summaries, roadmap and top
 * issues, one server-renderable section each. Used by the owner's report
 * page and by the public shared report. Without `projectId` (public),
 * nothing links to the project's private pages.
 */
export function ReportView({
  healthScore,
  categoryScores,
  summaries,
  issues: unsortedIssues,
  projectId,
  aiReviewSkipped,
}: {
  healthScore: number;
  categoryScores: Partial<CategoryScores> | null;
  summaries?: Partial<CategorySummaries>;
  issues: ReportIssue[];
  projectId?: string;
  /** Set when the report came out without the AI review. */
  aiReviewSkipped?: AiReviewSkip;
}) {
  const issues = sortIssues(unsortedIssues);

  return (
    <>
      {aiReviewSkipped ? (
        <AiReviewNotice reason={aiReviewSkipped} canRerun={Boolean(projectId)} />
      ) : null}
      <ScoreOverview healthScore={healthScore} categoryScores={categoryScores} />
      <CategoryCards categoryScores={categoryScores} summaries={summaries} />
      <RoadmapList roadmap={issues.slice(0, 8)} />
      <TopIssues issues={issues} projectId={projectId} />
    </>
  );
}

const AI_REVIEW_SKIPPED: Record<AiReviewSkip, string> = {
  disabled: "The AI review is turned off for now.",
  budget: "Today's AI budget for this account is used up.",
  unavailable: "The AI provider did not respond.",
};

/**
 * Graceful degradation (roadmap Phase 5): the report is real, but its score
 * and findings come from the automated checks only. Said up front, so the
 * score is not read as the full review.
 */
function AiReviewNotice({ reason, canRerun }: { reason: AiReviewSkip; canRerun: boolean }) {
  return (
    <section
      role="status"
      className="ca-panel flex gap-3 border-l-2 border-l-(--ca-ink) px-4 py-3"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-(--ca-muted)" aria-hidden />
      <div className="min-w-0">
        <p className="font-mono text-[0.7rem] tracking-[0.04em] uppercase">
          Automated checks only
        </p>
        <p className="mt-1 text-sm leading-relaxed text-(--ca-muted)">
          {AI_REVIEW_SKIPPED[reason]} This score and its findings come from the
          automated checks alone, without the AI review.
          {canRerun ? " Run the analysis again later for the full review." : ""}
        </p>
      </div>
    </section>
  );
}

function ScoreOverview({
  healthScore,
  categoryScores,
}: {
  healthScore: number;
  categoryScores: Partial<CategoryScores> | null;
}) {
  const overallTone = scoreTone(healthScore);

  return (
    <section className="ca-panel p-6 sm:p-8">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="ca-kicker">Project health</p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <p
              className={cn(
                "ca-title text-7xl tabular-nums sm:text-8xl",
                scoreTextClass(overallTone),
              )}
            >
              {healthScore}
            </p>
            <span className="pb-2 text-lg text-(--ca-soft)">/ 100</span>
            <span
              className={cn(
                "mb-2 inline-flex border px-2.5 py-1 font-mono text-[0.68rem] tracking-[0.04em] uppercase",
                scoreChipClass(overallTone),
              )}
            >
              {scoreLabel(overallTone)}
            </span>
          </div>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-(--ca-muted)">
            Average of the scored categories. Performance has findings but
            no score yet: nothing measures it reliably. Use the roadmap below
            to decide what to fix first.
          </p>
          <div className="mt-5 h-1.5 max-w-md overflow-hidden bg-(--ca-line)">
            <div
              className={cn(
                "h-full transition-all",
                scoreBarClass(overallTone),
              )}
              style={{
                width: `${Math.min(100, Math.max(0, healthScore))}%`,
              }}
            />
          </div>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:max-w-xl">
          {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map(
            (key) => {
              const score = categoryScores?.[key];
              const tone = scoreTone(score);
              const Icon = CATEGORY_ICONS[key];
              return (
                <div
                  key={key}
                  className={cn(
                    "border p-3",
                    CATEGORY_ACCENT[key].soft,
                  )}
                >
                  <div className="flex items-center gap-1.5 text-(--ca-muted)">
                    <Icon className="size-3.5" aria-hidden />
                    <p className="font-mono text-[0.68rem] tracking-[0.04em] uppercase">
                      {CATEGORY_LABELS[key]}
                    </p>
                  </div>
                  <p
                    className={cn(
                      "mt-2 text-2xl font-bold tabular-nums",
                      scoreTextClass(tone),
                    )}
                  >
                    {score ?? <span className="text-sm font-normal text-(--ca-muted)">{NOT_SCORED}</span>}
                  </p>
                  <div className="mt-2 h-1 overflow-hidden bg-(--ca-line)">
                    <div
                      className={cn("h-full", scoreBarClass(tone))}
                      style={{
                        width: `${Math.min(100, Math.max(0, score ?? 0))}%`,
                        opacity: score == null ? 0.25 : 1,
                      }}
                    />
                  </div>
                </div>
              );
            },
          )}
        </div>
      </div>
    </section>
  );
}

function CategoryCards({
  categoryScores,
  summaries,
}: {
  categoryScores: Partial<CategoryScores> | null;
  summaries?: Partial<CategorySummaries>;
}) {
  return (
    <section className="grid gap-4">
      {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((key) => {
        const score = categoryScores?.[key];
        const tone = scoreTone(score);
        const Icon = CATEGORY_ICONS[key];
        return (
          <article
            key={key}
            className="ca-panel p-0"
          >
            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:gap-6">
              <div
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center border",
                  CATEGORY_ACCENT[key].soft,
                )}
              >
                <Icon
                  className="size-5 text-foreground/80"
                  aria-hidden
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="ca-title text-xl">
                    {CATEGORY_LABELS[key]}
                  </h2>
                  <span
                    className={cn(
                      "inline-flex border px-2 py-0.5 font-mono text-xs tabular-nums",
                      scoreChipClass(tone),
                    )}
                  >
                    {score == null ? NOT_SCORED : `${score}/100`}
                  </span>
                </div>
                <p className="mt-2 text-[15px] leading-relaxed text-foreground/80">
                  {summaries?.[key] ?? "No summary available."}
                </p>
              </div>
            </div>
            <div
              className={cn("h-0.5 w-full", CATEGORY_ACCENT[key].bar)}
              style={{
                opacity: 0.55,
              }}
            />
          </article>
        );
      })}
    </section>
  );
}

function RoadmapList({ roadmap }: { roadmap: ReportIssue[] }) {
  return (
    <section className="ca-panel p-5 sm:p-6">
      <p className="ca-kicker">Next steps</p>
      <h2 className="ca-title mt-4 text-3xl">
        <span className="ca-dim">Improvement</span> roadmap
      </h2>
      <p className="mt-1 text-sm text-(--ca-muted)">
        Priority-ordered recommendations. No time estimates.
      </p>
      {roadmap.length === 0 ? (
        <p className="mt-5 text-sm text-(--ca-muted)">
          No prioritized issues were generated.
        </p>
      ) : (
        <ol className="mt-5 space-y-3">
          {roadmap.map((issue, index) => (
            <li
              key={`${issue.title}-${index}`}
              className="flex gap-3 rounded-[0.375rem] border border-(--ca-line) p-3.5"
            >
              <span className="flex size-7 shrink-0 items-center justify-center bg-(--ca-green) font-mono text-xs font-bold text-[#050505]">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="font-medium tracking-tight">
                  {issue.title}
                </p>
                <p className="mt-1 text-xs text-(--ca-muted)">
                  {CATEGORY_LABELS[issue.category]} ·{" "}
                  {SEVERITY_LABELS[issue.severity]}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TopIssues({ issues, projectId }: { issues: ReportIssue[]; projectId?: string }) {
  const previewIssues = issues.slice(0, 5);

  return (
    <section className="ca-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="ca-kicker">Findings</p>
          <h2 className="ca-title mt-4 text-3xl">
            <span className="ca-dim">Top</span> issues
          </h2>
          <p className="mt-1 text-sm text-(--ca-muted)">
            {issues.length} potential issue
            {issues.length === 1 ? "" : "s"} across all categories.
          </p>
        </div>
        {projectId ? (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={`/projects/${projectId}/issues`} />}
            mint
          >
            View all
          </Button>
        ) : null}
      </div>

      <div className="mt-5 space-y-3">
        {previewIssues.length === 0 ? (
          <p className="text-sm text-(--ca-muted)">
            No issues were flagged.
          </p>
        ) : (
          previewIssues.map((issue, index) => (
            <IssueCard
              key={`${issue.title}-${index}`}
              issue={issue}
              projectId={projectId}
            />
          ))
        )}
      </div>
    </section>
  );
}
