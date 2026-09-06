// Auth context provider - manages authentication state across the app

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { API_URL } from "@/lib/utils";
import { registerAuthUnauthorizedHandler } from "@/lib/auth";
import { invalidateAdminMe } from "@/hooks/useAdminMe";
import { Loader2 } from "lucide-react";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (token: string, user: User) => void;
  updateUser: (user: User) => void;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

// Routes that render without a session.
//
// `/` (the public homepage) is deliberately NOT in this list: the check below is
// a `startsWith`, and `"/"` is a prefix of every path in the app — adding it here
// would make the entire product public. It is matched exactly instead.
const authRoutes = ["/sign-in", "/sign-up", "/setup"];

/**
 * Public, but a signed-in visitor is allowed to stay — unlike `authRoutes`, which
 * bounce a live session to the dashboard. `/admin/login` belongs here because it
 * decides for itself where an operator lands (the panel) and what to tell an
 * account with no admin role; being kicked to `/projects` would hide both.
 */
const standalonePublicRoutes = ["/admin/login"];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialCheckDone, setInitialCheckDone] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const isAuthRoute = authRoutes.some((route) => pathname.startsWith(route));
  // Needs no session. The homepage belongs here, but unlike the auth pages a
  // signed-in visitor is allowed to stay on it, so the two are kept apart.
  const isPublicRoute =
    isAuthRoute || pathname === "/" || standalonePublicRoutes.includes(pathname);

  // Initialize auth state from localStorage
  useEffect(() => {
    const initAuth = async () => {
      const storedToken = localStorage.getItem("docklift_token");
      const storedUser = localStorage.getItem("docklift_user");

      if (storedToken && storedUser) {
        // Set token immediately to prevent flicker
        setToken(storedToken);
        try {
          setUser(JSON.parse(storedUser));
        } catch {
          // Invalid stored user
        }

        // Verify token is still valid in background
        try {
          const res = await fetch(`${API_URL}/api/auth/me`, {
            headers: { Authorization: `Bearer ${storedToken}` },
          });

          if (res.ok) {
            const data = await res.json();
            setUser(data.user);
          } else {
            // Token invalid, clear storage
            localStorage.removeItem("docklift_token");
            localStorage.removeItem("docklift_user");
            setToken(null);
            setUser(null);
          }
        } catch (error) {
          console.error("Auth verification failed:", error);
        }
      }

      setLoading(false);
      setInitialCheckDone(true);
    };

    initAuth();
  }, []);

  // Handle redirects after initial check
  useEffect(() => {
    if (!initialCheckDone) return;

    const handleRedirects = async () => {
      // Signed in and sitting on a sign-in / sign-up / setup form → the
      // dashboard. `/projects`, not `/`: `/` is the marketing homepage now, and
      // bouncing a session onto it would hide the app behind its own front door.
      if (token && isAuthRoute) {
        navigate("/projects", { replace: true });
        return;
      }

      // If not authenticated and not on public route, check setup status
      if (!token && !isPublicRoute) {
        // The admin panel has its own front door. Sending an operator whose
        // session expired to `/sign-in` would sign them back in and drop them on
        // `/projects`, with no sign of where the panel went.
        const signIn = pathname.startsWith("/admin") ? "/admin/login" : "/sign-in";
        try {
          const res = await fetch(`${API_URL}/api/auth/status`);
          const data = await res.json();

          if (!data.setupComplete) {
            navigate("/setup", { replace: true });
          } else {
            navigate(signIn, { replace: true });
          }
        } catch (error) {
          navigate(signIn, { replace: true });
        }
      }
    };

    handleRedirects();
  }, [initialCheckDone, token, isAuthRoute, isPublicRoute, pathname, navigate]);

  const login = (newToken: string, newUser: User) => {
    localStorage.setItem("docklift_token", newToken);
    localStorage.setItem("docklift_user", JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  };

  const updateUser = (newUser: User) => {
    localStorage.setItem("docklift_user", JSON.stringify(newUser));
    setUser(newUser);
  };

  const logout = useCallback(() => {
    localStorage.removeItem("docklift_token");
    localStorage.removeItem("docklift_user");
    setToken(null);
    setUser(null);
    // Drop the cached admin profile: without this, the next operator to sign in
    // in this tab inherits the previous one's permission list until a reload.
    invalidateAdminMe();
    // Read the path at call time rather than closing over it, so this callback
    // keeps a stable identity for registerAuthUnauthorizedHandler.
    const onAdmin = window.location.pathname.startsWith("/admin");
    navigate(onAdmin ? "/admin/login" : "/sign-in");
  }, [navigate]);

  useEffect(() => {
    registerAuthUnauthorizedHandler(logout);
  }, [logout]);

  // Show loading only for protected routes during initial check
  if (loading && !isPublicRoute) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        login,
        updateUser,
        logout,
        isAuthenticated: !!token,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

