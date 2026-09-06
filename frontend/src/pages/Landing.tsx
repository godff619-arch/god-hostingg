// The public homepage.
//
// `godhosting.cyou/` used to redirect a first-time visitor straight into
// `/sign-in`: the product had no front door, so nothing said what it does, what
// it costs, or whether signups were even open. This page is that front door, and
// `/` is now public — the dashboard lives at `/projects` (see app/router.tsx and
// the redirect rules in components/AuthProvider.tsx).
//
// Two rules shaped what is on it:
//
//  • Nothing invented. Prices and limits are the `Plan` rows behind Admin → Plans,
//    the feature list is filtered by the live feature flags, and the call to
//    action follows `registration_enabled` / `setup_complete`. A homepage that
//    advertises a closed signup or a capability the operator switched off is a
//    dead button, which the brief rules out.
//  • The product's own design language. Same light plane, hairline borders, Inter,
//    brand blue, flat surfaces — no gradients, no glass, no neon (§28). Motion is
//    a fade-and-lift on scroll plus press feedback, and all of it stops under
//    `prefers-reduced-motion`.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Boxes,
  Database,
  FileArchive,
  FileCode2,
  Github,
  Globe,
  KeyRound,
  Layers,
  Link2,
  Lock,
  RefreshCw,
  ScrollText,
  ServerCog,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/components/AuthProvider";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { PricingSection } from "@/components/marketing/PricingSection";
import { FaqSection, type FaqItem } from "@/components/marketing/FaqSection";
import { Reveal } from "@/components/marketing/Reveal";
import { fetchLanding, type LandingData } from "@/lib/landing";
import { APP_NAME } from "@/lib/brand";

/**
 * The four stages the deployment engine actually reports, in order. Shown as a
 * diagram rather than a mock console: a fake log pane implies output that is not
 * really there, and this is the same pipeline routes/deployments.ts walks.
 */
const PIPELINE = [
  {
    icon: Github,
    title: "Fetch the source",
    detail: "Clone the branch, or unpack the ZIP you uploaded.",
  },
  {
    icon: Boxes,
    title: "Build an image",
    detail: "Your Dockerfile if there is one — Railpack detects the stack if there is not.",
  },
  {
    icon: ServerCog,
    title: "Start the container",
    detail: "Health-check the port, keep the previous version until the new one answers.",
  },
  {
    icon: Globe,
    title: "Publish it",
    detail: "Attach the domain, issue the certificate, stream the log until it is live.",
  },
];

/**
 * Feature cards. `flag` names a key from lib/featureFlags.ts — a card whose flag
 * the operator has switched off is not rendered, so the homepage can never
 * advertise something the API would refuse.
 */
const FEATURES: { flag?: string; icon: typeof Boxes; title: string; body: string }[] = [
  {
    flag: "git_deploy",
    icon: Github,
    title: "Deploy from GitHub",
    body: "Connect a repository, pick a branch, and every push can rebuild and roll forward.",
  },
  {
    flag: "zip_upload",
    icon: FileArchive,
    title: "Or just upload a ZIP",
    body: "No repository needed. Drop an archive and it is extracted, built and run the same way.",
  },
  {
    flag: "databases",
    icon: Database,
    title: "Managed databases",
    body: "Postgres, MySQL, MongoDB and Redis provisioned next to your app with credentials wired in.",
  },
  {
    flag: "custom_domains",
    icon: Globe,
    title: "Domains with automatic HTTPS",
    body: "Point a hostname at your app and the certificate is issued and renewed for you.",
  },
  {
    icon: ScrollText,
    title: "Live build and runtime logs",
    body: "The deploy log streams as it happens, and container logs stay searchable afterwards.",
  },
  {
    flag: "web_terminal",
    icon: TerminalSquare,
    title: "Shell into a container",
    body: "A real terminal in the browser when you need to look inside a running service.",
  },
  {
    icon: Layers,
    title: "Environments per project",
    body: "Production and preview share a project but keep their own variables and services.",
  },
  {
    flag: "env_groups",
    icon: KeyRound,
    title: "Shared variable groups",
    body: "Define configuration once and link it to every service that needs it.",
  },
  {
    flag: "private_links",
    icon: Link2,
    title: "Private service networking",
    body: "Services talk over an internal network, so a database never needs a public port.",
  },
  {
    flag: "blueprints",
    icon: FileCode2,
    title: "Infrastructure as code",
    body: "Describe a whole stack in one blueprint and apply it in a single step.",
  },
  {
    icon: Users,
    title: "Workspaces and roles",
    body: "Invite a team, scope who can deploy, and keep every project inside its workspace.",
  },
  {
    flag: "backups",
    icon: RefreshCw,
    title: "Backups and rollback",
    body: "Snapshot the platform, and roll a service back to the image that was working.",
  },
];

