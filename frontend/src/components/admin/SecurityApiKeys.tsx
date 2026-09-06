// Machine API keys (§31) — credentials for scripts, monitors and CI, listed with
// the one fact that decides whether a key is still needed: when it was last used.
//
// A key here is a real credential, not an entry in a table. `adminApiKeyAuth`
// authenticates the `x-admin-api-key` header and `requestPermissions` narrows the
// caller to the key's own permission array, so a key never inherits the `admin`
// role it authenticates as. Revoking one takes effect on its next request.
//
// The plaintext is shown once, by the create dialog, and never again — the row here
// carries a hash and an 11-character prefix. The prefix is printed because it is
// how an operator matches a key in a log line to a row in this table.

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, RefreshCw, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DetailRow,
  ListEmpty,
  ListError,
  ListSkeleton,
  ToneBadge,
} from "@/components/admin/AdminList";
import { ApiKeyCreateDialog } from "@/components/admin/ApiKeyCreateDialog";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { ApiKeyRow, ApiKeysResponse } from "@/lib/adminSecurityTypes";
import { keyTone } from "@/lib/adminSecurityTypes";
import { formatDate, formatDateTime, humanize, relativeDays } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

export function SecurityApiKeys({
  canManage,
  onChanged,
}: {
  canManage: boolean;
  onChanged: () => void;
}) {
  const [data, setData] = useState<ApiKeysResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<ApiKeyRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminGet<ApiKeysResponse>("/api-keys"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (key: ApiKeyRow) => {
    setRevoking(true);
    try {
      const res = await adminSend<{ message?: string }>(`/api-keys/${key.id}`, "DELETE");
      toast.success(res.message || "API key revoked.");
      setConfirming(null);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The key was not revoked.");
    } finally {
      setRevoking(false);
    }
  };

  const keys = data?.keys ?? [];
  const active = keys.filter((k) => k.status === "active");
  const neverUsed = active.filter((k) => !k.last_used_at).length;

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {active.length} active key{active.length === 1 ? "" : "s"}
          {neverUsed > 0 && (
            <span className="text-warning"> · {neverUsed} never used</span>
          )}
          {data && (
            <span className="block text-xs">
              Sent in the{" "}
              <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">
                {data.header}
              </code>{" "}
              request header.
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={load}
            title="Refresh"
            className="h-9 w-9 border-border/60"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
          {canManage && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> New key
            </Button>
          )}
        </div>
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading ? (
        <ListSkeleton rows={3} />
      ) : keys.length === 0 ? (
        <ListEmpty
          message="No API keys have been created."
          hint={
            canManage
              ? "Create one for a monitor or a deploy script instead of sharing an operator password."
              : "Creating a key needs the apikeys.manage permission."
          }
        />
      ) : (
        // One row per key rather than a table: the permission list is the widest
        // thing on the row and wraps badly in a cell, and there are rarely more
        // than a handful of keys to scan.
        <div className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/60">
          {keys.map((key) => (
            <div
              key={key.id}
              className={cn(
                "flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:justify-between",
                key.status !== "active" && "bg-secondary/20",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand/10">
                    <KeyRound className="h-4 w-4 text-brand" />
                  </span>
                  <span className="truncate font-semibold">{key.name}</span>
                  <ToneBadge label={humanize(key.status)} tone={keyTone(key.status)} />
                  {key.status === "active" && !key.last_used_at && (
                    <ToneBadge
                      label="Never used"
                      tone="warning"
                      title="No request has ever presented this key."
                    />
                  )}
                </div>

                <p className="mt-2 font-mono text-xs text-muted-foreground">
                  {key.prefix}
                  <span className="opacity-60">••••••••••••••••••••</span>
                </p>

                <div className="mt-2 flex flex-wrap gap-1">
                  {key.permissions.map((p) => (
                    <span
                      key={p}
                      className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {p}
                    </span>
                  ))}
                  {key.permissions.length === 0 && (
                    <span className="text-[11px] text-muted-foreground">No permissions</span>
                  )}
                </div>
              </div>

              <div className="shrink-0 lg:w-72">
                <dl className="space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between gap-3">
                    <dt>Created</dt>
                    <dd className="text-right tabular-nums">
                      {formatDate(key.created_at)}
                      {key.created_by_email && (
                        <span className="block truncate text-[11px]">
                          by {key.created_by_email}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Last used</dt>
                    <dd className="text-right tabular-nums">
                      {key.last_used_at ? relativeDays(key.last_used_at) : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Expires</dt>
                    <dd className="text-right tabular-nums">
                      {key.expires_at ? relativeDays(key.expires_at) : "Never"}
                    </dd>
                  </div>
                </dl>
                {canManage && key.status !== "revoked" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirming(key)}
                    className="mt-3 w-full border-danger-border text-danger hover:bg-danger-surface"
                  >
                    <ShieldOff className="h-3.5 w-3.5" /> Revoke
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && data && (
        <ApiKeyCreateDialog
          grantable={data.grantable}
          allPermissions={data.all_permissions}
          header={data.header}
          onClose={() => setCreating(false)}
          onCreated={() => {
            void load();
            onChanged();
          }}
        />
      )}

      {confirming && (
        <Dialog open onOpenChange={(o) => !o && setConfirming(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-surface">
                <ShieldOff className="h-6 w-6 text-danger" />
              </div>
              <DialogTitle className="text-center">Revoke {confirming.name}?</DialogTitle>
              <DialogDescription className="text-center">
                Anything using this key starts failing with 401 on its next request. This cannot be
                undone — a replacement is a new key with a new secret.
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-1">
              <DetailRow label="Prefix">
                <span className="font-mono text-xs">{confirming.prefix}</span>
              </DetailRow>
              <DetailRow label="Permissions">{confirming.permissions.length}</DetailRow>
              <DetailRow label="Created">{formatDateTime(confirming.created_at)}</DetailRow>
              <DetailRow label="Last used">
                {confirming.last_used_at ? formatDateTime(confirming.last_used_at) : "Never"}
              </DetailRow>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(null)} disabled={revoking}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => revoke(confirming)}
                disabled={revoking}
              >
                {revoking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldOff className="h-4 w-4" />
                )}
                Revoke key
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

