// Brand logo mark. Prefers /logo.png (drop one in public/ to override) and
// falls back to the bundled SVG if the PNG is missing.
import { useState } from "react";
import { APP_LOGO_PNG, APP_LOGO_SVG, APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function BrandLogo({ className }: { className?: string }) {
  const [src, setSrc] = useState(APP_LOGO_PNG);
  return (
    <img
      src={src}
      alt={APP_NAME}
      onError={() => {
        if (src !== APP_LOGO_SVG) setSrc(APP_LOGO_SVG);
      }}
      className={cn("object-contain", className)}
    />
  );
}
