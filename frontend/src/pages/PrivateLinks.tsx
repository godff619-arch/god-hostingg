// Private Links — the Part A sidebar entry under NETWORKING.
//
// A private link attaches one project's container to another project's Docker
// bridge network, so the consumer reaches it by container DNS with no published
// host port and nothing resolvable from outside the machine. It is the secure
// alternative to opening a port, which is why it is available on every plan.
//
// Nothing here is optimistic. `status` is whatever the last apply actually
// returned: `pending` when the target has never been deployed, `error` with
// Docker's own message when the daemon refused, `active` only once the attach
// succeeded. The address column is blank rather than guessed while the target
// has no container.

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  Network,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import { cn, copyToClipboard } from "@/lib/utils";
import type {
  PrivateLinkCandidate,
  PrivateLinkRow,
  PrivateLinksPayload,
} from "@/lib/workspaceTypes";

/** Colour only — the words come from the server. */
function statusClass(status: string): string {
  if (status === "active") return "border-success-border bg-success-surface text-success";
  if (status === "error") return "border-danger-border bg-danger-surface text-danger";
  return "border-border text-muted-foreground";
}

function StatusIcon({ status }: { status: string }) {
  if (status === "active") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-success" strokeWidth={1.75} aria-hidden />;
  }
  if (status === "error") {
    return <AlertTriangle className="h-3.5 w-3.5 text-danger" strokeWidth={1.75} aria-hidden />;
  }
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden />;
}

function timeLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PrivateLinks() {
  const [data, setData] = useState<PrivateLinksPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<PrivateLinksPayload>(scoped("/api/private-links")));
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
        <div className="h-8 w-48 animate-pulse rounded-md bg-secondary/50" />
        <div className="h-32 animate-pulse rounded-md border border-border bg-card" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error ?? "Could not load private links."}
        </div>
        <Button variant="outline" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  const sources = data.candidates.filter((c) => c.kind === "app");

  return (
    <div className="mx-auto w-full max-w-[960px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[27px] font-medium leading-tight text-foreground">Private Links</h1>
        <div className="flex items-center gap-1.5">
          <Button
            variant="bare"
            size="icon"
            aria-label="Refresh private links"
            className="hover:bg-hover"
            onClick={() => void load()}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
          {data.can_write ? (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" strokeWidth={2} />
              New private link
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 max-w-[640px] text-[13px] text-muted-foreground">
        Let one service in {data.workspace.name} reach another over the internal network only — no
        published port, nothing resolvable from the internet. Available on every plan.
      </p>
      <div className="mt-5 h-px w-full bg-border" />

      {!data.docker.reachable ? (
        <div className="mt-6 flex items-start gap-2.5 rounded-md border border-warning-border bg-warning-surface p-3 text-[12px] text-warning">
          <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          <p>
            {data.docker.message ??
              "Docker is not reachable, so links cannot be attached right now."}{" "}
            Existing links stay pending until it is back — use Apply to retry then.
          </p>
        </div>
      ) : null}

      <div className="mt-6">
        {data.links.length === 0 ? (
          <EmptyLinks canWrite={data.can_write} onAdd={() => setAddOpen(true)} />
        ) : (
          <LinkTable links={data.links} canWrite={data.can_write} onChanged={load} />
        )}
      </div>

      <HowItWorks />

      <LinkDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        sources={sources}
        targets={data.candidates}
        schemes={data.schemes}
        onDone={load}
      />
    </div>
  );
}

function EmptyLinks({ canWrite, onAdd }: { canWrite: boolean; onAdd: () => void }) {
  return (
    <div className="rounded-md border border-border p-8 text-center">
      <Network className="mx-auto h-5 w-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p className="mt-2 text-[14px] text-foreground">No private links</p>
      <p className="mx-auto mt-1 max-w-[440px] text-[12px] leading-relaxed text-muted-foreground">
        Create one to give a service private access to another — an API reaching an internal worker,
        or an app reaching a database without exposing its port.
      </p>
      {canWrite ? (
        <Button variant="outline" size="sm" className="mt-3.5" onClick={onAdd}>
          <Plus className="mr-1 h-3.5 w-3.5" strokeWidth={2} />
          New private link
        </Button>
      ) : null}
    </div>
  );
}

function HowItWorks() {
  return (
    <section className="mt-4 rounded-md border border-border bg-card p-4">
      <h2 className="text-[13px] font-medium text-foreground">How a private link works</h2>
      <ol className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-muted-foreground">
        <li>
          1. The target's container joins the source project's private network. Nothing is published
          to the host.
        </li>
        <li>
          2. The source reaches it at the internal address below — container DNS, resolvable only on
          that network.
        </li>
        <li>
          3. If you named an environment variable, it is set on the source with that address, so your
          code reads config instead of hardcoding a hostname.
        </li>
        <li>
          4. Redeploys re-attach automatically. When a target has never been deployed the link stays
          pending — there is no container to join yet.
        </li>
      </ol>
    </section>
  );
}

function LinkTable({
  links,
  canWrite,
  onChanged,
}: {
  links: PrivateLinkRow[];
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Connection</th>
              <th className="px-4 py-2.5 font-medium">Internal address</th>
              <th className="px-4 py-2.5 font-medium">Env var</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <LinkRow key={link.id} link={link} canWrite={canWrite} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LinkRow({
  link,
  canWrite,
  onChanged,
}: {
  link: PrivateLinkRow;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"apply" | "delete" | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const apply = async () => {
    setBusy("apply");
    try {
      const res = await apiSend<{ applied: { status: string; error: string | null } }>(
        scoped(`/api/private-links/${link.id}/apply`),
        "POST",
      );
      // Report what Docker did, including the failure — never a blanket success.
      if (res.applied.status === "active") toast.success(`${link.name} attached`);
      else toast.error(res.applied.error ?? `${link.name} is still ${res.applied.status}`);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await apiSend(scoped(`/api/private-links/${link.id}`), "DELETE");
      toast.success(`${link.name} removed`);
      setDeleteOpen(false);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (link.address && (await copyToClipboard(link.address))) toast.success("Address copied");
  };

  return (
    <tr className="border-b border-border align-top last:border-b-0 hover:bg-hover">
      <td className="px-4 py-3">
        <p className="text-[13px] text-foreground">{link.name}</p>
        <p className="mt-0.5 text-[11px] text-subtle">Created {timeLabel(link.created_at)}</p>
      </td>
      <td className="px-4 py-3">
        <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="text-foreground">{link.source.name}</span>
          <ArrowRight className="h-3 w-3" strokeWidth={1.75} aria-hidden />
          <span className="text-foreground">{link.target.name}</span>
          <span className="text-subtle">:{link.target_port}</span>
        </span>
      </td>
      <td className="px-4 py-3">
        {link.address ? (
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-[3px] font-mono text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
            title="Copy internal address"
          >
            {link.address}
          </button>
        ) : (
          // No container yet, so there is no address to show.
          <span className="text-[11px] text-subtle">Not deployed yet</span>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
        {link.env_key ?? <span className="font-sans text-subtle">None</span>}
      </td>
      <td className="px-4 py-3">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em]",
            statusClass(link.status),
          )}
        >
          <StatusIcon status={link.status} />
          {link.status}
        </span>
        {link.last_error ? (
          <p className="mt-1 max-w-[240px] text-[11px] leading-relaxed text-danger">
            {link.last_error}
          </p>
        ) : null}
        <p className="mt-1 text-[11px] text-subtle">Applied {timeLabel(link.last_applied_at)}</p>
      </td>
      <td className="px-4 py-3 text-right">
        {canWrite ? (
          <div className="flex items-center justify-end gap-1.5">
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void apply()}>
              {busy === "apply" ? "Applying…" : "Apply"}
            </Button>
            <Button
              variant="bare"
              size="icon"
              aria-label={`Remove ${link.name}`}
              className="hover:bg-hover"
              disabled={busy !== null}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Button>
          </div>
        ) : (
          <span className="text-[11px] text-subtle">Read only</span>
        )}

        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove {link.name}?</DialogTitle>
              <DialogDescription>
                {link.source.name} loses private access to {link.target.name}
                {link.env_key ? ` and ${link.env_key} is removed from its environment` : ""}. The
                change takes effect on its next deploy or restart.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={busy !== null} onClick={() => void remove()}>
                {busy === "delete" ? "Removing…" : "Remove link"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </td>
    </tr>
  );
}

/**
 * Create a link. Both dropdowns are populated from the workspace's own resources,
 * so there is nothing to type wrong and no id from another tenant to paste in.
 */
function LinkDialog({
  open,
  onOpenChange,
  sources,
  targets,
  schemes,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: PrivateLinkCandidate[];
  targets: PrivateLinkCandidate[];
  schemes: Array<"http" | "tcp">;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [port, setPort] = useState("");
  const [scheme, setScheme] = useState<"http" | "tcp">(schemes[0] ?? "http");
  const [envKey, setEnvKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setSourceId("");
    setTargetId("");
    setPort("");
    setScheme(schemes[0] ?? "http");
    setEnvKey("");
  }, [open, schemes]);

  const target = useMemo(() => targets.find((t) => t.id === targetId), [targets, targetId]);
  // A database's own port is the one to suggest; an app's is its internal port.
  const eligibleTargets = useMemo(
    () => targets.filter((t) => t.id !== sourceId),
    [targets, sourceId],
  );

  const pickTarget = (id: string) => {
    setTargetId(id);
    const chosen = targets.find((t) => t.id === id);
    if (chosen?.suggested_port) setPort(String(chosen.suggested_port));
  };

  const trimmedName = name.trim();
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const normalizedEnv = envKey.trim().toUpperCase();
  const envValid = normalizedEnv.length === 0 || /^[A-Z][A-Z0-9_]*$/.test(normalizedEnv);
  const blocked =
    !trimmedName ||
    trimmedName.length > 60 ||
    !sourceId ||
    !targetId ||
    sourceId === targetId ||
    !portValid ||
    !envValid ||
    saving;

  const submit = async () => {
    if (blocked) return;
    setSaving(true);
    try {
      const res = await apiSend<{ applied: { status: string; error: string | null } }>(
        scoped("/api/private-links"),
        "POST",
        {
          name: trimmedName,
          source: sourceId,
          target: targetId,
          port: portNumber,
          scheme,
          ...(normalizedEnv ? { env_key: normalizedEnv } : {}),
        },
      );
      if (res.applied.status === "active") {
        toast.success(`${trimmedName} created and attached`);
      } else {
        // The row exists but is not usable yet, and the toast says exactly why.
        toast.warning(res.applied.error ?? `${trimmedName} created — ${res.applied.status}`);
      }
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const selectClass =
    "h-9 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New private link</DialogTitle>
          <DialogDescription>
            The target joins the source's private network. Nothing is published to the host.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="link-name" className="text-[12px] text-muted-foreground">
              Name
            </label>
            <Input
              id="link-name"
              value={name}
              maxLength={60}
              placeholder="api → worker"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="link-source" className="text-[12px] text-muted-foreground">
                Source (the consumer)
              </label>
              <select
                id="link-source"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className={selectClass}
              >
                <option value="" className="bg-card">
                  Select a service…
                </option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id} className="bg-card">
                    {s.name}
                  </option>
                ))}
              </select>
              {sources.length === 0 ? (
                <p className="text-[11px] text-subtle">
                  This workspace has no apps yet — a database cannot be the consumer.
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="link-target" className="text-[12px] text-muted-foreground">
                Target (the provider)
              </label>
              <select
                id="link-target"
                value={targetId}
                onChange={(e) => pickTarget(e.target.value)}
                className={selectClass}
              >
                <option value="" className="bg-card">
                  Select a service…
                </option>
                {eligibleTargets.map((t) => (
                  <option key={t.id} value={t.id} className="bg-card">
                    {t.name}
                    {t.kind === "database" ? ` (${t.engine ?? "database"})` : ""}
                  </option>
                ))}
              </select>
              {target && !target.container ? (
                <p className="flex items-start gap-1.5 text-[11px] text-warning">
                  <Database className="mt-[1px] h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden />
                  {target.name} has never been deployed, so the link will stay pending until it is.
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="link-port" className="text-[12px] text-muted-foreground">
                Target port
              </label>
              <Input
                id="link-port"
                value={port}
                inputMode="numeric"
                placeholder="3000"
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
              />
              {port && !portValid ? (
                <p className="text-[11px] text-danger">Use a port between 1 and 65535.</p>
              ) : (
                <p className="text-[11px] text-subtle">
                  The port inside the container, not a host port.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="link-scheme" className="text-[12px] text-muted-foreground">
                Address form
              </label>
              <select
                id="link-scheme"
                value={scheme}
                onChange={(e) => setScheme(e.target.value as "http" | "tcp")}
                className={selectClass}
              >
                {schemes.map((s) => (
                  <option key={s} value={s} className="bg-card">
                    {s === "http" ? "http:// URL" : "host:port"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="link-env" className="text-[12px] text-muted-foreground">
              Inject as environment variable (optional)
            </label>
            <Input
              id="link-env"
              value={envKey}
              maxLength={64}
              placeholder="WORKER_URL"
              onChange={(e) => setEnvKey(e.target.value)}
            />
            {!envValid ? (
              <p className="text-[11px] text-danger">
                Upper snake case, starting with a letter — for example WORKER_URL.
              </p>
            ) : (
              <p className="text-[11px] text-subtle">
                Set on the source and shared by its services. Leave blank to inject nothing.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={blocked} onClick={() => void submit()}>
            {saving ? "Creating…" : "Create link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
