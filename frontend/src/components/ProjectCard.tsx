// ProjectCard component - displays project info with deploy/stop/restart/delete actions

import { Project } from "@/lib/types";
import { ProjectQuickActions } from "@/components/project/ProjectQuickActions";
import { GitBranch, Server } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface ProjectCardProps {
  project: Project;
  onRefresh: () => void;
}

export function ProjectCard({ project, onRefresh }: ProjectCardProps) {
  const navigate = useNavigate();

  const handleCardClick = () => {
    navigate(`/projects/${project.id}`);
  };

  return (
    <div
      onClick={handleCardClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      className="group relative flex flex-col gap-4 rounded-xl border border-border/60 bg-card p-3 shadow-sm transition-all duration-200 hover:border-foreground/20 hover:bg-secondary/40 hover:shadow-md sm:p-4 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div
          className={`h-2 w-2 shrink-0 rounded-full ${
            project.status === "running"
              ? "bg-success"
              : project.status === "building"
                ? "animate-pulse bg-warning"
                : project.status === "error"
                  ? "bg-danger"
                  : project.status === "degraded"
                    ? "bg-chart-3"
                    : "bg-muted-foreground/40"
          }`}
        />

        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex items-center gap-3">
            <h3 className="truncate text-base font-bold tracking-tight text-foreground/90 transition-colors group-hover:text-foreground">
              {project.name}
            </h3>

            {project.status === "running" ? (
              <span className="rounded-md border border-success-border bg-success-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-success">
                Running
              </span>
            ) : project.status === "building" ? (
              <span className="rounded-md border border-warning-border bg-warning-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warning">
                Building
              </span>
            ) : project.status === "error" ? (
              <span className="rounded-md border border-danger-border bg-danger-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-danger">
                Error
              </span>
            ) : project.status === "degraded" ? (
              <span className="rounded-md border border-warning-border bg-warning-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warning">
                Degraded
              </span>
            ) : project.status === "pending" ? (
              <span className="rounded-md border border-brand/20 bg-brand/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand">
                Pending
              </span>
            ) : (
              <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Stopped
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-muted-foreground">
            <div className="flex items-center gap-1.5 text-foreground/70">
              <GitBranch className="h-3.5 w-3.5" />
              <span>{project.github_branch}</span>
            </div>

            {project.port ? (
              <div className="flex items-center gap-1.5 text-foreground/70">
                <Server className="h-3.5 w-3.5" />
                <span>:{project.port}</span>
              </div>
            ) : null}

            <span className="mx-1 hidden text-border sm:inline">|</span>

            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span title={new Date(project.created_at).toLocaleString()}>
                Created {new Date(project.created_at).toLocaleDateString()}
              </span>
              <span className="hidden sm:inline">•</span>
              <span title={new Date(project.updated_at).toLocaleString()}>
                Updated {new Date(project.updated_at).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      <ProjectQuickActions project={project} onRefresh={onRefresh} />
    </div>
  );
}
