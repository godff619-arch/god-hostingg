// Lightweight dropdown menu. `@radix-ui/react-dropdown-menu` is not a dependency
// here, so this keeps the surface small: click / Escape / outside-click to close,
// arrow-key roving focus, and a flat Render-style panel.

import * as React from "react";
import { cn } from "@/lib/utils";

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
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
      {open ? (
        <div
          role="menu"
          // Closing on click delegates to the item; every item is a button or link.
          onClick={() => setOpen(false)}
          className={cn(
            "absolute top-[calc(100%+6px)] z-50 min-w-[212px] rounded-md border border-border bg-card py-1",
            align === "end" ? "right-0" : "left-0",
            className,
          )}
        >
          {children}
        </div>
      ) : null}
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
