// Ctrl/Cmd+K launcher: searches projects, services, settings, users and docs
// (spec §12) and runs shell actions. Every result comes from a real API row.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  Container,
  Database,
  LayoutGrid,
  LogOut,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { authFetch } from "@/lib/auth";
import { useFocusTrap } from "@/lib/focusTrap";
import { projectPath, projectsPath } from "@/lib/hierarchy";
import { API_URL, cn } from "@/lib/utils";
import type { Project } from "@/lib/types";
import { apiGet, scoped } from "@/lib/workspaceApi";
import type { ProjectCard } from "@/lib/workspaceTypes";
import { SETTINGS_SECTIONS, settingsHref } from "@/lib/settingsNav";
import { hasAdminAccess, isFullAdmin } from "@/lib/roles";
import { visibleNavItems, type IconComponent } from "./navigation";
import { useShell } from "./ShellContext";

interface Command {
  id: string;
  label: string;
  hint: string;
  group: string;
  icon: IconComponent;
  run: () => void;
}

/** Minimal shape the palette needs from `/api/admin/users`. */
interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: string;
}

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useShell();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [groups, setGroups] = useState<ProjectCard[]>([]);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { logout, user } = useAuth();
  const isAdmin = hasAdminAccess(user?.role);

  useFocusTrap(paletteOpen, dialogRef);

  useEffect(() => {
    if (!paletteOpen) {
      setQuery("");
      setSelected(0);
      return;
    }
    inputRef.current?.focus();
    authFetch(`${API_URL}/api/projects`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setProjects(Array.isArray(data) ? data : []))
      .catch(() => {});
    apiGet<{ projects: ProjectCard[] }>(scoped("/api/workspace/projects"))
      .then((data) => setGroups(data.projects))
      .catch(() => {});
    if (!isAdmin) {
      setUsers([]);
      return;
    }
    // Admin-only: the server enforces requireAdmin, this just avoids a 403 fetch.
    apiGet<{ users: AdminUserRow[] }>("/api/admin/users?pageSize=50")
      .then((data) => setUsers(data.users))
      .catch(() => {});
  }, [paletteOpen, isAdmin]);

  const commands = useMemo<Command[]>(() => {
    const close = (action: () => void) => () => {
      setPaletteOpen(false);
      action();
    };

    const pages: Command[] = [
      ...visibleNavItems(hasAdminAccess(user?.role), isFullAdmin(user?.role)).map((item) => ({
        id: `nav:${item.href}`,
        label: item.label,
        hint: item.description,
        group: "Go to",
        icon: item.icon,
        run: close(() => {
          if (item.external) {
            window.open(item.href, "_blank", "noopener,noreferrer");
            return;
          }
          navigate(item.href);
        }),
      })),
      ...SETTINGS_SECTIONS.map((section) => ({
        id: `settings:${section.id}`,
        label: section.label,
        hint: section.description,
        group: "Settings",
        icon: section.icon,
        run: close(() => navigate(settingsHref(section.id))),
      })),
    ];

    const projectCommands: Command[] = groups.map((group) => ({
      id: `group:${group.id}`,
      label: group.name,
      hint: `Project · ${group.counts.resources} resource${group.counts.resources === 1 ? "" : "s"}`,
      group: "Projects",
      icon: LayoutGrid,
      run: close(() => navigate(projectPath(group.id))),
    }));

    const serviceCommands: Command[] = projects.map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      hint: `${project.project_type === "database" ? "Database" : "Service"} · ${project.status}`,
      group: "Services",
      icon: project.project_type === "database" ? Database : Container,
      // The flat resource URL, which redirects to the nested one once the server
      // says which project and environment the resource sits in.
      run: close(() => navigate(`/projects/${project.id}`)),
    }));

    const userCommands: Command[] = users.map((row) => ({
      id: `user:${row.id}`,
      label: row.name || row.email,
      hint: `${row.email} · ${row.role}`,
      group: "Users",
      icon: Users,
      run: close(() => navigate(`/admin/users/${row.id}`)),
    }));

    const actions: Command[] = [
      {
        id: "action:new-project",
        label: "New project",
        hint: "A container for environments and services",
        group: "Actions",
        icon: LayoutGrid,
        run: close(() => navigate(`${projectsPath}?new=project`)),
      },
      {
        id: "action:new-service",
        label: "New web service",
        hint: "Deploy from GitHub or an upload",
        group: "Actions",
        icon: Plus,
        run: close(() => navigate("/projects/new")),
      },
      {
        id: "action:docs",
        label: "Documentation",
        hint: "Guides and commands",
        group: "Docs",
        icon: BookOpen,
        run: close(() => navigate("/docs")),
      },
      {
        id: "action:sign-out",
        label: "Sign out",
        hint: "End this session",
        group: "Actions",
        icon: LogOut,
        run: close(logout),
      },
    ];

    return [...pages, ...projectCommands, ...serviceCommands, ...userCommands, ...actions];
  }, [projects, groups, users, navigate, logout, setPaletteOpen, user]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint} ${command.group}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, results.length]);

  if (!paletteOpen) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => (results.length ? (index + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) =>
        results.length ? (index - 1 + results.length) % results.length : 0,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      results[selected]?.run();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setPaletteOpen(false);
    }
  };

  let lastGroup = "";

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center p-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={() => setPaletteOpen(false)}
        className="absolute inset-0 cursor-default bg-foreground/40 animate-in fade-in duration-150"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onKeyDown}
        className="relative w-full max-w-xl overflow-hidden rounded-md border border-border bg-card shadow-[0_12px_32px_-12px_rgba(15,23,42,0.25)] animate-in fade-in zoom-in-95 duration-150"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects, services, settings, users and docs…"
            className="h-12 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-subtle">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="shell-scroll max-h-[52vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              Nothing matches “{query}”.
            </p>
          ) : (
            results.map((command, index) => {
              const showGroup = command.group !== lastGroup;
              lastGroup = command.group;
              const isSelected = index === selected;
              return (
                <div key={command.id}>
                  {showGroup && (
                    <p className="px-2.5 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-[0.09em] text-subtle">
                      {command.group}
                    </p>
                  )}
                  <button
                    type="button"
                    data-selected={isSelected}
                    onMouseEnter={() => setSelected(index)}
                    onClick={command.run}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-150",
                      isSelected ? "bg-brand text-brand-foreground" : "hover:bg-secondary",
                    )}
                  >
                    <command.icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isSelected ? "text-brand-foreground" : "text-muted-foreground",
                      )}
                      strokeWidth={1.75}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{command.label}</span>
                      <span
                        className={cn(
                          "block truncate text-[11px]",
                          isSelected ? "text-brand-foreground/75" : "text-subtle",
                        )}
                      >
                        {command.hint}
                      </span>
                    </span>
                    {isSelected && (
                      <ArrowRight className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
