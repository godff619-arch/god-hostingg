// The parts every admin list page repeats: search box, filter pills, sortable
// header cell, the four §52 states (loading / empty / error+retry / loaded), the
// range pagination footer, and the small form controls used inside dialogs.
//
// Extracted from AdminUsers.tsx rather than reinvented — the markup and the tokens
// are identical on purpose, so the billing pages are visibly the same product as
// the pages that shipped before them. Behaviour lives here once; a page supplies
// only its columns and its actions.

import type { ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/adminFormat";

/** Status pill for the money vocabularies. Tone comes from `billingTone(status)`. */
export function ToneBadge({
  label,
  tone = "neutral",
  title,
}: {
  label: string;
  tone?: Tone;
  title?: string;
}) {
  const tones: Record<Tone, string> = {
    neutral: "bg-secondary text-muted-foreground ring-border",
    success: "bg-success-surface text-success ring-success-border",
    warning: "bg-warning-surface text-warning ring-warning-border",
    danger: "bg-danger-surface text-danger ring-danger-border",
    info: "bg-brand/10 text-brand ring-brand/20",
  };
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ring-1",
        tones[tone],
      )}
    >
      {label}
    </span>
  );
}

/** Debounce-friendly search field. The page owns the debounce; this is the input. */
export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative flex-1">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-9"
      />
    </div>
  );
}

export interface PillOption {
  value: string;
  label: string;
  /** From the API's `facets`, so a filter never claims rows it cannot show. */
  count?: number;
}

/** One row of filter pills. `value === option.value` is the selected one. */
export function FilterPills({
  options,
  value,
  onChange,
}: {
  options: PillOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "press rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors",
            value === option.value
              ? "border-brand/30 bg-brand/10 text-brand"
              : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="ml-1.5 text-[11px] tabular-nums opacity-70">{option.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Sortable column header. Generic over the page's own sort-key union. */
export function SortableTh<K extends string>({
  label,
  sortKey,
  active,
  order,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: K;
  active: K;
  order: "asc" | "desc";
  onSort: (key: K) => void;
  align?: "left" | "right";
}) {
  const isActive = active === sortKey;
  return (
    <th className={cn("px-4 py-3 font-semibold", align === "right" && "text-right")}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-[0.14em] transition-colors hover:text-foreground",
          isActive && "text-foreground",
        )}
      >
        {label}
        {isActive &&
          (order === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          ))}
      </button>
    </th>
  );
}

/**
 * §52 error state. Always offers the retry — a money page that fails to load and
 * then just sits there blank is indistinguishable from an account with no data.
 */
export function ListError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm text-danger sm:flex-row sm:items-center sm:justify-between">
      <span className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0 self-start sm:self-auto">
          <RefreshCw className="h-3.5 w-3.5" /> Try again
        </Button>
      )}
    </div>
  );
}

/** §52 loading state. Placeholder rows, not a spinner, so the layout holds still. */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-16 animate-pulse border-b border-border/40 bg-secondary/20 last:border-b-0"
        />
      ))}
    </div>
  );
}

/** §52 empty state. `hint` distinguishes "no data yet" from "no match". */
export function ListEmpty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border/60 px-4 py-16 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground/80">{hint}</p>}
    </div>
  );
}

/** `Showing 1–15 of 240 payments` plus the two page arrows. */
export function Pagination({
  page,
  pageSize,
  total,
  noun,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  noun: string;
  onPage: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);
  return (
    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        Showing{" "}
        <span className="font-semibold text-foreground">
          {rangeStart}–{rangeEnd}
        </span>{" "}
        of <span className="font-semibold text-foreground">{total}</span> {noun}
      </p>
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 border-border/60"
          disabled={page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-[4.5rem] text-center text-xs font-medium tabular-nums text-muted-foreground">
          {page} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 border-border/60"
          disabled={page >= pageCount}
          onClick={() => onPage(Math.min(pageCount, page + 1))}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Totals strip above a money table. Every figure here is computed by the API over
 * the *whole filtered set* (SQL aggregate), not summed from the visible page — a
 * "collected" number that changes when you page is worse than no number (§53).
 */
export function MetricStrip({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

export function Metric({
  label,
  value,
  hint,
  tone = "neutral",
  loading,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
  loading?: boolean;
}) {
  const tones: Record<Tone, string> = {
    neutral: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    info: "text-brand",
  };
  return (
    <div className="rounded-2xl border border-border/60 bg-card px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      {loading ? (
        <div className="mt-2 h-6 w-24 animate-pulse rounded bg-secondary/60" />
      ) : (
        <p className={cn("mt-1 text-lg font-bold tabular-nums", tones[tone])}>{value}</p>
      )}
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Labelled form control, same markup as the user dialogs. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground/80">{hint}</span>}
    </label>
  );
}

export function SelectBox({
  value,
  onChange,
  children,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="flex h-11 w-full rounded-xl border-2 border-border bg-background px-3 text-sm transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </select>
  );
}

/** `label — value` row for detail panes and dialogs. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/40 py-2 last:border-b-0">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-sm">{children}</span>
    </div>
  );
}

/** Account cell: workspace name over the owner's email, both truncating. */
export function AccountCell({
  workspaceName,
  email,
  userId,
}: {
  workspaceName: string | null;
  email: string | null;
  userId?: string | null;
}) {
  return (
    <span className="block min-w-0" title={userId ?? undefined}>
      <span className="block truncate font-semibold">{workspaceName || "Unnamed workspace"}</span>
      <span className="block truncate text-xs text-muted-foreground">{email || "—"}</span>
    </span>
  );
}

