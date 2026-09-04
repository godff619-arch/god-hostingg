// Theme provider. The product is light-only (Stripe/Linear-style palette), so
// this pins `.light` on <html> and ignores OS preference. The context is kept so
// the existing `useTheme()` call sites keep compiling; `setTheme` is a no-op.
//
// `resolvedTheme` is what TerminalView and LogViewer read to pick their xterm /
// ANSI palettes, so it has to be the truth rather than a constant left over from
// the previous palette.

import { createContext, useContext, useEffect } from "react";

type Theme = "light";

type ThemeContextType = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "light";
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const VALUE: ThemeContextType = {
  theme: "light",
  setTheme: () => {},
  resolvedTheme: "light",
};

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("dark");
    root.classList.add("light");
    root.style.colorScheme = "light";
    // A stale `theme=dark` from an older build must not survive a reload.
    try {
      localStorage.setItem("theme", "light");
    } catch {
      /* private mode / storage disabled — the class above is what matters */
    }
  }, []);

  return <ThemeContext.Provider value={VALUE}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext) ?? VALUE;
}
