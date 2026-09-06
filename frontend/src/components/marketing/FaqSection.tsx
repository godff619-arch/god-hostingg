// FAQ — the questions a first-time visitor actually has, answered with what the
// platform does today. No aspirational answers: every claim here matches a code
// path (Railpack fallback in services/buildRunner.ts, the GitHub/ZIP sources in
// routes/projects.ts, the certificate flow in services/nginx.ts).
//
// A plain button + region rather than a library accordion: it is four items, the
// app has no accordion primitive yet, and one would have to earn its place.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Reveal } from "@/components/marketing/Reveal";
import { cn } from "@/lib/utils";

export interface FaqItem {
  q: string;
  a: string;
}

export function FaqSection({ items }: { items: FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="border-t border-border bg-background py-16 sm:py-24">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <Reveal className="text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">FAQ</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Questions, answered
          </h2>
        </Reveal>

        <div className="mt-10 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {items.map((item, index) => {
            const isOpen = open === index;
            return (
              <Reveal key={item.q} delay={index * 50}>
                <div>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={`faq-panel-${index}`}
                    onClick={() => setOpen(isOpen ? null : index)}
                    className="press flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-secondary/40"
                  >
                    <span className="text-sm font-medium text-foreground">{item.q}</span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                        isOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {/* Grid-row animation, so the panel slides without a hard-coded
                      max-height that would clip a longer answer. */}
                  <div
                    id={`faq-panel-${index}`}
                    className={cn(
                      "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
                      isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                    )}
                  >
                    <div className="overflow-hidden">
                      <p className="px-5 pb-4 text-[13px] leading-relaxed text-muted-foreground">
                        {item.a}
                      </p>
                    </div>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
