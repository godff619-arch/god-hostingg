// Observability — spec Part C §61–§64: a Metrics Stream and a Log Stream, each
// pointing at an external destination.
//
// Available on every plan, so there is no PlanGate here. The secret is write-only:
// the API only ever reports `secret_configured`, so this page can show "configured"
// but never the key itself.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Activity, CheckCircle2, RefreshCw, ScrollText, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import { cn } from "@/lib/utils";
import type { ObservabilityPayload, ObservabilityStream } from "@/lib/workspaceTypes";

/** Provider ids come from the server; these are just their display names. */
const PROVIDER_LABELS: Record<string, string> = {
  datadog: "Datadog",
  grafana: "Grafana Cloud",
  newrelic: "New Relic",
  honeycomb: "Honeycomb",
  otel: "Custom OpenTelemetry",
  custom: "Custom HTTPS endpoint",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Observability() {
  const [data, setData] = useState<ObservabilityPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<ObservabilityPayload>(scoped("/api/integrations/observability")));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="mx-auto w-full max-w-[960px] space-y-4">
        <div className="h-8 w-44 animate-pulse rounded-md bg-secondary/50" />
        <div className="h-40 animate-pulse rounded-md border border-border bg-card" />
        <div className="h-40 animate-pulse rounded-md border border-border bg-card" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error ?? "Could not load observability settings."}
        </div>
        <Button variant="outline" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[960px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[27px] font-medium leading-tight text-foreground">Observability</h1>
        <Button
          variant="bare"
          size="icon"
          aria-label="Refresh observability settings"
          className="hover:bg-hover"
          onClick={() => void load()}
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      </div>
      <p className="mt-1.5 max-w-[640px] text-[13px] text-muted-foreground">
        Forward this workspace's metrics and logs to your own monitoring stack. Both streams are
        off until you add a destination.
      </p>
      <div className="mt-5 h-px w-full bg-border" />

      <div className="mt-6 space-y-4">
        <StreamCard
          kind="metrics"
          title="Metrics Stream"
          description="Ships CPU, memory and request metrics for every service in this workspace."
          icon={Activity}
          providers={data.providers}
          stream={data.metrics}
          onSaved={load}
        />
        <StreamCard
          kind="logs"
          title="Log Streams"
          description="Ships application and build logs as they are produced."
          icon={ScrollText}
          providers={data.providers}
          stream={data.logs}
          onSaved={load}
        />
      </div>
    </div>
  );
}

/**
 * One stream (metrics or logs). The form is the whole card — there is no separate
 * dialog, because a stream is a single row of settings that is saved with one PUT.
 */
