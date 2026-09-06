// Pick an account (workspace) to act on.
//
// There is no dedicated workspace-search endpoint, and adding one would duplicate
// a query that already exists: `GET /subscriptions?q=` searches workspace id,
// name, billing email and owner name/email, and returns the same seven account
// keys every money row carries. So this reuses it rather than inventing a second
// search with slightly different matching rules.
//
// Deliberately not a `<select>`: the platform can hold thousands of workspaces,
// and §42 says not to load them all. This types a query, waits 300 ms, and shows
// the first ten matches.

import { useEffect, useState } from "react";
import { Check, Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { adminGet } from "@/lib/adminApi";
import type { SubscriptionsResponse } from "@/lib/adminBillingTypes";
import { cn } from "@/lib/utils";

export interface PickedAccount {
  workspace_id: string;
  workspace_name: string | null;
  user_email: string | null;
  plan_name: string;
}

export function AccountPicker({
  value,
  onChange,
}: {
  value: PickedAccount | null;
  onChange: (account: PickedAccount | null) => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<PickedAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (value) return;
    const q = term.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      adminGet<SubscriptionsResponse>(
        `/subscriptions?q=${encodeURIComponent(q)}&pageSize=10`,
      )
        .then((res) =>
          setResults(
            res.subscriptions
              .filter((s): s is typeof s & { workspace_id: string } => Boolean(s.workspace_id))
              .map((s) => ({
                workspace_id: s.workspace_id,
                workspace_name: s.workspace_name,
                user_email: s.user_email,
                plan_name: s.plan_name,
              })),
          ),
        )
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [term, value]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border-2 border-brand/30 bg-brand/5 px-3 py-2.5">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">
            {value.workspace_name || "Unnamed workspace"}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {value.user_email || value.workspace_id} · {value.plan_name}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            onChange(null);
            setTerm("");
            setResults([]);
          }}
          aria-label="Choose a different account"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        <Input
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setTouched(true);
          }}
          placeholder="Search workspace name, owner email or id…"
          className="pl-9"
        />
      </div>

      {results.length > 0 && (
        <ul className="max-h-52 overflow-y-auto rounded-xl border border-border/60">
          {results.map((r) => (
            <li key={r.workspace_id}>
              <button
                type="button"
                onClick={() => onChange(r)}
                className={cn(
                  "flex w-full items-center gap-2 border-b border-border/40 px-3 py-2 text-left last:border-b-0",
                  "hover:bg-secondary",
                )}
              >
                <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {r.workspace_name || "Unnamed workspace"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.user_email || r.workspace_id}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {touched && !loading && term.trim().length >= 2 && results.length === 0 && (
        <p className="text-xs text-muted-foreground">No account matches “{term.trim()}”.</p>
      )}
    </div>
  );
}
