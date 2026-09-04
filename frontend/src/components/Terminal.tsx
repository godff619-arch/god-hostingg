// Terminal component - build log display with syntax highlighting and copy feature
//
// Build output is written for a dark background, so this pane stays on the navy
// #0F172A plane with the rail and the shell canvas. Every colour comes from a
// `sidebar-*` token; the light-plane tokens would be invisible here.

import { useEffect, useRef, useState } from "react";
import { cn, copyToClipboard } from "@/lib/utils";
import { Copy, Check, Terminal as TerminalIcon, Sparkles, Hash, Layers } from "lucide-react";
import { Button } from "./ui/button";

interface TerminalProps {
  logs: string;
  isBuilding?: boolean;
  className?: string;
}

export function Terminal({ logs, isBuilding, className }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
    }
  };

  const handleCopy = () => {
    copyToClipboard(logs);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatLogs = (text: string) => {
    return text.split("\n").map((line, i) => {
      let lineClass = "text-sidebar-foreground/80";
      let icon = null;
      
      // Success indicators
      if (line.includes("[✓]") || line.includes("✅") || line.toLowerCase().includes("success") || line.includes("DONE") || line.includes("Built")) {
        lineClass = "text-emerald-400 font-medium";
        if (line.includes("DONE") || line.includes("Built") || line.includes("✅")) icon = <Sparkles className="h-3 w-3 inline mr-2 opacity-50" />;
      } 
      // Error indicators
      else if (line.includes("[✗]") || line.includes("❌") || line.toLowerCase().includes("error") || line.toLowerCase().includes("failed")) {
        lineClass = "text-red-400 font-medium";
      }
      // Warning indicators  
      else if (line.toLowerCase().includes("warning") || line.includes("[!]")) {
        lineClass = "text-amber-400";
      }
      // Build steps (#1, #2, etc)
      else if (/^#\d+/.test(line.trim())) {
        lineClass = "text-cyan-400";
        icon = <Hash className="h-3 w-3 inline mr-1.5 opacity-40" />;
      }
      // Docker layer steps ([1/10], [2/10], etc)
      else if (/\[\s*\d+\/\d+\s*\]/.test(line)) {
        lineClass = "text-violet-400 font-medium";
        icon = <Layers className="h-3 w-3 inline mr-1.5 opacity-40" />;
      }
      // Info/build commands
      else if (line.includes("[+]") || line.includes("Building")) {
        lineClass = "text-blue-400";
      }
      // Prompt style
      else if (line.trim().startsWith("$")) {
        lineClass = "text-violet-400 font-semibold";
      }

      return (
        <div key={i} className={cn("leading-relaxed py-0.5 group/line flex items-start", lineClass)}>
          <span className="shrink-0 w-6 opacity-20 group-hover/line:opacity-50 transition-opacity text-[10px] select-none pt-0.5">
            {i + 1}
          </span>
          <span className="whitespace-pre-wrap flex-1">
            {icon}{line || "\u00A0"}
          </span>
        </div>
      );
    });
  };

  return (
    <div
      id="terminal-wrapper"
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-sidebar-border bg-sidebar shadow-[0_1px_2px_0_rgba(15,23,42,0.04)]",
        className,
      )}
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border bg-sidebar-accent px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-sidebar-muted">
            <TerminalIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
            Output
          </div>
          {isBuilding && (
            <div className="flex items-center gap-1.5 rounded-full border border-warning-border/30 bg-warning-surface/10 px-2 py-0.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning-border" />
              <span className="text-[9px] font-semibold uppercase tracking-tight text-warning-border">
                Streaming
              </span>
            </div>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-8 gap-2 px-3 text-sidebar-muted transition-all hover:bg-white/10 hover:text-sidebar-foreground active:scale-95"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success-border" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          <span className="text-[10px] font-semibold uppercase tracking-wider">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>

      {/* Terminal Body */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="dark-scroll relative flex-1 overflow-auto p-4 font-mono text-[13px] selection:bg-white/20"
      >
        {logs ? (
          <div className="relative z-10">
            {formatLogs(logs)}
            {isBuilding && (
              <div className="mt-4 flex animate-pulse items-center gap-2 font-semibold text-success-border">
                <span className="text-success-border/60">$</span>
                <span className="h-4 w-2 bg-success-border/80" />
              </div>
            )}
          </div>
        ) : isBuilding ? (
          <div className="flex animate-pulse items-center gap-3 py-4 font-medium italic text-warning-border">
            <div className="h-2 w-2 rounded-full bg-warning-border" />
            Warming up build environment...
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-20 text-center text-sidebar-subtle">
            <TerminalIcon className="h-12 w-12 opacity-40" strokeWidth={1} />
            <div className="space-y-1">
              <p className="font-semibold uppercase tracking-tight">Terminal Ready</p>
              <p className="text-xs">Waiting for deployment instructions</p>
            </div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {["npm run build", "docker compose up", "yarn install"].map((cmd) => (
                <div
                  key={cmd}
                  className="rounded-lg border border-sidebar-border bg-white/[0.04] px-3 py-1 font-mono text-[10px]"
                >
                  {cmd}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
