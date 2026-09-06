// Reveal — the marketing pages' only animation primitive.
//
// Wraps children in a div that fades and lifts into place when it scrolls into
// view. `delay` staggers siblings (a grid of cards reads better arriving in
// sequence than all at once) and is capped low on purpose: past ~250ms a stagger
// stops feeling like polish and starts feeling like the page is slow.
//
// The animation is CSS-only — no layout thrash, and `motion-reduce` variants mean
// a visitor who asked for less motion gets the final state immediately.

import type { ElementType, ReactNode } from "react";
import { useReveal } from "@/hooks/useReveal";
import { cn } from "@/lib/utils";

interface RevealProps {
  children: ReactNode;
  /** Stagger in ms, 0–250. */
  delay?: number;
  className?: string;
  /** Render as a semantic element (`section`, `li`, …) instead of a div. */
  as?: ElementType;
}

export function Reveal({ children, delay = 0, className, as: Tag = "div" }: RevealProps) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <Tag
      ref={ref}
      style={shown && delay ? { transitionDelay: `${Math.min(delay, 250)}ms` } : undefined}
      className={cn(
        "transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none",
        shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
        // A visitor who asked for less motion should never see a blank section,
        // even if the observer never fires.
        "motion-reduce:translate-y-0 motion-reduce:opacity-100",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
