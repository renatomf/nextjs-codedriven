import Link from "next/link";
import { redirect } from "next/navigation";

import {
  ManageBillingButton,
  RefreshBillingButton,
  UpgradeToPremiumButton,
} from "@/components/billing/billing-buttons";
import { DisconnectGitHubButton } from "@/components/settings/disconnect-github-button";
import {
  SettingsToast,
  type SettingsNotice,
} from "@/components/settings/settings-toast";
import { Button, buttonVariants } from "@/components/ui/button";
import { connectGitHubAccount } from "@/lib/actions/github";
import { auth } from "@/lib/auth";
import { effectivePlanId } from "@/modules/billing";
import {
  getBillingSnapshot,
  getPlanCatalogWithPricing,
  syncCheckoutSessionForUser,
  syncCustomerSubscriptionsForUser,
} from "@/modules/billing/server";
import { getAccountSettings } from "@/modules/identity/server";

type PageProps = {
  searchParams: Promise<{
    github?: string;
    github_error?: string;
    billing?: string;
    session_id?: string;
  }>;
};

function formatLimit(n: number) {
  return Number.isFinite(n) ? String(n) : "∞";
}

export default async function SettingsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const plans = await getPlanCatalogWithPricing();
  const paid = plans.premium;

  // Activate plan after Checkout even if the webhook was missed (local/dev).
  // The session id is validated and must belong to the signed-in user.
  if (params.billing === "success") {
    if (params.session_id) {
      await syncCheckoutSessionForUser(session.user.id, params.session_id);
    } else {
      await syncCustomerSubscriptionsForUser(session.user.id);
    }
  }

  const user = await getAccountSettings(session.user.id);

  const billing = await getBillingSnapshot(session.user.id);
  const planId = effectivePlanId(billing.plan, billing.planStatus);
  const isPaid = planId === "premium";
  const current = plans[planId];
  // Only a boolean reaches the markup, never the (encrypted) token.
  const githubConnected = Boolean(user?.githubConnected);

  // Fixed messages only: the query values are user-controlled and never echoed.
  const notices: SettingsNotice[] = [];
  if (params.github === "connected") {
    notices.push({ type: "success", message: "GitHub connected successfully." });
  }
  if (params.github_error) {
    notices.push({ type: "error", message: "GitHub connection failed. Try again." });
  }
  if (params.billing === "success") {
    notices.push({
      type: "success",
      message: isPaid
        ? `Payment received. Your ${paid.label} plan is active.`
        : `Payment received. If the plan still shows ${plans.free.label}, click “Refresh plan from Stripe”.`,
    });
  }
  if (params.billing === "synced") {
    notices.push({ type: "success", message: "Plan synced from Stripe successfully." });
  }
  if (params.billing === "sync_failed") {
    notices.push({
      type: "error",
      message:
        "No active Stripe subscription found for this account yet. Wait a moment and try Refresh again, or confirm payment in the Stripe Dashboard.",
    });
  }
  if (params.billing === "canceled") {
    notices.push({
      type: "info",
      message: "Checkout was canceled. You can upgrade anytime.",
    });
  }

  return (
    <main className="landing-shell ca-guides flex-1">
      <div className="ca-container py-[clamp(3rem,8vw,6rem)]">
        <div className="mx-auto max-w-3xl">
          <header className="mb-10">
            <p className="ca-kicker">Account</p>
            <h1 className="ca-title mt-6 text-5xl sm:text-6xl">Settings</h1>
            <p className="ca-lead mt-5 max-w-md">
              Manage your profile, plan, and GitHub connection.
            </p>
          </header>

          <SettingsToast notices={notices} />

          <section className="ca-panel mb-5 space-y-4 p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="ca-title text-2xl">Billing</h2>
                <p className="mt-1 text-sm text-(--ca-muted)">
                  {plans.free.label} includes limited daily analyses.{" "}
                  {paid.label} unlocks higher limits.
                </p>
              </div>
              <span
                // Looks like the primary (Premium) / secondary (Free) buttons,
                // but it is only a label, so it gets no hover. The min width
                // keeps Free as wide as Premium.
                className={buttonVariants({
                  variant: isPaid ? "default" : "secondary",
                  size: "sm",
                  className: "pointer-events-none min-w-24",
                })}
              >
                {current.label}
                {billing.planStatus === "past_due" ? " · past due" : ""}
              </span>
            </div>

            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="border border-(--ca-line) px-3 py-2.5">
                <dt className="ca-mono text-xs text-(--ca-muted)">
                  Analyses today
                </dt>
                <dd className="mt-1 font-semibold tabular-nums">
                  {billing.analysesUsedToday}
                  <span className="font-normal text-(--ca-muted)">
                    {" "}
                    / {formatLimit(billing.limits.analysesPerDay)}
                  </span>
                </dd>
              </div>
              <div className="border border-(--ca-line) px-3 py-2.5">
                <dt className="ca-mono text-xs text-(--ca-muted)">Projects</dt>
                <dd className="mt-1 font-semibold tabular-nums">
                  {billing.projectCount}
                  <span className="font-normal text-(--ca-muted)">
                    {" "}
                    / {formatLimit(billing.limits.maxProjects)}
                  </span>
                </dd>
              </div>
              <div className="border border-(--ca-line) px-3 py-2.5 sm:col-span-2">
                <dt className="ca-mono text-xs text-(--ca-muted)">
                  Chat messages / hour
                </dt>
                <dd className="mt-1 font-semibold tabular-nums">
                  up to {billing.limits.chatPerHour}
                </dd>
              </div>
            </dl>

            <div className="flex flex-wrap items-center gap-2">
              {isPaid ? (
                <ManageBillingButton />
              ) : (
                <>
                  <UpgradeToPremiumButton
                    label={`Upgrade to ${paid.label}`}
                    planLabel={paid.label}
                    priceLabel={paid.priceLabel}
                    features={paid.features}
                  />
                  {billing.hasStripeCustomer ? <ManageBillingButton /> : null}
                </>
              )}
              {billing.hasStripeCustomer ? <RefreshBillingButton /> : null}
            </div>

            {!isPaid ? (
              <ul className="space-y-1.5 text-sm text-(--ca-muted)">
                <li>
                  {paid.label} · {paid.priceLabel}
                </li>
                {paid.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="ca-panel mb-5 space-y-3 p-6">
            <h2 className="ca-title text-2xl">Profile</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-(--ca-muted)">Name</dt>
                <dd className="font-medium">{user?.name ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-(--ca-muted)">Email</dt>
                <dd className="font-medium break-all">{user?.email ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-(--ca-muted)">Auth provider</dt>
                <dd className="font-medium capitalize">
                  {user?.authProvider ?? "—"}
                </dd>
              </div>
            </dl>
          </section>

          <section className="ca-panel space-y-4 p-6">
            <div>
              <h2 className="ca-title text-2xl">GitHub</h2>
              <p className="mt-1 text-sm text-(--ca-muted)">
                Required to select a repository. If you signed in with GitHub,
                the connection already appears here.
              </p>
            </div>
            {githubConnected ? (
              <>
                <p className="text-sm">
                  Connected as:{" "}
                  <span className="font-semibold text-(--ca-green-deep)">
                    {user?.githubUsername ?? "GitHub"}
                  </span>
                </p>
                <DisconnectGitHubButton />
              </>
            ) : (
              <>
                <p className="text-sm text-(--ca-muted)">
                  GitHub is not connected yet.
                </p>
                <form action={connectGitHubAccount}>
                  <Button type="submit">Connect GitHub</Button>
                </form>
              </>
            )}
            {/* Its own block: the Disconnect/Connect button above is inline,
                so the link would otherwise sit beside it. */}
            <div>
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link href="/dashboard" />}
                className="px-0"
              >
                ← Back to projects
              </Button>
            </div>
          </section>

          <p className="mt-6 text-sm text-(--ca-muted)">
            What is sent to the AI model and what is stored:{" "}
            <Link href="/data" className="underline underline-offset-4">
              Your data
            </Link>
            .
          </p>
        </div>
      </div>
    </main>
  );
}
