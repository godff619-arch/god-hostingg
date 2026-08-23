// <PlanGate /> — one place decides what a locked feature looks like (spec §65–66).
//
// Which tier unlocks which feature is decided by the server: `GET /api/workspace`
// returns a resolved `features` map, and a gated endpoint answers 403 with
// `PLAN_LOCKED` + `required_plan`. This component only renders that answer, so no
// page hardcodes "webhooks need Pro".

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Lock, Zap } from "lucide-react";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import type { FeatureKey, PlanTier } from "@/lib/workspaceTypes";

const TIER_LABEL: Record<PlanTier, string> = {
  hobby: "Hobby",
  pro: "Pro",
  scale: "Scale",
};

/** Small uppercase tier chip, e.g. the `[PRO]` badge next to a page title. */
export function PlanBadge({ tier }: { tier: PlanTier }) {
  return (
    <span className="inline-flex items-center rounded-[3px] border border-brand-strong bg-brand/25 px-1.5 py-[2px] text-[10px] font-medium uppercase tracking-[0.09em] text-foreground">
      {TIER_LABEL[tier]}
    </span>
  );
}

/**
 * The purple locked card. `required` is only used for copy — the decision to show
 * this at all comes from the workspace `features` map.
 */
export function PlanLockedCard({
  feature,
  required,
  current,
  children,
}: {
  feature: string;
  required: PlanTier;
  current?: PlanTier;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-brand-strong bg-brand/25 p-5">
      <div className="flex items-center gap-2">
        <Lock className="h-3.5 w-3.5 text-foreground" strokeWidth={1.75} />
        <PlanBadge tier={required} />
      </div>
      <h2 className="mt-2.5 text-[15px] font-medium text-foreground">
        {feature} is available on {TIER_LABEL[required]}
      </h2>
      <p className="mt-1 max-w-[560px] text-[12px] leading-relaxed text-muted-foreground">
        {current
          ? `This workspace is on ${TIER_LABEL[current]}. Upgrade to ${TIER_LABEL[required]} to turn ${feature.toLowerCase()} on.`
          : `Upgrade to ${TIER_LABEL[required]} to turn ${feature.toLowerCase()} on.`}
      </p>
      {children ? <div className="mt-3">{children}</div> : null}
      <Link
        to="/billing"
        className="mt-4 inline-flex h-8 items-center gap-2 rounded-md border border-border bg-transparent px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
      >
        <Zap className="h-3.5 w-3.5" strokeWidth={1.75} />
        Upgrade to use {feature.toLowerCase()}
      </Link>
    </div>
  );
}

/**
 * Renders `children` when the workspace has the feature, the locked card when it
 * does not. While the workspace is still loading it renders nothing rather than
 * flashing a lock the caller may well be entitled to.
 */
export function PlanGate({
  feature,
  label,
  required,
  children,
  preview,
}: {
  feature: FeatureKey;
  /** Human name used in the locked copy, e.g. "Webhooks". */
  label: string;
  /** Tier shown in the badge. The server owns the real rule. */
  required: PlanTier;
  children: ReactNode;
  /** Optional teaser (use-case cards) rendered inside the locked card. */
  preview?: ReactNode;
}) {
  const { can, workspace, loading } = useWorkspace();

  if (loading && !workspace) {
    return <div className="h-24 animate-pulse rounded-md border border-border bg-secondary/40" />;
  }
  if (can(feature)) return <>{children}</>;

  return (
    <PlanLockedCard feature={label} required={required} current={workspace?.plan.key}>
      {preview}
    </PlanLockedCard>
  );
}
