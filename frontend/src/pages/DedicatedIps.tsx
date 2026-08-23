// Dedicated IPs — spec Part C §51–§54.
//
// Pro feature, and read-only for now: the API has no provisioning endpoint yet, so
// this page lists what the workspace already has and says plainly where new ones
// come from instead of offering a button that would 404.

import { useCallback, useEffect, useState } from "react";
import { Globe, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlanBadge, PlanLockedCard } from "@/components/workspace/PlanGate";
import { apiGet, errorMessage, scoped } from "@/lib/workspaceApi";
import { cn, copyToClipboard } from "@/lib/utils";
import { toast } from "sonner";
import type { DedicatedIpRow, DedicatedIpsPayload } from "@/lib/workspaceTypes";

const USE_CASES = [
  {
    title: "Allow-list one address",
    body: "Give partners and payment providers a single stable IP to allow through their firewall.",
  },
  {
    title: "Reach locked-down databases",
    body: "Connect to managed databases that only accept traffic from known addresses.",
  },
  {
    title: "Keep egress predictable",
    body: "Outbound traffic leaves from your address instead of the shared pool.",
  },
];

/** Status text is whatever the provisioner wrote; only the colour is decided here. */
function statusClass(status: string): string {
  const value = status.toLowerCase();
  if (value === "active" || value === "assigned") {
    return "border-success-border bg-success-surface text-success";
  }
  if (value === "failed" || value === "released") {
    return "border-danger-border bg-danger-surface text-danger";
  }
  return "border-border text-muted-foreground";
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function DedicatedIps() {
  const [data, setData] = useState<DedicatedIpsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<DedicatedIpsPayload>(scoped("/api/integrations/dedicated-ips")));
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
        <div className="h-28 animate-pulse rounded-md border border-border bg-card" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error ?? "Could not load dedicated IPs."}
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
        <div className="flex items-center gap-2.5">
          <h1 className="text-[27px] font-medium leading-tight text-foreground">Dedicated IPs</h1>
          <PlanBadge tier={data.required_plan} />
        </div>
        <Button
          variant="bare"
          size="icon"
          aria-label="Refresh dedicated IPs"
          className="hover:bg-hover"
          onClick={() => void load()}
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      </div>
      <p className="mt-1.5 max-w-[640px] text-[13px] text-muted-foreground">
        Outbound traffic from this workspace leaves through a fixed address, so it can be
        allow-listed by the services you connect to.
      </p>
      <div className="mt-5 h-px w-full bg-border" />

      <div className="mt-6">
        {data.unlocked ? (
          data.ips.length === 0 ? (
            <EmptyIps />
          ) : (
            <IpTable ips={data.ips} />
          )
        ) : (
          <PlanLockedCard
            feature="Dedicated IPs"
            required={data.required_plan}
            current={data.plan.key}
          >
            <div className="grid gap-2.5 sm:grid-cols-3">
              {USE_CASES.map((useCase) => (
                <div key={useCase.title} className="rounded-md border border-border bg-card p-3">
                  <p className="text-[12px] font-medium text-foreground">{useCase.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {useCase.body}
                  </p>
                </div>
              ))}
            </div>
          </PlanLockedCard>
        )}
      </div>
    </div>
  );
}

function EmptyIps() {
  return (
    <div className="rounded-md border border-border p-8 text-center">
      <Globe className="mx-auto h-5 w-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p className="mt-2 text-[14px] text-foreground">No dedicated IPs</p>
      <p className="mx-auto mt-1 max-w-[420px] text-[12px] leading-relaxed text-muted-foreground">
        This workspace has none assigned yet. Contact support to have an address provisioned in the
        region you need.
      </p>
    </div>
  );
}

function IpTable({ ips }: { ips: DedicatedIpRow[] }) {
  const copy = async (address: string) => {
    if (await copyToClipboard(address)) toast.success("IP address copied");
  };

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">IP Address</th>
              <th className="px-4 py-2.5 font-medium">Region</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Assigned Services</th>
              <th className="px-4 py-2.5 font-medium">Created</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {ips.map((ip) => (
              <tr key={ip.id} className="border-b border-border last:border-b-0 hover:bg-hover">
                <td className="px-4 py-3 font-mono text-[12px] text-foreground">{ip.address}</td>
                {/* Region is omitted upstream when the host does not report one. */}
                <td className="px-4 py-3 text-[12px] text-muted-foreground">{ip.region ?? "—"}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "rounded-[3px] border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em]",
                      statusClass(ip.status),
                    )}
                  >
                    {ip.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-[12px] text-muted-foreground">
                  {ip.assigned_services.length === 0 ? (
                    "None"
                  ) : (
                    <span className="flex flex-wrap gap-1.5">
                      {ip.assigned_services.map((service) => (
                        <span
                          key={service}
                          className="rounded-[3px] border border-border px-1.5 py-[2px] text-[11px]"
                        >
                          {service}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-[12px] text-muted-foreground">
                  {dateLabel(ip.created_at)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Button variant="outline" size="sm" onClick={() => void copy(ip.address)}>
                    Copy
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
