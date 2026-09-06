"use client";

import { useTheme } from "@/lib/theme";
import {
  CheckCircle2,
  CircleAlert,
  Info,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Global notifications — compact, flat, light (spec §76). Top-center so they stay
 * visible above sticky footers and work from any page.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  useTheme();

  return (
    <Sonner
      theme="light"
      position="top-center"
      expand={false}
      closeButton
      duration={4200}
      gap={8}
      offset={14}
      visibleToasts={3}
      className="toaster group"
      icons={{
        success: <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={2} />,
        error: <CircleAlert className="h-4 w-4 shrink-0" strokeWidth={2} />,
        warning: <TriangleAlert className="h-4 w-4 shrink-0" strokeWidth={2} />,
        info: <Info className="h-4 w-4 shrink-0" strokeWidth={2} />,
        loading: <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={2} />,
        close: <X className="h-3 w-3" strokeWidth={2} />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast godhosting-toast group-[.toaster]:pointer-events-auto " +
            "group-[.toaster]:w-[min(100vw-1.5rem,24rem)] " +
            "group-[.toaster]:rounded-md group-[.toaster]:border group-[.toaster]:px-3 " +
            "group-[.toaster]:py-2.5 group-[.toaster]:gap-2.5 group-[.toaster]:font-sans " +
            "group-[.toaster]:bg-card group-[.toaster]:text-foreground " +
            "group-[.toaster]:border-border " +
            "group-[.toaster]:shadow-[0_4px_14px_0_rgba(15,23,42,0.08)]",
          success:
            "group-[.toaster]:!bg-success-surface group-[.toaster]:!border-success-border " +
            "group-[.toaster]:!text-foreground",
          error:
            "group-[.toaster]:!bg-danger-surface group-[.toaster]:!border-danger-border " +
            "group-[.toaster]:!text-foreground",
          warning:
            "group-[.toaster]:!bg-warning-surface group-[.toaster]:!border-warning-border " +
            "group-[.toaster]:!text-foreground",
          info:
            "group-[.toaster]:!bg-card group-[.toaster]:!border-border " +
            "group-[.toaster]:!text-foreground",
          loading:
            "group-[.toaster]:!bg-secondary group-[.toaster]:!border-border " +
            "group-[.toaster]:!text-foreground",
          title:
            "group-[.toast]:text-[13px] group-[.toast]:font-medium group-[.toast]:leading-snug",
          description:
            "group-[.toast]:text-[12px] group-[.toast]:leading-relaxed group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:rounded group-[.toast]:bg-foreground group-[.toast]:px-2.5 " +
            "group-[.toast]:text-[12px] group-[.toast]:font-medium group-[.toast]:text-background",
          cancelButton:
            "group-[.toast]:rounded group-[.toast]:bg-secondary group-[.toast]:px-2.5 " +
            "group-[.toast]:text-[12px] group-[.toast]:font-medium group-[.toast]:text-muted-foreground",
          closeButton:
            "group-[.toast]:border-border group-[.toast]:bg-card " +
            "group-[.toast]:text-muted-foreground group-[.toast]:hover:text-foreground " +
            "group-[.toast]:hover:bg-secondary",
          icon: "group-[.toast]:mt-0.5",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
