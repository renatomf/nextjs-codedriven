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
import { auth } from "@/lib/auth";
import { GitHubError, type GitHubRepo } from "@/lib/github";
import { githubAppConfig, GitHubInstallationGoneError, listInstallationRepos } from "@/lib/github-app";
import { storageConfig } from "@/lib/storage/neon-storage";
import { forgetGitHubInstallation, listGitHubInstallations } from "@/modules/identity/server";

export default async function NewProjectPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const appEnabled = githubAppConfig() !== null;
  const installations = appEnabled ? await listGitHubInstallations(userId) : [];

  const githubConnected = installations.length > 0;
  const repos: GitHubRepo[] = [];
  let repoError: string | null = null;

  if (githubConnected) {
    try {
      // GitHub App (ADR-007): only the repositories the user chose.
      for (const installation of installations) {
        try {
          repos.push(...(await listInstallationRepos(installation.installationId)));
        } catch (error) {
          if (!(error instanceof GitHubInstallationGoneError)) throw error;
          // Uninstalled on GitHub: forget it; the others still list.
          await forgetGitHubInstallation(userId, installation.installationId);
        }
      }
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
                  ? `Read-only access to repositories of ${installations.map((i) => i.accountLogin).join(", ")}`
                  : "Connect GitHub first to select a repository."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!githubConnected ? (
                appEnabled ? (
                  <Button nativeButton={false} render={<a href="/api/github/app/install" />}>
                    Connect GitHub (read-only)
                  </Button>
                ) : (
                  <p className="text-sm text-(--ca-muted)">
                    GitHub repository access is not available here. Upload a
                    ZIP instead.
                  </p>
                )
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
                <div className="space-y-3">
                  <RepoPicker repos={repos} />
                  {/* GitHub lists only what the user chose: changing the
                      choice goes back through GitHub. */}
                  <a
                    href="/api/github/app/install"
                    className="text-xs text-(--ca-muted) underline underline-offset-4"
                  >
                    Missing a repository? Choose repositories on GitHub
                  </a>
                </div>
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
