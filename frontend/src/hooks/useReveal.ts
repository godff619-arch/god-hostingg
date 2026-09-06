// Scroll reveal, shared by every marketing section.
//
// One IntersectionObserver per element, disconnected the moment it fires: a
// section animates in once and then costs nothing. `prefers-reduced-motion` and
// browsers without IntersectionObserver skip straight to the visible state, so
// content is never gated behind an animation that will not run.

import { useEffect, useRef, useState } from "react";

export function useReveal<T extends HTMLElement = HTMLDivElement>(options?: {
  /** Fraction of the element that must be on screen. */
  threshold?: number;
  /** Shift the trigger line up so a section starts before it is fully in view. */
  rootMargin?: string;
}) {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    // Already on screen at mount (the hero, or a deep link to an anchor): reveal
    // without waiting for a scroll that may never come.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: options?.threshold ?? 0.12, rootMargin: options?.rootMargin ?? "0px 0px -8% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [options?.threshold, options?.rootMargin]);

  return { ref, shown };
}
