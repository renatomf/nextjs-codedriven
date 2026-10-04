import type { Metadata } from "next";
import Link from "next/link";

import { EXPLAIN_MAX_CHARS, RAG_TOP_K } from "@/lib/limits";
import { REVIEW_BUDGET } from "@/modules/analysis";
import { CODE_RETENTION_DAYS } from "@/modules/projects";

// Public page (outside the proxy matcher): what leaves the app, for how long
// it is kept and where (roadmap Phase 6). It only states what the code does;
// the numbers come from the same constants the code uses.
export const metadata: Metadata = {
  title: "Your data · codedriven",
  description: "What codedriven sends to the AI model, what it stores, where and for how long.",
};

const REVIEWED_ON = "2026-10-04";
const GROQ_POLICY_URL = "https://console.groq.com/docs/your-data";

const n = (value: number) => value.toLocaleString("en-US");

const SENT_TO_GROQ = [
  {
    feature: "Health report",
    sent: `Up to ${REVIEW_BUDGET.maxChunks} pieces of your code (${n(REVIEW_BUDGET.maxChars)} characters in total at most), plus the project name and framework. When the code has not changed since the last analysis, the earlier review is reused and nothing is sent.`,
  },
  {
    feature: "Chat",
    sent: `Your question, the conversation so far and the ${RAG_TOP_K} pieces of code most related to the question.`,
  },
  {
    feature: "Explain a file",
    sent: `Your question and the file, cut at ${n(EXPLAIN_MAX_CHARS)} characters.`,
  },
];

const STORED = [
  {
    data: "Account: name, email, password (bcrypt hash only), sign-in provider",
    where: "Neon Postgres",
    until: "The account is deleted",
  },
  {
    data: "Project files, code pieces and their vectors (embeddings)",
    where: "Neon Postgres",
    until: `You delete the project, or ${CODE_RETENTION_DAYS} days without use (opening the project or analyzing it counts as use). The project and its report stay; analyzing again brings the code back.`,
  },
  {
    data: "Reports and the AI review",
    where: "Neon Postgres",
    until: "You delete the project",
  },
  {
    data: "Uploaded ZIP file",
    where: "Neon Object Storage (private bucket)",
    until: "Deleted right after import; a leftover upload is removed by a daily cleanup",
  },
  {
    data: "GitHub access token (encrypted with AES-256-GCM)",
    where: "Neon Postgres",
    until: "You disconnect GitHub in Settings",
  },
  {
    data: "Report share links (only a hash of the link)",
    where: "Neon Postgres",
    until: "Revoked, expired or the project is deleted",
  },
  {
    data: "AI usage: feature, model, token counts, time and cost (never the content)",
    where: "Neon Postgres",
    until: "The account is deleted",
  },
  {
    data: "Plan and Stripe customer/subscription ids (no card data)",
    where: "Neon Postgres",
    until: "The account is deleted",
  },
];

const SERVICES = [
  {
    name: "Groq",
    role: "Runs the AI model (see above). Receives code only for the features listed.",
  },
  {
    name: "Neon",
    role: "Database and file storage, in AWS US East (N. Virginia).",
  },
  {
    name: "Vercel",
    role: "Hosts the app and runs the analysis in the US East region. Analysis jobs carry only ids, never code.",
  },
  {
    name: "Sentry",
    role: "Error and performance monitoring. Personal data and secrets are removed before anything is sent; no code is sent.",
  },
  {
    name: "Stripe",
    role: "Payments. Card details go straight to Stripe and never reach this app.",
  },
  {
    name: "GitHub",
    role: "Source of the repositories you choose to import.",
  },
  {
    name: "Hugging Face",
    role: "Only the embedding model is downloaded from it. Embeddings are computed on our own servers, so your code is not sent there.",
  },
];

export default function DataPage() {
  return (
    <main className="landing-shell ca-guides flex-1">
      <div className="ca-container py-[clamp(3rem,8vw,6rem)]">
        <div className="mx-auto max-w-3xl">
          <header className="mb-10">
            <p className="ca-kicker">Privacy</p>
            <h1 className="ca-title mt-6 text-5xl sm:text-6xl">Your data</h1>
            <p className="ca-lead mt-5 max-w-xl">
              What this app sends to the AI model, what it stores, where and
              for how long.
            </p>
            <p className="mt-3 font-mono text-xs text-(--ca-muted)">
              Last reviewed on {REVIEWED_ON}.
            </p>
          </header>

          <section aria-labelledby="groq" className="ca-panel mb-5 space-y-4 p-6">
            <h2 id="groq" className="ca-title text-2xl">
              What goes to the AI model
            </h2>
            <p className="text-sm text-(--ca-muted)">
              The AI features run on <strong>Groq</strong>. Only these features
              send code, and only when you use them:
            </p>
            <dl className="space-y-3 text-sm">
              {SENT_TO_GROQ.map((item) => (
                <div key={item.feature}>
                  <dt className="font-medium">{item.feature}</dt>
                  <dd className="text-(--ca-muted)">{item.sent}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm">
              <strong>Code is sent as it is.</strong> Secrets written in the
              code (API keys, passwords) are not removed before it is sent, so
              remove them before importing a project. Secrets are only hidden
              on public share links.
            </p>
            <p className="text-sm text-(--ca-muted)">
              Groq&apos;s policy: by default it does not keep the data of a
              request; it may keep it for up to 30 days when needed for
              reliability or abuse monitoring, in Google Cloud in the US. Read{" "}
              <a
                href={GROQ_POLICY_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                Groq&apos;s data policy
              </a>
              .
            </p>
          </section>

          <section aria-labelledby="stored" className="ca-panel mb-5 space-y-4 p-6">
            <h2 id="stored" className="ca-title text-2xl">
              What we store and for how long
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="font-mono text-xs text-(--ca-muted)">
                  <tr>
                    <th scope="col" className="py-2 pr-4 font-normal">Data</th>
                    <th scope="col" className="py-2 pr-4 font-normal">Where</th>
                    <th scope="col" className="py-2 font-normal">Kept until</th>
                  </tr>
                </thead>
                <tbody>
                  {STORED.map((row) => (
                    <tr key={row.data} className="border-t border-(--ca-line)">
                      <td className="py-2 pr-4">{row.data}</td>
                      <td className="py-2 pr-4 text-(--ca-muted)">{row.where}</td>
                      <td className="py-2 text-(--ca-muted)">{row.until}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="services" className="ca-panel mb-5 space-y-4 p-6">
            <h2 id="services" className="ca-title text-2xl">
              Services that handle your data
            </h2>
            <dl className="space-y-3 text-sm">
              {SERVICES.map((service) => (
                <div key={service.name}>
                  <dt className="font-medium">{service.name}</dt>
                  <dd className="text-(--ca-muted)">{service.role}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="delete" className="ca-panel space-y-4 p-6">
            <h2 id="delete" className="ca-title text-2xl">
              Deleting your data
            </h2>
            <ul className="list-disc space-y-2 pl-5 text-sm">
              <li>
                Deleting a project removes its files, code pieces, vectors,
                reports and share links at once.
              </li>
              <li>
                Code you stop using is removed on its own: {CODE_RETENTION_DAYS}{" "}
                days after you last opened or analyzed a project, a daily job
                deletes its files, code pieces and vectors.
              </li>
              <li>
                Disconnecting GitHub in{" "}
                <Link href="/settings" className="underline underline-offset-4">
                  Settings
                </Link>{" "}
                deletes the stored token.
              </li>
              <li>Deleting the whole account is not self-service yet.</li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
