// Pricing, straight from the plan catalogue.
//
// Every number on these cards is a `Plan` row: edit a price or a limit in
// Admin → Plans and this changes with it. That is the whole point — a hard-coded
// pricing table is the fastest way to charge someone an amount their homepage
// never showed them (§53, and §61's "the backend is the source of truth").
//
// The yearly toggle is real: it prints `price_yearly_cents` when the operator has
// set one, and hides itself entirely when no plan has a yearly price, rather than
// offering a switch that changes nothing.

import { useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/Reveal";
import { planLimit, planPrice, type PublicPlan } from "@/lib/landing";
import { cn } from "@/lib/utils";

interface PricingSectionProps {
  plans: PublicPlan[];
  /** Null when signups are closed — cards then point at sign-in instead. */
  signupHref: string | null;
}

/** The limits worth putting on a card, in the order a buyer compares them. */
function limitRows(plan: PublicPlan): { label: string; value: string }[] {
  const l = plan.limits;
  return [
    { label: "Services", value: planLimit(l.max_apps) },
    { label: "Custom domains", value: planLimit(l.max_domains) },
    { label: "Bandwidth", value: l.bandwidth_gb === null ? "Unlimited" : planLimit(l.bandwidth_gb, "GB") },
    {
      label: "Instance hours",
      value: l.instance_hours === null ? "Unlimited" : planLimit(l.instance_hours, "hrs / mo"),
    },
  ];
}

export function PricingSection({ plans, signupHref }: PricingSectionProps) {
  const [yearly, setYearly] = useState(false);
  // No plan has a yearly amount → the toggle would be decoration.
  const yearlyOffered = plans.some((p) => (p.price_yearly_cents ?? 0) > 0);

  if (plans.length === 0) return null;

  return (
    <section id="pricing" className="border-t border-border bg-background py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">Pricing</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Start free, pay when you outgrow it
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
            Every tier runs on the same engine. Higher plans raise the ceilings — services,
            domains, bandwidth and build minutes — and unlock the team and audit features.
          </p>
        </Reveal>

        {yearlyOffered && (
          <Reveal delay={80} className="mt-8 flex justify-center">
            <div
              role="group"
              aria-label="Billing interval"
              className="inline-flex items-center rounded-lg border border-border bg-card p-1"
            >
              {(
                [
                  { value: false, label: "Monthly" },
                  { value: true, label: "Yearly" },
                ] as const
              ).map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={yearly === option.value}
                  onClick={() => setYearly(option.value)}
                  className={cn(
                    "press rounded-md px-4 py-1.5 text-[13px] font-medium transition-colors",
                    yearly === option.value
                      ? "bg-brand text-brand-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Reveal>
        )}

        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {plans.map((plan, index) => {
            const yearlyCents = plan.price_yearly_cents;
            const showYearly = yearly && (yearlyCents ?? 0) > 0;
            const amount = showYearly ? (yearlyCents as number) : plan.price_cents;
            // Twelve monthly payments vs the yearly one, straight from the two
            // stored amounts — never a made-up "save 20%".
            const saved =
              yearlyCents && plan.price_cents > 0 ? plan.price_cents * 12 - yearlyCents : 0;

            return (
              <Reveal key={plan.key} delay={index * 70} className="h-full">
                <div
                  className={cn(
                    "flex h-full flex-col rounded-xl border bg-card p-6 card-lift transition-colors",
                    plan.highlighted
                      ? "border-brand/40 ring-1 ring-brand/20"
                      : "border-border hover:border-brand/30",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-semibold text-foreground">{plan.name}</h3>
                    {plan.highlighted && (
                      <span className="rounded-full border border-brand/30 bg-brand/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand">
                        Popular
                      </span>
                    )}
                  </div>

                  <div className="mt-4 flex items-baseline gap-1.5">
                    <span className="text-3xl font-bold tracking-tight text-foreground">
                      {planPrice(amount, plan.currency)}
                    </span>
                    {amount > 0 && (
                      <span className="text-sm text-muted-foreground">
                        / {showYearly ? "year" : plan.interval}
                      </span>
                    )}
                  </div>
                  {showYearly && saved > 0 ? (
                    <p className="mt-1 text-xs font-medium text-success">
                      Saves {planPrice(saved, plan.currency)} against monthly
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-subtle">
                      {plan.trial_days > 0
                        ? `${plan.trial_days}-day trial`
                        : plan.price_cents === 0
                          ? "No card required"
                          : `Billed per ${plan.interval}, cancel any time`}
                    </p>
                  )}

                  {plan.description && (
                    <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
                      {plan.description}
                    </p>
                  )}

                  <dl className="mt-5 space-y-2 border-t border-border pt-5">
                    {limitRows(plan).map((row) => (
                      <div key={row.label} className="flex items-center justify-between gap-3 text-[13px]">
                        <dt className="text-muted-foreground">{row.label}</dt>
                        <dd className="font-medium text-foreground">{row.value}</dd>
                      </div>
                    ))}
                  </dl>

                  {plan.benefits.length > 0 && (
                    <ul className="mt-5 space-y-2 border-t border-border pt-5">
                      {plan.benefits.map((benefit) => (
                        <li key={benefit} className="flex items-start gap-2 text-[13px] text-muted-foreground">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                          <span className="leading-relaxed">{benefit}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-6 flex-1" />
                  <Button
                    asChild
                    variant={plan.highlighted ? "default" : "outline"}
                    className="h-10 w-full"
                  >
                    <Link to={signupHref ?? "/sign-in"}>
                      {signupHref
                        ? plan.price_cents > 0
                          ? `Choose ${plan.name}`
                          : "Start for free"
                        : "Sign in to continue"}
                    </Link>
                  </Button>
                </div>
              </Reveal>
            );
          })}
        </div>

        <Reveal delay={120}>
          {/* Both halves of this are what the API actually does: an upgrade returns
              CHECKOUT_REQUIRED, and a downgrade cancels at period end rather than
              taking the plan away immediately. */}
          <p className="mt-6 text-center text-xs leading-relaxed text-subtle">
            Plans are billed per workspace. Upgrading starts a checkout; downgrading keeps the
            plan you already paid for until the current period ends.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
