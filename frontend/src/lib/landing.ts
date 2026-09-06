// The homepage's data contract with `GET /api/public/landing`.
//
// Unauthenticated: a visitor has no token, so this uses plain `fetch` rather than
// `authFetch` (which would attach nothing and route a 401 through the session
// handler). Everything here comes from the database — the plan catalogue behind
// Admin → Plans and the live feature-flag map — so the marketing page cannot
// advertise a price nobody is charged or a capability the operator switched off.

import { API_URL } from "@/lib/utils";

export interface PublicPlanLimits {
  ram_mb: number | null;
  cpus_milli: number | null;
  storage_mb: number | null;
  max_apps: number | null;
  max_domains: number | null;
  max_backups: number | null;
  max_members: number | null;
  max_databases: number | null;
  bandwidth_gb: number | null;
  instance_hours: number | null;
}

export interface PublicPlan {
  key: string;
  name: string;
  description: string | null;
  price_cents: number;
  price_yearly_cents: number | null;
  currency: string;
  interval: string;
  highlighted: boolean;
  trial_days: number;
  benefits: string[];
  limits: PublicPlanLimits;
}

export interface LandingData {
  platform_name: string;
  /** False when Admin → Settings has closed signups; the CTA must respect it. */
  registration_enabled: boolean;
  /** False on a fresh install — the first account claims the server. */
  setup_complete: boolean;
  /** Live feature flags, keyed as in lib/featureFlags.ts. */
  features: Record<string, boolean>;
  plans: PublicPlan[];
}

export async function fetchLanding(): Promise<LandingData> {
  const res = await fetch(`${API_URL}/api/public/landing`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * `$19`, `$19.50`, `Free`. Cents are only printed when they are not zero — a
 * pricing card full of `.00` reads like a spreadsheet.
 */
export function planPrice(cents: number, currency = "USD"): string {
  if (cents <= 0) return "Free";
  const symbol = currency.toUpperCase() === "USD" ? "$" : "";
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  const amount = rest === 0 ? `${whole}` : `${whole}.${String(rest).padStart(2, "0")}`;
  return symbol ? `${symbol}${amount}` : `${amount} ${currency.toUpperCase()}`;
}

/** `null` means unmetered in the plan catalogue, which reads as "Unlimited". */
export function planLimit(value: number | null, unit?: string): string {
  if (value === null) return "Unlimited";
  const n = value.toLocaleString("en-US");
  return unit ? `${n} ${unit}` : n;
}
