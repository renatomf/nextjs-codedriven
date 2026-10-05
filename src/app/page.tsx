import { HeroSilk } from "@/components/shared/hero-silk";
import { Button } from "@/components/ui/button";
import {
  Boxes,
  FlaskConical,
  Gauge,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";

const CODE_LINES = [
  { cls: "code-comment", text: "// AI Codebase Auditor" },
  { cls: "code-key", text: 'project.connect("github.com/you/app")' },
  { cls: "", text: "" },
  { cls: "code-ok", text: "→ reading files.............. done" },
  { cls: "code-ok", text: "→ detecting framework........ Next.js" },
  { cls: "code-ok", text: "→ creating code knowledge.... 148 chunks" },
  { cls: "code-ok", text: "→ running analysis........... ok" },
  { cls: "code-ok", text: "→ generating report.......... ready" },
  { cls: "", text: "" },
  { cls: "code-key", text: "health.score = 82" },
  { cls: "code-key", text: "issues.critical = 1" },
  { cls: "code-key", text: 'ask("Explain the auth flow")' },
  { cls: "", text: "" },
];

const FLOW = [
  {
    step: "01",
    title: "Connect a repository",
    text: "Link GitHub or upload a ZIP. We filter noise and keep the source that matters.",
  },
  {
    step: "02",
    title: "Build code knowledge",
    text: "Tree-sitter chunks your JS/TS, embeddings land in a vector store, ready for retrieval.",
  },
  {
    step: "03",
    title: "Ask, review, improve",
    text: "Chat with citations, scan a health report, and walk a priority roadmap of issues.",
  },
];

const OUTCOMES = [
  {
    title: "Health report",
    text: "Architecture, security, quality and testing scored clearly, plus performance findings.",
  },
  {
    title: "Grounded chat",
    text: "Answers cite real files and line ranges from your project, not generic advice.",
  },
  {
    title: "Issues & roadmap",
    text: "Filter findings by severity and category, then tackle what matters first.",
  },
];

const NAV_LINKS = [
  { href: "#why", label: "Why" },
  { href: "#how", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#demo", label: "Demo" },
];

const HEALTH_AREAS = [
  { icon: Boxes, label: "Architecture" },
  { icon: ShieldCheck, label: "Security" },
  { icon: Gauge, label: "Performance" },
  { icon: Sparkles, label: "Quality" },
  { icon: FlaskConical, label: "Testing" },
];

const ROADMAP_BARS = [12, 18, 26, 34, 42, 55, 68, 82, 100];

function CodePlane() {
  const lines = [...CODE_LINES, ...CODE_LINES, ...CODE_LINES];
  return (
    <div
      className="landing-code-plane landing-reveal landing-reveal-delay-3"
      aria-hidden
    >
      <div className="landing-code-bar">
        <span className="ca-dots">
          <i />
          <i />
          <i />
        </span>
        <span>project / payment-api</span>
      </div>
      <div className="landing-code-body">
        <pre>
          {lines.map((line, index) => (
            <span
              key={`${line.text}-${index}`}
              className={line.cls || undefined}
            >
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

function SectionHeader({
  kicker,
  title,
  lead,
}: {
  kicker: string;
  title: React.ReactNode;
  lead: React.ReactNode;
}) {
  return (
    <div className="ca-grid ca-scroll-reveal gap-y-6">
      <p className="ca-kicker pt-2">{kicker}</p>
      <h2 className="ca-title text-4xl sm:text-5xl md:col-span-2 lg:text-[4rem]">
        {title}
      </h2>
      <p className="ca-lead max-w-xs md:self-center">{lead}</p>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="landing-shell ca-home">
      <div className="ca-paper-grain" aria-hidden />
      <section id="top" className="ca-hero ca-dark ca-grain ca-guides">
        <HeroSilk className="ca-hero-silk" />
        <div className="ca-container relative z-40 pt-5">
          <header className="landing-reveal flex items-center justify-between gap-4 py-2">
            <a
              href="#top"
              className="shrink-0"
            >
              <Image
                src="/logo-transparent.png"
                alt="codedriven"
                width={906}
                height={143}
                priority
                className="h-5 w-auto invert hue-rotate-180 sm:h-6"
              />
            </a>
            <nav
              aria-label="Landing sections"
              className="hidden items-center gap-1 md:flex"
            >
              {NAV_LINKS.map((link) => (
                <a key={link.href} href={link.href} className="ca-nav-link">
                  {link.label}
                </a>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-2 text-sm sm:gap-6">
              <Link
                href="/login"
                className="hidden text-[0.8125rem] text-[#999] transition-colors hover:text-white sm:inline"
              >
                Sign in
              </Link>
              <Button
                variant="night"
                size="sm"
                bar
                nativeButton={false}
                render={<Link href="/register" />}
              >
                Get started
              </Button>
            </div>
          </header>
        </div>

        <div className="ca-container relative z-10 flex flex-1 flex-col pt-[clamp(3rem,9vh,6.5rem)]">
          <div className="ca-grid gap-y-10">
            <div className="md:col-span-2">
              <h1 className="ca-title landing-reveal landing-reveal-delay-1 text-[2.9rem] sm:text-6xl lg:text-[5.25rem]">
                <span className="ca-accent">AI Codebase</span> Auditor
              </h1>
              <p className="landing-reveal landing-reveal-delay-2 mt-6 text-xl font-semibold tracking-tight text-white sm:text-2xl">
                An AI senior developer for your repository.
              </p>
              <p className="ca-lead landing-reveal landing-reveal-delay-2 mt-4 max-w-md">
                Connect a project, get a health report, and ask precise
                questions grounded in your real code.
              </p>
            </div>

            <div className="landing-reveal landing-reveal-delay-3 flex flex-col gap-2 md:col-start-4">
              <Button bar nativeButton={false} render={<Link href="/login" />}>
                Analyze My Repository
              </Button>
              <Button
                variant="night"
                bar
                nativeButton={false}
                render={<a href="#demo" />}
              >
                View Demo
              </Button>
            </div>
          </div>

          <div className="ca-grid mt-auto pt-10">
            <div className="hidden md:col-span-2 md:col-start-3 md:block md:-translate-y-12">
              <CodePlane />
            </div>
          </div>
        </div>

        <div className="ca-display ca-wordmark ca-mask ca-mask-dark hidden! md:block! md:text-[9.2rem]!" aria-hidden>
          <span>Code Auditor</span>
        </div>
      </section>

      <section id="why" className="ca-section ca-guides pt-16!">
        <div className="ca-container">
          <div className="ca-grid ca-scroll-reveal gap-y-6">
            <p className="ca-kicker pt-2">Why it exists</p>
            <h2 className="ca-title text-4xl sm:text-5xl md:col-span-2 lg:text-[4rem]">
              <span className="ca-dim">Stop guessing</span> through unfamiliar
              code.
            </h2>
          </div>
          <div className="ca-grid ca-scroll-reveal mt-14 md:mt-20">
            <p className="text-2xl leading-[1.15] font-medium tracking-[-0.03em] text-balance sm:text-3xl md:col-span-2 md:col-start-2 lg:text-[2.5rem]">
              Static linters catch patterns. This product builds a searchable
              understanding of your codebase{" "}
              <span className="text-(--ca-muted)">
                — then reasons over it like a senior engineer sitting beside
                you.
              </span>
            </p>
          </div>
        </div>
      </section>

      <section id="how" className="ca-section ca-dark ca-guides">
        <div className="ca-container">
          <div className="ca-grid gap-y-14">
            <div className="ca-scroll-reveal md:sticky md:top-10 md:self-start">
              <p className="ca-kicker">How it works</p>
              <h2 className="ca-title mt-6 text-4xl sm:text-5xl">
                <span className="ca-accent">From repository</span> to insight
              </h2>
              <p className="ca-lead mt-6 max-w-xs">
                One clear path. No dashboard clutter in the first five minutes.
              </p>
            </div>

            <ol className="md:col-span-3 md:pr-0!">
              {FLOW.map((item) => (
                <li
                  key={item.step}
                  className="ca-row ca-scroll-reveal grid gap-4 py-10 sm:grid-cols-3 sm:py-14"
                >
                  <span className="ca-step ca-mono text-sm text-(--ca-soft)">
                    {item.step}
                  </span>
                  <h3 className="text-xl font-semibold tracking-tight text-[#cfcfcf]">
                    {item.title}
                  </h3>
                  <p className="text-base leading-relaxed text-(--ca-muted) sm:text-lg">
                    {item.text}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section id="features" className="ca-section ca-guides">
        <div className="ca-container">
          <SectionHeader
            kicker="Features"
            title={
              <>
                <span className="ca-dim">Built for</span> real review sessions
              </>
            }
            lead="Everything a course viewer expects to demo — and a developer wants to keep using."
          />

          <div className="ca-scroll-reveal mt-14 grid gap-2 md:mt-20 md:grid-cols-4">
            <article className="ca-tile ca-tile-dark flex flex-col md:col-span-2 md:min-h-128">
              <span className="ca-diamond text-(--ca-green)" aria-hidden />
              <h3 className="ca-title mt-4 text-3xl sm:text-4xl">
                <span className="ca-accent">Health</span> report
              </h3>
              <p className="mt-3 max-w-xs text-sm leading-relaxed text-[#999]">
                {OUTCOMES[0].text}
              </p>
              <div className="mt-auto flex items-end justify-between gap-6 pt-12">
                <ul className="space-y-3 text-sm font-medium" aria-hidden>
                  {HEALTH_AREAS.map(({ icon: Icon, label }) => (
                    <li key={label} className="flex items-center gap-2.5">
                      <Icon className="size-4 text-(--ca-green)" />
                      {label}
                    </li>
                  ))}
                </ul>
                <p
                  className="ca-title text-7xl sm:text-8xl"
                  aria-hidden
                >
                  82
                </p>
              </div>
            </article>

            <article className="ca-tile ca-tile-green min-h-104">
              <span className="ca-diamond" aria-hidden />
              <h3 className="mt-4 text-base font-semibold tracking-tight">
                {OUTCOMES[1].title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-black/60">
                {OUTCOMES[1].text}
              </p>
              <p className="ca-stack-word" aria-hidden>
                <span>proxy.ts</span>
                <span className="text-white! mb-1">auth.ts</span>
              </p>
            </article>

            <article className="ca-tile ca-tile-light flex min-h-104 flex-col">
              <h3 className="text-base font-semibold tracking-tight">
                {OUTCOMES[2].title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-(--ca-muted)">
                {OUTCOMES[2].text}
              </p>
              <div className="ca-bars mt-auto" aria-hidden>
                {ROADMAP_BARS.map((height, index) => (
                  <span
                    key={height}
                    style={{
                      height: `${height}%`,
                      opacity: 0.15 + (index / ROADMAP_BARS.length) * 0.85,
                    }}
                  />
                ))}
              </div>
            </article>
          </div>
        </div>
      </section>

      <section id="demo" className="ca-section ca-band ca-guides">
        <div className="ca-container">
          <SectionHeader
            kicker="Demo"
            title={
              <>
                <span className="ca-dim">A product</span> you can show on camera
              </>
            }
            lead="Progress, report, chat, and explorer — the full loop looks polished in a YouTube walkthrough."
          />

          <div className="ca-demo ca-scroll-reveal mt-14 grid gap-10 p-5 sm:p-8 md:mt-20 lg:grid-cols-2 lg:p-10">
            <div className="flex flex-col">
              <p className="ca-mono flex items-center gap-2.5 text-xs text-[#999]">
                <span className="ca-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
                project / payment-api
              </p>
              <p className="ca-title mt-10 text-8xl sm:text-9xl lg:mt-auto">
                82
                <span className="text-3xl tracking-tight text-white/35">
                  {" "}
                  / 100
                </span>
              </p>
              <p className="mt-5 max-w-sm text-sm leading-relaxed text-[#999]">
                Health score from architecture, security, quality and testing,
                plus performance findings.
              </p>
            </div>

            <div className="ca-mono space-y-2 text-xs sm:text-sm">
              <div className="ca-chat px-4 py-4">
                <p className="text-(--ca-green)">You</p>
                <p className="mt-2 text-white/90">
                  Explain the authentication flow.
                </p>
              </div>
              <div className="ca-chat px-4 py-4">
                <p className="text-(--ca-green)">AI Engineer</p>
                <p className="mt-2 leading-relaxed text-white/85">
                  Auth starts in{" "}
                  <span className="text-(--ca-green)">src/lib/auth.ts</span>.
                  Sessions are issued after credential checks, then the proxy
                  guards dashboard routes.
                </p>
                <p className="mt-3 text-white/40">
                  Sources: src/lib/auth.ts · src/proxy.ts
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="ca-section ca-guides border-t border-(--ca-line)">
        <div className="ca-container">
          <SectionHeader
            kicker="Get started"
            title={
              <>
                <span className="ca-dim">Build it. Demo it.</span> Ship the
                understanding.
              </>
            }
            lead="Free to try with daily analysis limits. Upgrade to Premium in Settings when you need more runs, projects, and chat capacity."
          />
          <div className="ca-grid ca-scroll-reveal mt-14 gap-y-2 md:mt-20 md:gap-x-3">
            <Button
              variant="secondary"
              bar
              nativeButton={false}
              render={<Link href="/login" />}
              className="md:col-start-2"
            >
              Analyze My Repository
            </Button>
            <Button bar nativeButton={false} render={<Link href="/register" />}>
              Create Account
            </Button>
          </div>
        </div>
      </section>

      <footer className="ca-footer ca-dark ca-guides">
        <p className="ca-display ca-footer-mark text-white/4!" aria-hidden>
          Auditor
        </p>
        <div className="ca-container relative pt-[clamp(6rem,14vw,13rem)] pb-8">
          <div className="ca-grid gap-y-12">
            <div className="md:col-span-2">
              <Image
                src="/logo-transparent.png"
                alt="codedriven"
                width={906}
                height={143}
                className="h-7 w-auto invert hue-rotate-180"
              />
              <p className="ca-mono mt-4 text-xs text-[#666]">
                Connect a project, get a health report.
              </p>
            </div>
            <nav
              aria-label="Footer"
              className="flex flex-col gap-2 md:col-span-2"
            >
              {NAV_LINKS.map((link) => (
                <a key={link.href} href={link.href} className="ca-footer-link">
                  {link.label}
                </a>
              ))}
              <Link href="/data" className="ca-footer-link">
                Your data
              </Link>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
