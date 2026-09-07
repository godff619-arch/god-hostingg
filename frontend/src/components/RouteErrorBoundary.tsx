import { useEffect } from "react";
import { useRouteError, isRouteErrorResponse } from "react-router-dom";

export default function RouteErrorBoundary() {
  const error = useRouteError();

  useEffect(() => {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes("Failed to fetch dynamically imported module") ||
      msg.includes("Importing a module script failed") ||
      msg.includes("error loading dynamically imported module")
    ) {
      // Chunk hash mismatch after deploy — reload to get the new manifest
      window.location.reload();
    }
  }, [error]);

  if (isRouteErrorResponse(error)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <h1 className="text-4xl font-bold text-foreground">{error.status}</h1>
          <p className="mt-2 text-muted-foreground">{error.statusText}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  const message =
    error instanceof Error ? error.message : "An unexpected error occurred.";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
