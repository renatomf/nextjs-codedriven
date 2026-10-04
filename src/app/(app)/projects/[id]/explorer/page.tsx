import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { CodeExplorer } from "@/components/projects/code-explorer";
import { auth } from "@/lib/auth";
import {
  buildFileTree,
  listProjectFilePaths,
  readProjectFile,
} from "@/lib/files/explorer";
import { getProjectSummary } from "@/lib/projects";
import { codeRemovedMessage } from "@/modules/projects";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ file?: string }>;
};

export default async function ProjectExplorerPage({
  params,
  searchParams,
}: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const query = await searchParams;

  // A malformed id would make Postgres throw; treat it as not found.
  const parsedId = z.uuid().safeParse(id);
  if (!parsedId.success) notFound();

  // Same cached, owner-scoped query as the layout.
  const project = await getProjectSummary(session.user.id, parsedId.data);
  if (!project) notFound();

  let paths: string[] = [];
  try {
    paths = await listProjectFilePaths(session.user.id, project.id);
  } catch {
    paths = [];
  }

  const tree = buildFileTree(paths);
  // `?file=` comes from the URL: only a path from this project's list is used.
  const initialFile =
    query.file && paths.includes(query.file) ? query.file : (paths[0] ?? null);

  let initialContent: string | null = null;
  if (initialFile) {
    const file = await readProjectFile(session.user.id, project.id, initialFile);
    initialContent = file?.content ?? null;
  }

  return (
    <main className="flex-1">
      <div className="ca-container py-10">
        {paths.length === 0 ? (
          <div className="ca-panel p-8 text-center text-sm text-(--ca-muted)">
            {project.codeRemovedAt
              ? codeRemovedMessage(project.source)
              : "No extracted files are available for this project yet."}
          </div>
        ) : (
          <CodeExplorer
            projectId={project.id}
            tree={tree}
            initialFile={initialFile}
            initialContent={initialContent}
          />
        )}
      </div>
    </main>
  );
}