const FAQ: FaqItem[] = [
  {
    q: "What do I need in my repository?",
    a: "A Dockerfile if you have one — it is used as-is. If you do not, the build analyses your project with Railpack and produces an image for you, so a plain Node, Python, Go, PHP, Ruby or static site works without you writing any Docker config.",
  },
  {
    q: "How do I get a URL for my app?",
    a: "Every service gets a host port immediately, and an operator can set a base domain so each app is published as its own subdomain. Add your own hostname on the service's Domains tab and the certificate is requested and renewed automatically.",
  },
  {
    q: "Where does my code actually run?",
    a: "On this server, as Docker containers. Nothing is sent to a third-party build service: the image is built here, the container runs here, and the data volumes stay on this host.",
  },
  {
    q: "Can I use it with a team?",
    a: "Yes. A workspace holds projects and members, roles decide who can deploy or change billing, and every sensitive action is written to an audit log with who did it and why.",
  },
];

/**
 * §52's loading state. A shaped placeholder rather than a blank plane, so the
 * first paint already has the page's geometry and nothing jumps when the plan
 * catalogue lands.
 */
function LandingSkeleton() {
  return (
    <div className="min-h-screen bg-background">
      <div className="h-14 border-b border-border bg-card nav-enter" />
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl space-y-4 text-center stagger-in">
          <div className="shimmer mx-auto h-6 w-44 rounded-full bg-secondary" />
          <div className="shimmer mx-auto h-11 w-full rounded-lg bg-secondary" />
          <div className="shimmer mx-auto h-11 w-4/5 rounded-lg bg-secondary" />
          <div className="shimmer mx-auto h-4 w-3/5 rounded bg-secondary" />
        </div>
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4 stagger-in">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-32 rounded-xl border border-border bg-card" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * §52's error state. The front door must not fail silently: say what went wrong,
 * offer the retry, and still expose sign-in — that page needs none of this data.
 */
function LandingError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background px-6 text-center">
      <BrandLogo className="h-12 w-12 rounded-xl" />
      <div>
        <h1 className="text-lg font-semibold text-foreground">{APP_NAME} is not answering</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{message}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <Button onClick={onRetry} className="h-10">
          <RefreshCw className="mr-2 h-4 w-4" />
          Try again
        </Button>
        <Button asChild variant="outline" className="h-10">
          <Link to="/sign-in">Go to sign in</Link>
        </Button>
      </div>
    </div>
  );
}

