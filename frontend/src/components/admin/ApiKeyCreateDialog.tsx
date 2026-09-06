// Mint a machine API key (§31, `apikeys.manage`).
//
// Two things this dialog exists to get right.
//
// The secret is shown exactly once. The server keeps a SHA-256 of it plus an
// 11-character prefix, so "show it to me again" is not a feature that was left
// out — there is nothing left to show. The reveal step says so, and stays open
// until the operator dismisses it deliberately.
//
// A key can only carry permissions its creator already holds. `grantable` comes
// from the server; the rest are still listed, disabled, with the reason. Hiding
// them would make the rule look like a UI quirk instead of what it is: without
// it, `apikeys.manage` is an escalation primitive — mint a key with
// `users.delete`, then use the key.

import { useMemo, useState } from "react";
import { Check, Copy, KeyRound, Loader2, ShieldCheck, Terminal } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/admin/AdminList";
import { adminSend } from "@/lib/adminApi";
import type { CreatedApiKey } from "@/lib/adminSecurityTypes";
import { humanize } from "@/lib/adminFormat";
import { API_URL, copyToClipboard, cn } from "@/lib/utils";

/**
 * Base the sample `curl` should target — the same one `adminApi` talks to.
 * `API_URL` is empty in the normal case (nginx in production, Vite's `/api`
 * proxy in dev), where this is the page's own origin; a deployment that sets
 * `VITE_API_URL` to a separate API host gets that host printed instead of a
 * command aimed at the static frontend.
 */
const apiOrigin = API_URL || window.location.origin;

interface Props {
  /** Permissions the caller holds — the only ones the server will accept. */
  grantable: string[];
  allPermissions: string[];
  /** Request header the key travels in; the server owns the name. */
  header: string;
  onClose: () => void;
  onCreated: () => void;
}

/** `users.view` → group `users`. The matrix is already grouped; mirror it. */
function groupOf(permission: string): string {
  const [group] = permission.split(".");
  return group || "other";
}

export function ApiKeyCreateDialog({
  grantable,
  allPermissions,
  header,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const grantableSet = useMemo(() => new Set(grantable), [grantable]);

  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of allPermissions) {
      const g = groupOf(p);
      map.set(g, [...(map.get(g) ?? []), p]);
    }
    return Array.from(map.entries());
  }, [allPermissions]);

  const toggle = (permission: string) => {
    setChosen((prev) =>
      prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission],
    );
  };

  const submit = async () => {
    if (name.trim().length < 3) {
      toast.error("Give the key a name of at least 3 characters.");
      return;
    }
    if (chosen.length === 0) {
      toast.error("A key with no permissions could not do anything.");
      return;
    }
    setSaving(true);
    try {
      const res = await adminSend<CreatedApiKey>("/api-keys", "POST", {
        name: name.trim(),
        permissions: chosen,
        expires_at: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      });
      setCreated(res);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The key was not created.");
    } finally {
      setSaving(false);
    }
  };

  const copySecret = async () => {
    if (!created) return;
    const ok = await copyToClipboard(created.key.secret);
    setCopied(ok);
    if (ok) toast.success("Key copied to the clipboard.");
    else toast.error("Could not copy — select the key and copy it by hand.");
  };

  if (created) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-success-surface">
              <ShieldCheck className="h-6 w-6 text-success" />
            </div>
            <DialogTitle className="text-center">{created.key.name} is ready</DialogTitle>
            <DialogDescription className="text-center">
              Copy it now. Only a hash is stored, so this is the last time it can be shown.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-xl border-2 border-brand/25 bg-brand/5 p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand">
                Secret key
              </p>
              <code className="block break-all font-mono text-xs leading-relaxed">
                {created.key.secret}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={copySecret}
                className="mt-3 w-full border-brand/30 bg-background"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy key"}
              </Button>
            </div>

            <div className="rounded-xl border border-border/60 bg-secondary/30 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <Terminal className="h-3 w-3" /> How to use it
              </p>
              <code className="block break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                curl -H &quot;{created.header}: {created.key.secret.slice(0, 11)}…&quot; \<br />
                &nbsp;&nbsp;{apiOrigin}/api/admin/me
              </code>
            </div>
            <p className="rounded-xl border border-warning-border bg-warning-surface px-3 py-2 text-xs text-warning">
              The key carries {chosen.length} permission{chosen.length === 1 ? "" : "s"} and works
              from anywhere that can reach this server. Treat it like a password: put it in a secret
              store, never in a repository. Revoke it from the list if it leaks — that takes effect
              on the next request.
            </p>
          </div>

          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const nothingGrantable = grantable.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10">
            <KeyRound className="h-6 w-6 text-brand" />
          </div>
          <DialogTitle className="text-center">New API key</DialogTitle>
          <DialogDescription className="text-center">
            A credential for a script or a monitor, sent in the <code>{header}</code> header. It
            authenticates as itself, not as you.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What it is for. Shown in the audit log for every call it makes.">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Uptime monitor"
                autoFocus
              />
            </Field>
            <Field label="Expires (optional)" hint="Leave blank for a key that never expires.">
              <Input
                type="date"
                value={expiresAt}
                min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-muted-foreground">
                Permissions ({chosen.length} selected)
              </span>
              <span className="flex gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 border-border/60 text-xs"
                  onClick={() => setChosen(grantable.filter((p) => p.endsWith(".view")))}
                >
                  Read-only
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setChosen([])}
                >
                  Clear
                </Button>
              </span>
            </div>

            <div className="max-h-[38vh] space-y-3 overflow-y-auto rounded-xl border border-border/60 bg-secondary/20 p-3">
              {groups.map(([group, permissions]) => (
                <div key={group}>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {humanize(group)}
                  </p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {permissions.map((permission) => {
                      const allowed = grantableSet.has(permission);
                      const on = chosen.includes(permission);
                      return (
                        <label
                          key={permission}
                          className={cn(
                            "flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
                            allowed
                              ? "cursor-pointer border-border/60 bg-card hover:border-brand/30"
                              : "cursor-not-allowed border-dashed border-border/50 opacity-55",
                            on && "border-brand/40 bg-brand/5",
                          )}
                          title={
                            allowed ? undefined : "You do not hold this permission, so you cannot grant it."
                          }
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={!allowed}
                            onChange={() => toggle(permission)}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[hsl(var(--brand))]"
                          />
                          <span className="min-w-0">
                            <span className="block font-mono text-[11px] font-semibold">
                              {permission}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-2 text-[11px] text-muted-foreground">
              Greyed rows are permissions you do not hold. The server refuses them too — this is not
              only a disabled checkbox.
            </p>
          </div>

          {nothingGrantable && (
            <p className="rounded-xl border border-danger-border bg-danger-surface px-3 py-2 text-xs text-danger">
              Your role holds no permissions, so any key you created would be inert.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || nothingGrantable || chosen.length === 0 || name.trim().length < 3}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            Create key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

