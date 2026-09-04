// StatusBadge component - colored badge showing project status (running, building, etc.)
//
// Every status pill draws from the semantic token families (success/warning/danger
// plus a neutral) so the six states stay distinguishable without reintroducing raw
// Tailwind palette colours. `ring-*-border` gives the pill its hairline outline.
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
  size?: "sm" | "default";
}

const statusConfig: Record<string, { label: string; colors: string; dot: string }> = {
  running: {
    label: "Running",
    colors: "bg-success-surface text-success ring-success-border",
    dot: "bg-success",
  },
  building: {
    label: "Building",
    colors: "bg-warning-surface text-warning ring-warning-border",
    dot: "bg-warning animate-pulse",
  },
  stopped: {
    label: "Stopped",
    colors: "bg-secondary text-muted-foreground ring-border",
    dot: "bg-muted-foreground/50",
  },
  pending: {
    label: "Pending",
    colors: "bg-brand/10 text-brand ring-brand/20",
    dot: "bg-brand",
  },
  error: {
    label: "Error",
    colors: "bg-danger-surface text-danger ring-danger-border",
    dot: "bg-danger",
  },
  degraded: {
    label: "Degraded",
    colors: "bg-warning-surface text-warning ring-warning-border",
    dot: "bg-chart-3",
  },
};

export function StatusBadge({ status, size = "default" }: StatusBadgeProps) {
  const config = statusConfig[status] || statusConfig.pending;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full ring-1 font-medium",
        config.colors,
        size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs"
      )}
    >
      <span className={cn("rounded-full", config.dot, size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2")} />
      {config.label}
    </span>
  );
}
