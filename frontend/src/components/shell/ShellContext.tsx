// Shell state shared by the sidebar, header and search modal.
//
// The rail is a fixed 228px on desktop (Render geometry) and a drawer below
// `lg`, so there is no desktop collapse state to persist.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";

interface ShellContextValue {
  /** Mobile drawer visibility. */
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  /** ⌘K / Ctrl+K search modal. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Human label for the last breadcrumb, so ids never surface in the UI. */
  breadcrumbLeaf: string | null;
  setBreadcrumbLeaf: (label: string | null) => void;
}

const ShellContext = createContext<ShellContextValue | undefined>(undefined);

export function useShell(): ShellContextValue {
  const context = useContext(ShellContext);
  if (!context) throw new Error("useShell must be used within ShellProvider");
  return context;
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [breadcrumbLeaf, setBreadcrumbLeaf] = useState<string | null>(null);
  const { pathname } = useLocation();

  // Navigating always dismisses the mobile drawer and the search modal, and drops
  // the previous page's breadcrumb label.
  useEffect(() => {
    setMobileOpen(false);
    setPaletteOpen(false);
    setBreadcrumbLeaf(null);
  }, [pathname]);

  // The drawer is an overlay, so the page behind it must not scroll.
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      // ⌘K and the bare "/" both open search (spec: `⌕ Search ⌘/K`).
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "/" && !meta && !isTypingTarget(event.target)) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(
    () => ({
      mobileOpen,
      setMobileOpen,
      paletteOpen,
      setPaletteOpen,
      breadcrumbLeaf,
      setBreadcrumbLeaf,
    }),
    [mobileOpen, paletteOpen, breadcrumbLeaf],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** "/" must stay a literal slash while the user is typing into a field. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Names the current page in the breadcrumb trail. Safe to call with a value that
 * is only known after a fetch — pass undefined until then.
 */
export function useBreadcrumbLeaf(label?: string | null) {
  const { setBreadcrumbLeaf } = useShell();
  useEffect(() => {
    if (!label) return;
    setBreadcrumbLeaf(label);
    return () => setBreadcrumbLeaf(null);
  }, [label, setBreadcrumbLeaf]);
}
