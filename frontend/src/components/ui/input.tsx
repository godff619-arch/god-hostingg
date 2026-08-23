import * as React from "react";
import { cn } from "@/lib/utils";

// Dense, flat field: 1px #303030 border, near-black fill, 6px radius.
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] text-foreground transition-colors duration-150 file:border-0 file:bg-transparent file:text-[13px] file:font-medium placeholder:text-subtle focus:border-brand-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
