// Public footer. Only links that work without a session: page anchors and the two
// auth routes. The signed-in dashboard link is not here — a guest clicking it
// would be bounced to sign-in, which is exactly the dead-end this homepage exists
// to remove.

import { Link } from "react-router-dom";
import { BrandLogo } from "@/components/BrandLogo";

interface MarketingFooterProps {
  platformName: string;
  signupHref: string | null;
}

export function MarketingFooter({ platformName, signupHref }: MarketingFooterProps) {
  return (
    <footer className="border-t border-border bg-card">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xs">
            <div className="flex items-center gap-2.5">
              <BrandLogo className="h-7 w-7 rounded-lg" />
              <span className="text-sm font-semibold tracking-tight text-foreground">
                {platformName}
              </span>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Container hosting you run yourself. Push code, get a URL — on your own server,
              with your own domains.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:gap-14">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-subtle">
                Product
              </p>
              <ul className="mt-3 space-y-2 text-[13px]">
                <li>
                  <a href="#how" className="text-muted-foreground transition-colors hover:text-foreground">
                    How it works
                  </a>
                </li>
                <li>
                  <a
                    href="#features"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Features
                  </a>
                </li>
                <li>
                  <a
                    href="#pricing"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Pricing
                  </a>
                </li>
                <li>
                  <a href="#faq" className="text-muted-foreground transition-colors hover:text-foreground">
                    FAQ
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-subtle">
                Account
              </p>
              <ul className="mt-3 space-y-2 text-[13px]">
                <li>
                  <Link
                    to="/sign-in"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Sign in
                  </Link>
                </li>
                {signupHref && (
                  <li>
                    <Link
                      to={signupHref}
                      className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Create account
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-8 border-t border-border pt-6">
          <p className="text-xs text-subtle">
            © {new Date().getFullYear()} {platformName}. Self-hosted on your own infrastructure.
          </p>
        </div>
      </div>
    </footer>
  );
}
