import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ProjectChat } from "@/components/projects/project-chat";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { getProjectSummary } from "@/lib/projects";
import { codeRemovedMessage } from "@/modules/projects";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProjectChatPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  // A malformed id would make Postgres throw; treat it as not found.
  const parsedId = z.uuid().safeParse(id);
  if (!parsedId.success) notFound();

  // Same cached, owner-scoped query as the layout.
  const project = await getProjectSummary(session.user.id, parsedId.data);
  if (!project) notFound();

  const ready = project.chunkCount > 0;

  return (
    // Flex all the way down so the chat can fill the rest of the screen.
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="ca-container flex min-h-0 flex-1 flex-col pt-10 pb-6">
        <div className="flex min-h-0 flex-1 flex-col">
          {ready ? (
            <ProjectChat projectId={project.id} projectName={project.name} />
          ) : (
            <section className="ca-panel flex flex-col items-start gap-4 p-8">
              <span className="ca-diamond text-(--ca-green-deep)" aria-hidden />
              <h2 className="ca-title text-3xl">
                <span className="ca-dim">Code knowledge</span> is not ready
              </h2>
              <p className="max-w-md text-sm leading-relaxed text-(--ca-muted)">
                {project.codeRemovedAt
                  ? codeRemovedMessage(project.source)
                  : "This project has no indexed chunks yet. Finish import / knowledge building before chatting."}
              </p>
              <Button
                variant="night"
                bar
                nativeButton={false}
                render={<Link href={`/projects/${project.id}`} />}
                className="mt-2 w-full sm:w-72"
              >
                Back to project
              </Button>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