function StreamCard({
  kind,
  title,
  description,
  icon: Icon,
  providers,
  stream,
  onSaved,
}: {
  kind: "metrics" | "logs";
  title: string;
  description: string;
  icon: typeof Activity;
  providers: string[];
  stream: ObservabilityStream | null;
  onSaved: () => Promise<void>;
}) {
  const [provider, setProvider] = useState(stream?.provider ?? providers[0] ?? "custom");
  const [endpoint, setEndpoint] = useState(stream?.endpoint ?? "");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(stream?.enabled ?? false);
  const [includePreview, setIncludePreview] = useState(stream?.include_preview ?? false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Re-seed whenever the server's copy changes, so a refresh wins over stale state.
  useEffect(() => {
    setProvider(stream?.provider ?? providers[0] ?? "custom");
    setEndpoint(stream?.endpoint ?? "");
    setEnabled(stream?.enabled ?? false);
    setIncludePreview(stream?.include_preview ?? false);
    setSecret("");
  }, [stream, providers]);

  const urlLooksWrong = endpoint.trim().length > 0 && !endpoint.trim().startsWith("https://");
  // The server refuses to enable a stream that has no destination; mirror that here.
  const blocked = urlLooksWrong || (enabled && endpoint.trim().length === 0);

  const save = async () => {
    if (blocked) return;
    setSaving(true);
    try {
      await apiSend(scoped(`/api/integrations/observability/${kind}`), "PUT", {
        provider,
        endpoint: endpoint.trim() || null,
        enabled,
        // Only meaningful for logs; the server forces false for metrics anyway.
        ...(kind === "logs" ? { include_preview: includePreview } : {}),
        // Omitted when blank so an existing key is kept rather than cleared.
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      });
      toast.success(`${title} saved`);
      setSecret("");
      await onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await apiSend<{ ok: boolean; detail: string; duration_ms: number }>(
        scoped(`/api/integrations/observability/${kind}/test`),
        "POST",
      );
      if (result.ok) toast.success(`Reached the destination — ${result.detail} in ${result.duration_ms} ms`);
      else toast.error(`Could not reach the destination — ${result.detail}`);
      await onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div className="flex min-w-0 gap-2.5">
          <Icon className="mt-[3px] h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <div className="min-w-0">
            <h2 className="text-[14px] font-medium text-foreground">{title}</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
          </div>
        </div>
        <span
          className={cn(
            "rounded-[3px] border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em]",
            stream?.enabled
              ? "border-success-border bg-success-surface text-success"
              : "border-border text-muted-foreground",
          )}
        >
          {stream?.enabled ? "Streaming" : "Off"}
        </span>
      </div>

      <div className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor={`${kind}-provider`} className="text-[12px] text-muted-foreground">
              Provider
            </label>
            <select
              id={`${kind}-provider`}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
            >
              {providers.map((option) => (
                <option key={option} value={option} className="bg-card">
                  {providerLabel(option)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${kind}-endpoint`} className="text-[12px] text-muted-foreground">
              Destination
            </label>
            <Input
              id={`${kind}-endpoint`}
              value={endpoint}
              placeholder="https://http-intake.example.com/v1/input"
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </div>
        </div>
        {urlLooksWrong ? (
          <p className="text-[11px] text-danger">The destination must be an https:// URL.</p>
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor={`${kind}-secret`} className="text-[12px] text-muted-foreground">
            API key
          </label>
          <Input
            id={`${kind}-secret`}
            type="password"
            value={secret}
            autoComplete="off"
            placeholder={stream?.secret_configured ? "Configured — enter a new key to replace it" : "Optional"}
            onChange={(e) => setSecret(e.target.value)}
          />
          <p className="text-[11px] text-subtle">
            Stored encrypted and never returned by the API, so it cannot be shown here again.
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-[3px] h-3.5 w-3.5 accent-[hsl(var(--brand))]"
          />
          <span className="min-w-0">
            <span className="block text-[12px] text-foreground">Stream enabled</span>
            <span className="block text-[11px] text-muted-foreground">
              A destination is required before the stream can be turned on.
            </span>
          </span>
        </label>

        {kind === "logs" ? (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5">
            <input
              type="checkbox"
              checked={includePreview}
              onChange={(e) => setIncludePreview(e.target.checked)}
              className="mt-[3px] h-3.5 w-3.5 accent-[hsl(var(--brand))]"
            />
            <span className="min-w-0">
              <span className="block text-[12px] text-foreground">Include preview logs</span>
              <span className="block text-[11px] text-muted-foreground">
                Also forward logs from preview environments, not just production.
              </span>
            </span>
          </label>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          {/* Last result comes from the server, so it survives a reload. */}
          {stream?.last_test && stream.last_test_at ? (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {stream.last_test === "ok" ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-success" strokeWidth={1.75} />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-danger" strokeWidth={1.75} />
              )}
              Last test {stream.last_test === "ok" ? "succeeded" : "failed"} ·{" "}
              {timeLabel(stream.last_test_at)}
            </p>
          ) : (
            <p className="text-[11px] text-subtle">Not tested yet.</p>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              // Testing probes the *saved* destination, so it needs one on the server.
              disabled={testing || !stream?.endpoint}
              onClick={() => void test()}
            >
              {testing ? "Testing…" : "Test Connection"}
            </Button>
            <Button size="sm" disabled={saving || blocked} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
