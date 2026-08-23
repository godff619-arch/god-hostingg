// Theme provider. The product is dark-only (Render-style near-black palette), so
// this pins `.dark` on <html> and ignores OS preference. The context is kept so the
// existing `useTheme()` call sites keep compiling; `setTheme` is a no-op.

import { createContext, useContext, useEffect } from "react";

type Theme = "dark";

type ThemeContextType = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "dark";
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const VALUE: ThemeContextType = {
  theme: "dark",
  setTheme: () => {},
  resolvedTheme: "dark",
};

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light");
    root.classList.add("dark");
    root.style.colorScheme = "dark";
    // A stale `theme=light` from an older build must not survive a reload.
    try {
      localStorage.setItem("theme", "dark");
    } catch {
      /* private mode / storage disabled — the class above is what matters */
    }
  }, []);

  return <ThemeContext.Provider value={VALUE}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext) ?? VALUE;
}
