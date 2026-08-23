// Sticky right-hand table of contents (spec Part C §4 for Billing, §41 for
// Workspace Settings). One implementation so both pages scroll and highlight
// identically.
//
// The list is data-driven: a page declares its sections once and both the nav and
// the anchors come from that array, so a section can never appear in the TOC
// without existing on the page.

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TocItem {
  /** Anchor id, also the hash fragment. */
  id: string;
  label: string;
}

/**
 * Two-column shell: content on the left, sticky nav on the right. Below `xl` the
 * nav is dropped rather than stacked — it is navigation, not content.
 */
export function TocLayout({ sections, children }: { sections: TocItem[]; children: ReactNode }) {
  const active = useActiveSection(sections);

  return (
    <div className="mx-auto flex w-full max-w-[1160px] gap-10">
      <div className="min-w-0 flex-1">{children}</div>
      <aside className="hidden w-[184px] shrink-0 xl:block">
        <nav
          aria-label="On this page"
          className="sticky top-[calc(var(--shell-topbar)+24px)] flex flex-col gap-px border-l border-border"
        >
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={cn(
                "-ml-px border-l py-1 pl-3 text-[12px] leading-relaxed transition-colors duration-150",
                active === section.id
                  ? "border-brand-strong text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {section.label}
            </a>
          ))}
        </nav>
      </aside>
    </div>
  );
}

/** Id of the section nearest the top of the viewport, for the TOC highlight. */
function useActiveSection(sections: TocItem[]): string | null {
  const [active, setActive] = useState<string | null>(sections[0]?.id ?? null);
  const key = sections.map((s) => s.id).join(",");

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    const onScroll = () => {
      let current = ids[0] ?? null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        // 96px lookahead keeps the heading you just scrolled to highlighted.
        if (el.getBoundingClientRect().top - 96 <= 0) current = id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [key]);

  return active;
}

/** One anchored block. `scroll-mt` clears the fixed top bar when jumping. */
export function TocSection({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-[calc(var(--shell-topbar)+24px)] border-t border-border pt-7 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-medium leading-tight text-foreground">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-[620px] text-[12px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
