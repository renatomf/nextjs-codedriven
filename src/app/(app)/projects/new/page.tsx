import Link from "next/link";
import { redirect } from "next/navigation";

import { RepoPicker } from "@/components/projects/repo-picker";
import { ZipUploadForm } from "@/components/projects/zip-upload-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { connectGitHubAccount } from "@/lib/actions/github";
import { auth } from "@/lib/auth";
import { GitHubError, listGitHubRepos } from "@/lib/github";
import { storageConfig } from "@/lib/storage/neon-storage";
import { getGitHubConnection } from "@/modules/identity/server";

export default async function NewProjectPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const user = await getGitHubConnection(userId);

  const githubConnected = Boolean(user?.githubAccessToken);
  let repos: Awaited<ReturnType<typeof listGitHubRepos>> = [];
  let repoError: string | null = null;

  if (user?.githubAccessToken) {
    try {
      repos = await listGitHubRepos({
        userId,
        encryptedToken: user.githubAccessToken,
      });
    } catch (error) {
      // Only our own GitHub messages are shown; anything else stays generic.
      repoError =
        error instanceof GitHubError
          ? error.message
          : "Failed to load GitHub repositories.";
    }
  }

  return (
    <main className="landing-shell ca-guides ca-guides-no-middle flex-1">
      <div className="ca-container py-[clamp(3rem,8vw,6rem)]">
        <div className="mx-auto max-w-3xl">
          <header className="mb-10">
            <p className="ca-kicker">New analysis</p>
            <h1 className="ca-title mt-6 text-5xl sm:text-6xl">
              <span className="ca-dim">Analyze a</span> repository
            </h1>
            <p className="ca-lead mt-5 max-w-md">
              Connect GitHub or upload a ZIP of your project.
            </p>
          </header>

          <Card>
            <CardHeader>
              <CardTitle>GitHub</CardTitle>
              <CardDescription>
                {githubConnected
                  ? `Connected as ${user?.githubUsername ?? "GitHub"}`
                  : "Connect GitHub first to select a repository."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!githubConnected ? (
                <form action={connectGitHubAccount}>
                  <Button type="submit">Connect GitHub</Button>
                </form>
              ) : repoError ? (
                <div className="space-y-3">
                  <p role="alert" className="text-sm text-destructive">
                    {repoError}
                  </p>
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={<Link href="/settings" />}
                  >
                    Open Settings
                  </Button>
                </div>
              ) : (
                <RepoPicker repos={repos} />
              )}
            </CardContent>
          </Card>

          <div className="my-6 flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="font-mono text-xs tracking-[0.04em] text-(--ca-muted) uppercase">
              or
            </span>
            <Separator className="flex-1" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Upload ZIP</CardTitle>
              <CardDescription>
                No GitHub connection required. Works for local projects.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Direct upload to object storage when configured (ADR-011). */}
              <ZipUploadForm direct={storageConfig() !== null} />
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
