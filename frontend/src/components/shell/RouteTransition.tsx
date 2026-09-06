// Route entrance + navigation progress, shared by both shells.
//
// Before this, a route arrived in a single frame: the old page was there, then the
// new one was, fully formed. With every page behind a lazy chunk that also meant a
// dead interval after the click where nothing on screen acknowledged it — long
// enough on a slow link that the natural response is to click again.
//
// Two pieces, deliberately separate:
//   • RouteProgress — a 2px indeterminate bar while the router is fetching. It
//     answers "did my click register", which is a different question from "is the
//     data loaded" (that one is the page's own skeleton).
//   • RouteTransition — the 260ms rise the new page enters on.

import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigation } from "react-router-dom";

/**
 * The bar only appears once a navigation has been slow enough to notice.
 *
 * A cached chunk resolves in single-digit milliseconds; showing the bar for those
 * would put a flicker at the top of the screen on every single click, which is
 * more distracting than the silence it was meant to fix.
 */
const SHOW_AFTER_MS = 140;

export function RouteProgress() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!busy) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);

  return (
    <div
      aria-hidden={!visible}
      className={`pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5 overflow-hidden transition-opacity duration-200 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      {/* Only mounted while visible, so the infinite animation is not left
          running behind an opacity-0 element on every idle page. */}
      {visible && <div className="route-progress-bar h-full w-full bg-brand" />}
    </div>
  );
}

/**
 * Wraps the routed page so it rises in.
 *
 * Keyed on `pathname`, which is what makes the animation replay: without the key
 * React reuses the same DOM node across navigations and a CSS animation on an
 * already-mounted element does not restart. The key also means a params-only
 * change (`/admin/users/a` → `/admin/users/b`) remounts, so the second account
 * never renders for a frame with the first one's data still in state.
 */
export function RouteTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <div key={pathname} className="page-enter">
      {children}
    </div>
  );
}
