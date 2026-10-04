import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import { ProjectStatusBadge } from "@/components/shared/project-status-badge";
import { ProjectTabs, type ProjectTab } from "@/components/shared/project-tabs";
import { auth } from "@/lib/auth";
import { getProjectSummary } from "@/lib/projects";
import { touchProject } from "@/modules/projects/server";
import { logger } from "@/shared/logger";

// Shared by every project page. Layouts are not re-rendered when switching
// tabs (only the page segment is), so the header and tabs stay put. Each page
// still checks the session and ownership on its own.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const parsedId = z.uuid().safeParse(id);
  if (!parsedId.success) notFound();

  const project = await getProjectSummary(session.user.id, parsedId.data);
  if (!project) notFound();

  // Opening the project counts as use (retention): written after the
  // response, at most once a day, and never at the cost of the page.
  const userId = session.user.id;
  after(() =>
    touchProject(userId, project.id).catch((error: unknown) => {
      logger.warn("project.touch_failed", { err: error, projectId: project.id });
    }),
  );

  const inFlight = project.status === "processing" || project.status === "queued";
  const reportReady = project.healthScore !== null;
  const reportLock = reportReady
    ? undefined
    : inFlight
      ? "analyzing"
      : "after report";

  const tabs: ProjectTab[] = [
    { label: "Overview", segment: null },
    { label: "Report", segment: "report", lockedReason: reportLock },
    {
      label: "Issues",
      segment: "issues",
      lockedReason: reportLock,
      count: reportReady ? project.issueCount : undefined,
      alert: project.criticalCount > 0,
    },
    { label: "Explorer", segment: "explorer" },
    {
      label: "AI Chat",
      segment: "chat",
      lockedReason:
        project.chunkCount > 0
          ? undefined
          : project.codeRemovedAt
            ? "code removed"
            : "indexing",
    },
  ];

  return (
    <div className="landing-shell ca-guides flex min-h-0 flex-1 flex-col">
      <div className="relative">
        {/* Hides the inner guide lines behind the title and the tabs: the
            first two grid columns, from just after the left edge line through
            the middle line (same math as `.ca-guides`, whose lines sit inside
            its 1px borders). The +3px covers the middle line fully even when
            it lands on a fractional pixel. The other lines stay. */}
        <div
          aria-hidden
          className="absolute inset-y-0 left-[calc(var(--ca-gutter)+1px)] w-[calc((100%-2*var(--ca-gutter)-2px)/2+3px)] bg-(--ca-paper)"
        />
        <header className="ca-container pt-[clamp(2.5rem,6vw,4.5rem)] pb-6">
          <p className="ca-kicker">Project</p>
          <h1 className="ca-title mt-6 text-4xl wrap-break-word sm:text-5xl">
            {project.name}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <ProjectStatusBadge status={project.status} />
            <span className="ca-mono text-[0.72rem] text-(--ca-soft)">
              {project.source === "github" ? "GitHub" : "ZIP"} ·{" "}
              {project.framework ?? "Unknown framework"} · {project.fileCount}{" "}
              files
            </span>
            {inFlight ? (
              <Link
                href={`/projects/${project.id}/progress`}
                className="text-xs font-medium text-(--ca-ink) underline-offset-4 hover:underline"
              >
                View progress
              </Link>
            ) : null}
          </div>
        </header>

        <ProjectTabs projectId={project.id} tabs={tabs} />
      </div>

      {children}
    </div>
  );
}
