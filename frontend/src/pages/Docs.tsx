// In-app documentation. Self-contained guide — no external docs site.
import { useState } from "react";
import {
  BookOpen,
  Rocket,
  Github,
  Database,
  Globe,
  Terminal as TerminalIcon,
  ShieldCheck,
  HardDrive,
} from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import type { IconComponent } from "@/components/shell/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface DocSection {
  id: string;
  label: string;
  icon: IconComponent;
  title: string;
  body: Array<{ heading?: string; text?: string; steps?: string[]; code?: string }>;
}

const SECTIONS: DocSection[] = [
  {
    id: "getting-started",
    label: "Getting started",
    icon: Rocket,
    title: "Getting started",
    body: [
      {
        text: "God Hosting deploys your applications and databases as Docker containers on your own server, with an automatic reverse proxy, TLS certificates and live logs.",
      },
      {
        heading: "Deploy your first app",
        steps: [
          "Click New project in the sidebar.",
          "Choose a source: a public Git repository URL or a direct upload.",
          "God Hosting detects the build type (or you pick a Dockerfile).",
          "Set the internal port your app listens on.",
          "Deploy — watch the build in the live log stream.",
        ],
      },
    ],
  },
  {
    id: "deploying",
    label: "Deploying",
    icon: Github,
    title: "Deploying from a repository",
    body: [
      {
        text: "Point God Hosting at a public repository URL and pick a branch. Each deploy pulls the latest commit, builds the image and rolls the container over with zero-downtime where possible.",
      },
      {
        heading: "Build types",
        steps: [
          "Auto — God Hosting inspects the repo and picks the right builder.",
          "Dockerfile — you provide the path to a Dockerfile.",
          "Set a base directory for monorepos so builds run in the right folder.",
        ],
      },
      {
        heading: "Environment variables",
        text: "Add runtime and build-time variables per service under a project's Environment tab. Mark sensitive values as secrets so they are passed through BuildKit and never logged.",
      },
    ],
  },
  {
    id: "databases",
    label: "Databases",
    icon: Database,
    title: "Managed databases",
    body: [
      {
        text: "Create managed Postgres, MySQL, MariaDB, Redis or MongoDB instances from New database. God Hosting provisions the container, persists its data on a volume and exposes a connection string.",
      },
      {
        heading: "Linking to an app",
        text: "Link a database to an application to inject its connection string (DATABASE_URL, REDIS_URL or MONGODB_URI) into the app's environment automatically.",
      },
    ],
  },
  {
    id: "domains",
    label: "Domains & TLS",
    icon: Globe,
    title: "Domains and certificates",
    body: [
      {
        text: "Attach one or more custom domains to a service. God Hosting configures the reverse proxy and requests a Let's Encrypt certificate automatically once DNS points at your server.",
      },
      {
        heading: "DNS setup",
        steps: [
          "Create an A record for your domain pointing at the server's public IP.",
          "Add the domain to the service under its settings.",
          "Certificates are issued and renewed automatically.",
        ],
      },
    ],
  },
  {
    id: "logs-terminal",
    label: "Logs & terminal",
    icon: TerminalIcon,
    title: "Logs and terminal",
    body: [
      {
        text: "Every service streams its container logs live under the Logs page and each project's detail view. The Terminal page gives you an interactive shell on the server for maintenance tasks.",
      },
      {
        heading: "System logs",
        text: "The Logs page also streams the control-plane services (backend, proxy, certbot). These are only present when God Hosting runs via its Docker compose stack on the server — during local development they will be empty.",
      },
    ],
  },
  {
    id: "storage",
    label: "Storage",
    icon: HardDrive,
    title: "Persistent storage",
    body: [
      {
        text: "Add persistent volumes to a service to keep data across deploys and restarts. Mount them at the path your app expects (e.g. /data or /var/lib/postgresql/data).",
      },
    ],
  },
  {
    id: "plans-quotas",
    label: "Plans & quotas",
    icon: ShieldCheck,
    title: "Plans and quotas",
    body: [
      {
        text: "Your plan sets limits on RAM, CPU, storage, apps, domains and backups. Administrators define plans and can grant per-user overrides. Unlimited is represented explicitly — there are no hidden caps.",
      },
      {
        heading: "Enforcement",
        text: "Quotas are enforced live on the server from real counts. Reaching a limit surfaces a clear message telling you what to upgrade.",
      },
    ],
  },
];

export default function Docs() {
  const [active, setActive] = useState(SECTIONS[0].id);
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Documentation"
        title="Docs"
        description="Guides for deploying and operating your apps on God Hosting."
        icon={BookOpen}
      />

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
          {SECTIONS.map((s) => {
            const isActive = s.id === active;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActive(s.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-brand/12 text-brand"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )}
              >
                <s.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{s.label}</span>
              </button>
            );
          })}
        </nav>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <section.icon className="h-5 w-5 text-brand" />
              {section.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {section.body.map((block, i) => (
              <div key={i} className="space-y-2">
                {block.heading && (
                  <h3 className="text-sm font-semibold text-foreground">{block.heading}</h3>
                )}
                {block.text && (
                  <p className="text-sm leading-relaxed text-muted-foreground">{block.text}</p>
                )}
                {block.steps && (
                  <ol className="ml-4 list-decimal space-y-1.5 text-sm text-muted-foreground">
                    {block.steps.map((step, j) => (
                      <li key={j} className="pl-1">{step}</li>
                    ))}
                  </ol>
                )}
                {block.code && (
                  <pre className="overflow-x-auto rounded-lg border border-border bg-secondary/40 p-3 text-xs">
                    <code>{block.code}</code>
                  </pre>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
