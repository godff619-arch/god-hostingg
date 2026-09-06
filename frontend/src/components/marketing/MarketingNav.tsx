// Public site chrome — the header a visitor meets before there is any session.
//
// Deliberately not the app's `TopHeader`: that one belongs to the signed-in shell
// (workspace switcher, command palette, user menu) and none of it means anything
// to someone who has not signed up. What is shared is the design language —
// white plane, hairline border, 13px labels, the same brand blue.
//
// Every link here goes somewhere that works without a session: in-page anchors,
// sign-in, and whichever signup route is actually open. Nothing points at the
// authenticated app, because a guest clicking that would just be bounced back.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface MarketingNavProps {
  platformName: string;
  /** Where "Get started" goes, or null when signups are closed. */
  signupHref: string | null;
  /** A signed-in visitor gets a way back into the product instead of "Sign in". */
  signedIn: boolean;
}

const LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export function MarketingNav({ platformName, signupHref, signedIn }: MarketingNavProps) {
  const [open, setOpen] = useState(false);
  /** Border only appears once the page has moved, so the hero starts borderless. */
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The mobile sheet is fixed and covers the page; letting the body scroll under
  // it is the classic bug where the menu drifts away from its own trigger.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 bg-header/95 backdrop-blur-sm transition-shadow duration-200",
        scrolled ? "border-b border-border" : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:h-16 sm:px-6 lg:px-8">
        <Link to="/" className="flex items-center gap-2.5 press">
          <BrandLogo className="h-8 w-8 rounded-lg" />
          <span className="text-[15px] font-semibold tracking-tight text-foreground">
            {platformName}
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {signedIn ? (
            <Button asChild size="sm">
              <Link to="/projects">Open dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link to="/sign-in">Sign in</Link>
              </Button>
              {signupHref && (
                <Button asChild size="sm">
                  <Link to={signupHref}>Get started</Link>
                </Button>
              )}
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="press flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-secondary md:hidden"
        >
          {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-border bg-card px-4 pb-4 pt-2 md:hidden">
          <nav className="flex flex-col">
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
            {signedIn ? (
              <Button asChild className="h-10">
                <Link to="/projects" onClick={() => setOpen(false)}>
                  Open dashboard
                </Link>
              </Button>
            ) : (
              <>
                {signupHref && (
                  <Button asChild className="h-10">
                    <Link to={signupHref} onClick={() => setOpen(false)}>
                      Get started
                    </Link>
                  </Button>
                )}
                <Button asChild variant="outline" className="h-10">
                  <Link to="/sign-in" onClick={() => setOpen(false)}>
                    Sign in
                  </Link>
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
