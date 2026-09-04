import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export type SslInfo = {
  status: "missing" | "pending" | "active" | "expiring" | "expired" | "failed";
  expiresAt?: string | null;
  error?: string | null;
  diagnosticCommand?: string | null;
};

const STYLES: Record<SslInfo["status"], string> = {
  active: "bg-success-surface text-success border-success-border",
  expiring: "bg-warning-surface text-warning border-warning-border",
  expired: "bg-danger-surface text-danger border-danger-border",
  failed: "bg-danger-surface text-danger border-danger-border",
  pending: "bg-brand/10 text-brand border-brand/25",
  missing: "bg-secondary text-muted-foreground border-border/50",
};

const LABELS: Record<SslInfo["status"], string> = {
  active: "HTTPS Active",
  expiring: "Expiring soon",
  expired: "Expired",
  failed: "SSL Failed",
  pending: "Issuing…",
  missing: "No cert",
};

export function SslStatusBadge({
  ssl,
  onRetry,
  retrying,
}: {
  ssl?: SslInfo | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const status = ssl?.status || "missing";
  const expiry =
    ssl?.expiresAt && (status === "active" || status === "expiring")
      ? new Date(ssl.expiresAt).toLocaleDateString()
      : null;

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ${STYLES[status]}`}
        >
          {status === "pending" && <Loader2 className="h-3 w-3 animate-spin" />}
          {LABELS[status]}
        </span>
        {expiry && (
          <span className="text-[11px] text-muted-foreground">until {expiry}</span>
        )}
        {(status === "failed" || status === "expired" || status === "missing") &&
          onRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onRetry}
              disabled={retrying}
            >
              {retrying ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Retry SSL
            </Button>
          )}
      </div>
      {status === "failed" && ssl?.error && (
        <div className="space-y-1.5">
          <p className="text-xs text-danger break-words">{ssl.error}</p>
          {ssl.diagnosticCommand && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">Full error on server:</p>
              <code className="block max-w-full overflow-x-auto rounded bg-secondary px-2 py-1.5 text-[11px] text-foreground select-all">
                {ssl.diagnosticCommand}
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
