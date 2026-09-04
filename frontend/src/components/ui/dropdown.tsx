// Lightweight dropdown menu. `@radix-ui/react-dropdown-menu` is not a dependency
// here, so this keeps the surface small: click / Escape / outside-click to close
// and a flat Render-style panel.
//
// The panel is portalled to `document.body` and positioned with `fixed`
// coordinates measured off the trigger. It has to be: menus are used inside
// tables wrapped in `overflow-x-auto`, and CSS resolves the cross axis of a
// scroll container to `auto` too — so an `absolute` panel gets clipped at the
// table's bottom edge and rows near the end of a table lose their actions
// entirely. No z-index can escape a clipping ancestor; only leaving it can.

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** Trigger-to-panel offset, and the smallest gap kept to the viewport edge. */
const GAP = 6;
const EDGE = 8;

interface PanelPosition {
  top: number;
  left?: number;
  right?: number;
  maxHeight: number;
}

interface DropdownProps {
  /** Rendered inside a button; receives the open state for chevron rotation. */
  trigger: (open: boolean) => React.ReactNode;
  children: React.ReactNode;
  /** Panel alignment relative to the trigger. */
  align?: "start" | "end";
  className?: string;
  triggerClassName?: string;
  label?: string;
}

export function Dropdown({
  trigger,
  children,
  align = "start",
  className,
  triggerClassName,
  label,
}: DropdownProps) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<PanelPosition | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const place = React.useCallback(() => {
    const anchor = rootRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const height = panelRef.current?.offsetHeight ?? 0;
    // `clientWidth/Height`, not `innerWidth/Height`: a fixed element's offsets are
    // measured against the viewport minus scrollbars, so using `innerWidth` would
    // push every `align="end"` menu left by the scrollbar's width.
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const below = vh - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    // Flip up only when the panel truly does not fit below and fits better above.
    const flip = height > below && above > below;
    setPos({
      top: flip ? Math.max(EDGE, rect.top - GAP - height) : rect.bottom + GAP,
      ...(align === "end"
        ? { right: Math.max(EDGE, vw - rect.right) }
        : { left: Math.max(EDGE, rect.left) }),
      maxHeight: Math.max(140, flip ? above : below),
    });
  }, [align]);

  // Layout effect so the measured position is applied before paint (the first
  // pass renders hidden purely so the panel can be measured).
  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel no longer lives inside the root, so it needs its own check.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Capture phase: the trigger may sit inside a scrolling table, whose scroll
    // events never reach the document in the bubble phase.
    const onScroll = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md text-[13px] text-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring",
          triggerClassName,
        )}
      >
        {trigger(open)}
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              // Closing on click delegates to the item; every item is a button or link.
              onClick={() => setOpen(false)}
              style={{
                position: "fixed",
                top: pos?.top ?? 0,
                left: pos?.left,
                right: pos?.right,
                maxHeight: pos?.maxHeight,
                // Hidden for the measuring pass only — still laid out, so the
                // panel's real height is known before it becomes visible.
                visibility: pos ? "visible" : "hidden",
              }}
              className={cn(
                "z-50 min-w-[212px] overflow-y-auto rounded-md border border-border bg-card py-1 shadow-[0_12px_32px_-12px_rgba(15,23,42,0.25)]",
                className,
              )}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** A menu row. Renders as a button unless `as` is provided (e.g. Link). */
export function DropdownItem({
  className,
  icon,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {icon ? <span className="flex h-3.5 w-3.5 items-center justify-center text-muted-foreground">{icon}</span> : null}
      <span className="truncate">{children}</span>
    </button>
  );
}

export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
      {children}
    </div>
  );
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}
