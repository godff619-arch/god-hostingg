
import { useState, useEffect } from "react";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ScrollToTop() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const toggleVisibility = () => {
      if (window.scrollY > 300) {
        setIsVisible(true);
      } else {
        setIsVisible(false);
      }
    };

    window.addEventListener("scroll", toggleVisibility);
    return () => window.removeEventListener("scroll", toggleVisibility);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  };

  return (
    <div className={cn(
      "fixed bottom-6 right-6 z-50 transition-all duration-300 transform",
      isVisible ? "translate-y-0 opacity-100 pointer-events-auto" : "translate-y-10 opacity-0 pointer-events-none"
    )}>
      <Button
        onClick={scrollToTop}
        size="icon"
        aria-label="Scroll back to top"
        title="Back to top"
        className="group flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-[0_4px_14px_0_rgba(15,23,42,0.10)] transition-all hover:bg-secondary hover:text-foreground"
      >
        <ChevronUp className="h-5 w-5 transition-transform group-hover:-translate-y-0.5" />
      </Button>
    </div>
  );
}