export default function Landing() {
  const { isAuthenticated } = useAuth();
  const [data, setData] = useState<LandingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchLanding());
    } catch (err) {
      setError(
        err instanceof Error && err.message.startsWith("HTTP")
          ? `The server answered ${err.message.slice(5)}. It may still be starting up.`
          : "Could not reach the server. Check that the backend is running, then try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const platformName = data?.platform_name || APP_NAME;

  useEffect(() => {
    document.title = `${platformName} — deploy from your browser`;
  }, [platformName]);

  if (loading && !data) return <LandingSkeleton />;
  if (error && !data) return <LandingError message={error} onRetry={load} />;
  if (!data) return null;

  /**
   * Where the primary call to action goes, in the order the server decides:
   * a fresh install claims the first account at `/setup`; a closed signup has no
   * destination at all, so the CTA becomes a sign-in link rather than a button
   * that would land on a "registration is disabled" error.
   */
  const signupHref = !data.setup_complete ? "/setup" : data.registration_enabled ? "/sign-up" : null;
  const features = FEATURES.filter((f) => !f.flag || data.features[f.flag] !== false);
  const flagOn = (flag: string) => data.features[flag] !== false;

  return (
    <div className="min-h-screen bg-background">
      <MarketingNav platformName={platformName} signupHref={signupHref} signedIn={isAuthenticated} />
      {/* ── Hero ──────────────────────────────────────────────────────────
          Texture is the hairline dot grid from globals.css, masked to fade at
          the edges. A gradient would read as a different product (§28). */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="hero-grid hero-grid-mask absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pb-20 sm:pt-24 lg:px-8">
          <Reveal className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-brand" />
              Self-hosted container hosting
            </span>
            <h1 className="mt-5 text-[2rem] font-bold leading-[1.1] tracking-tight text-foreground sm:text-5xl">
              Push code. Get a URL.
              <span className="mt-1 block text-brand hero-brand-text">On your own server.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              {platformName} turns a repository or a ZIP into a running container: it builds the
              image, starts it, checks the port and puts a domain with HTTPS in front — while your
              code, the containers and the data stay on this machine.
            </p>
          </Reveal>

          <Reveal delay={90} className="mt-8 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
            {signupHref ? (
              <Button asChild className="h-11 w-full px-6 text-sm sm:w-auto cta-glow">
                <Link to={signupHref}>
                  {data.setup_complete ? "Create your account" : "Claim this server"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            ) : (
              <Button asChild className="h-11 w-full px-6 text-sm sm:w-auto cta-glow">
                <Link to="/sign-in">
                  Sign in
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            )}
            <Button asChild variant="outline" className="h-11 w-full px-6 text-sm sm:w-auto">
              <a href="#how">See how it works</a>
            </Button>
          </Reveal>

          {/* Signups closed is a real state of the server, so the hero says so
              instead of showing a button that would fail. */}
          {!signupHref && (
            <Reveal delay={140} className="mt-4 text-center">
              <p className="text-xs text-subtle">
                New registrations are closed on this server right now. Existing accounts can still
                sign in.
              </p>
            </Reveal>
          )}

          <Reveal delay={180} className="mt-10">
            <ul className="mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              {[
                { icon: Lock, label: "Your hardware, your data" },
                { icon: Boxes, label: "Docker images, nothing exotic" },
                { icon: ShieldCheck, label: "No third-party build service" },
              ].map((item) => (
                <li key={item.label} className="flex items-center gap-1.5">
                  <item.icon className="h-3.5 w-3.5 text-success" />
                  {item.label}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>
      {/* ── How it works ───────────────────────────────────────────────────
          The four stages the engine really reports, drawn as a diagram. A fake
          console pane would promise output that does not exist (§53). */}
      <section id="how" className="border-b border-border bg-card py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">
              How it works
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              From a git push to a live URL
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
              Four steps, and you watch every one of them happen in the deploy log. If the new
              version never answers on its port, the one that was working keeps serving.
            </p>
          </Reveal>

          <ol className="mt-12 flex flex-col gap-0 lg:flex-row lg:gap-0 lg:justify-between">
            {PIPELINE.map((step, index) => (
              <Reveal key={step.title} delay={index * 120} as="li" className="relative flex gap-4 pb-10 last:pb-0 lg:flex-col lg:flex-1 lg:gap-0 lg:pb-0 lg:text-center lg:items-center">
                {/* Vertical connector (mobile) */}
                {index < PIPELINE.length - 1 && (
                  <div className="how-connector-v lg:hidden" />
                )}
                {/* Horizontal connector (lg) */}
                {index < PIPELINE.length - 1 && (
                  <div className="how-connector-h hidden lg:block" />
                )}

                {/* Icon with step number badge */}
                <div className="how-step-icon">
                  <step.icon className="h-5 w-5" />
                  <span className="how-step-number">{index + 1}</span>
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1 lg:mt-5">
                  <h3 className="text-sm font-semibold text-foreground">{step.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground lg:mx-auto lg:max-w-[200px]">
                    {step.detail}
                  </p>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>
      {/* ── Features ───────────────────────────────────────────────────────
          Filtered by the live flag map, so a capability the operator switched
          off in Admin → Feature Flags is not advertised here. */}
      <section id="features" className="border-b border-border bg-background py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">
              Everything included
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              What you get in the panel
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
              One place for the app, its database, its variables, its domain and its logs — no
              switching between a dashboard, a terminal and a DNS panel to ship one change.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature, index) => (
              <Reveal key={feature.title} delay={(index % 3) * 70} className="h-full">
                <div className="group flex h-full flex-col rounded-xl border border-border bg-card p-5 card-lift transition-colors hover:border-brand/30">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background transition-colors group-hover:border-brand/30">
                    <feature.icon className="h-4 w-4 text-brand" />
                  </span>
                  <h3 className="mt-4 text-sm font-semibold text-foreground">{feature.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                    {feature.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
      {/* ── About ──────────────────────────────────────────────────────────
          The "what is this, really" section. Deliberately plain about the
          boundaries: it is one server, not a region, and saying so up front is
          better than a support ticket later. */}
      <section id="about" className="border-b border-border bg-card py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">
                About
              </p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                A hosting panel that runs on your own machine
              </h2>
              <div className="mt-4 space-y-4 text-sm leading-relaxed text-muted-foreground">
                <p>
                  {platformName} is a self-hosted platform-as-a-service. It gives a managed-hosting
                  workflow — connect a repository, deploy, watch the log, attach a domain — on
                  hardware you already control, using plain Docker underneath rather than a
                  proprietary runtime.
                </p>
                <p>
                  That means no per-seat surprise on a build minute you did not spend, no vendor
                  holding your images, and a way out at any time: what runs here is a normal
                  container from a normal image, and the volumes are directories on this disk.
                </p>
                <p>
                  It is honest about its shape, too. This is one server, not a multi-region cloud:
                  you get the throughput of the box it is installed on. For a side project, an
                  internal tool, a client site or a bot, that is usually the whole story.
                </p>
              </div>
            </Reveal>

            <Reveal delay={110}>
              <div className="rounded-xl border border-border bg-background p-6 card-lift">
                <h3 className="text-sm font-semibold text-foreground">What is under the hood</h3>
                <dl className="mt-4 divide-y divide-border">
                  {[
                    { k: "Runtime", v: "Docker containers on this host" },
                    { k: "Builds", v: "Your Dockerfile, or Railpack when there is none" },
                    {
                      k: "Sources",
                      v: [flagOn("git_deploy") && "GitHub repositories", flagOn("zip_upload") && "ZIP uploads"]
                        .filter(Boolean)
                        .join(" · ") || "Configured by the operator",
                    },
                    {
                      k: "Data",
                      v: flagOn("databases")
                        ? "Postgres, MySQL, MongoDB and Redis, on local volumes"
                        : "Local volumes per service",
                    },
                    { k: "Edge", v: "nginx or Traefik in front, with automatic certificates" },
                    { k: "Access", v: "Workspaces, roles and an append-only audit log" },
                  ].map((row) => (
                    <div key={row.k} className="flex items-start justify-between gap-4 py-2.5 text-[13px]">
                      <dt className="shrink-0 text-muted-foreground">{row.k}</dt>
                      <dd className="text-right font-medium text-foreground">{row.v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Reveal>
          </div>
        </div>
      </section>
      <PricingSection plans={data.plans} signupHref={signupHref} />

      <FaqSection items={FAQ} />

      {/* ── Closing call to action ─────────────────────────────────────────
          One card, on the dark plane the app already uses for its rail, so the
          page ends on the product's own accent rather than a new colour. */}
      <section className="border-t border-border bg-background py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="overflow-hidden rounded-2xl border border-sidebar-border bg-sidebar px-6 py-12 text-center sm:px-12">
              <BrandLogo className="mx-auto h-11 w-11 rounded-xl" />
              <h2 className="mt-5 text-2xl font-bold tracking-tight text-sidebar-foreground sm:text-3xl">
                {signupHref ? "Deploy your first service today" : `Welcome back to ${platformName}`}
              </h2>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-sidebar-muted">
                {signupHref
                  ? "Connect a repository or drop in a ZIP. The first deploy takes a couple of minutes, and you watch all of it."
                  : "Sign in to reach your projects, deployments and logs."}
              </p>
              <div className="mt-7 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
                <Button asChild className="h-11 w-full px-6 text-sm sm:w-auto">
                  <Link to={signupHref ?? "/sign-in"}>
                    {signupHref ? "Get started" : "Sign in"}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
                {signupHref && (
                  <Button
                    asChild
                    variant="ghost"
                    className="press h-11 w-full px-6 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground sm:w-auto"
                  >
                    <Link to="/sign-in">I already have an account</Link>
                  </Button>
                )}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <MarketingFooter platformName={platformName} signupHref={signupHref} />
    </div>
  );
}
