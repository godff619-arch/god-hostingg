// Admin Users (/admin/users) — searchable, sortable, paginated user management.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Users,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Pencil,
  Ban,
  CircleCheck,
  Trash2,
  RefreshCw,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { adminGet, adminSend } from "@/lib/adminApi";
import type {
  AdminUser,
  AdminUsersResponse,
  Plan,
  QuotaOverrides,
  UserRole,
  UserStatus,
} from "@/lib/adminTypes";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/AuthProvider";
import { rankOf, roleLabel } from "@/lib/roles";

// Roles the current actor may grant, cheapest-first. Mirrors the server's
// canAssignRole (strictly-below-own-rank); `owner` is never offered. The server
// re-checks, so this only shapes the menu.
const ASSIGNABLE_TIERS: UserRole[] = ["user", "viewer", "admin", "super_admin"];
function assignableRoles(actorRole: string | null | undefined): UserRole[] {
  return ASSIGNABLE_TIERS.filter((r) => rankOf(actorRole) > rankOf(r));
}

const PAGE_SIZE = 15;
type SortKey = "name" | "email" | "created_at" | "app_count";
type SortOrder = "asc" | "desc";

const OVERRIDE_FIELDS: { key: keyof QuotaOverrides; label: string }[] = [
  { key: "ram_mb", label: "RAM (MB)" },
  { key: "cpus_milli", label: "CPU (milli)" },
  { key: "storage_mb", label: "Storage (MB)" },
  { key: "max_apps", label: "Max apps" },
  { key: "max_domains", label: "Max domains" },
  { key: "max_backups", label: "Max backups" },
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

/** "" -> null (inherit); otherwise Number(value). */
function toQuota(value: string): number | null {
  const t = value.trim();
  return t === "" ? null : Number(t);
}

export default function AdminUsers() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState<"all" | UserStatus>("all");
  const [sort, setSort] = useState<SortKey>("created_at");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);

  // Debounce search input.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, status, sort, order]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q: debouncedQ,
        status: status === "all" ? "" : status,
        sort,
        order,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const res = await adminGet<AdminUsersResponse>(`/users?${params.toString()}`);
      setUsers(res.users);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, status, sort, order, page]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    adminGet<Plan[]>("/plans")
      .then(setPlans)
      .catch(() => setPlans([]));
  }, []);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (key: SortKey) => {
    if (sort === key) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      setOrder(key === "created_at" || key === "app_count" ? "desc" : "asc");
    }
  };

  const handleSuspendToggle = async (user: AdminUser) => {
    const action = user.status === "suspended" ? "unsuspend" : "suspend";
    try {
      await adminSend(`/users/${user.id}/${action}`, "POST");
      toast.success(`User ${action === "suspend" ? "suspended" : "unsuspended"}`);
      fetchUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action} user`);
    }
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    try {
      await adminSend(`/users/${deleteUser.id}`, "DELETE");
      toast.success("User deleted");
      setDeleteUser(null);
      fetchUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <>
      <PageHeader
        title="Users"
        description="Manage accounts, plans, quotas, and access."
        icon={Users}
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={fetchUsers}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
            >
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
            </Button>
            <Button onClick={() => setCreateOpen(true)} className="h-10">
              <Plus className="h-4 w-4" />
              New user
            </Button>
          </>
        }
      />

      {/* Filters */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or email…"
            className="pl-9"
          />
        </div>
        <div className="flex gap-1.5">
          {(["all", "active", "suspended", "pending"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={cn(
                "rounded-xl border px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                status === s
                  ? "border-brand/30 bg-brand/10 text-brand"
                  : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <div className="overflow-hidden rounded-2xl border border-border/60">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse border-b border-border/40 bg-secondary/20 last:border-b-0"
            />
          ))}
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-4 py-16 text-center text-sm text-muted-foreground">
          No users match these filters.
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {users.map((user) => (
              <article
                key={user.id}
                onClick={() => navigate(`/admin/users/${user.id}`)}
                className="cursor-pointer rounded-2xl border border-border/60 bg-card p-4 shadow-sm transition-colors hover:bg-secondary/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{user.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                  </div>
                  <StatusBadge status={user.status} size="sm" />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{roleLabel(user.role)}</span>
                  <span>{user.plan_name || user.plan_key || "No plan"}</span>
                  <span>{user.app_count} apps</span>
                  <span>{formatDate(user.created_at)}</span>
                </div>
                <div
                  className="mt-3 flex flex-wrap gap-1.5 border-t border-border/40 pt-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button size="sm" variant="outline" onClick={() => setEditUser(user)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleSuspendToggle(user)}>
                    {user.status === "suspended" ? (
                      <>
                        <CircleCheck className="h-3.5 w-3.5" /> Unsuspend
                      </>
                    ) : (
                      <>
                        <Ban className="h-3.5 w-3.5" /> Suspend
                      </>
                    )}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDeleteUser(user)}>
                    <Trash2 className="h-3.5 w-3.5 text-danger" /> Delete
                  </Button>
                </div>
              </article>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-2xl border border-border/60 bg-card md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-secondary/30 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <SortableTh label="Name" sortKey="name" active={sort} order={order} onSort={toggleSort} />
                    <SortableTh label="Email" sortKey="email" active={sort} order={order} onSort={toggleSort} />
                    <th className="px-4 py-3 font-semibold">Role</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Plan</th>
                    <SortableTh label="Apps" sortKey="app_count" active={sort} order={order} onSort={toggleSort} />
                    <SortableTh label="Created" sortKey="created_at" active={sort} order={order} onSort={toggleSort} />
                    <th className="px-4 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr
                      key={user.id}
                      onClick={() => navigate(`/admin/users/${user.id}`)}
                      className="cursor-pointer border-b border-border/40 transition-colors last:border-b-0 hover:bg-secondary/40"
                    >
                      <td className="px-4 py-3 font-semibold">{user.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{user.email}</td>
                      <td className="px-4 py-3 capitalize">{roleLabel(user.role)}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={user.status} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {user.plan_name || user.plan_key || "—"}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{user.app_count}</td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {formatDate(user.created_at)}
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            title="Edit"
                            onClick={() => setEditUser(user)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            title={user.status === "suspended" ? "Unsuspend" : "Suspend"}
                            onClick={() => handleSuspendToggle(user)}
                          >
                            {user.status === "suspended" ? (
                              <CircleCheck className="h-4 w-4 text-success" />
                            ) : (
                              <Ban className="h-4 w-4 text-warning" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            title="Delete"
                            onClick={() => setDeleteUser(user)}
                          >
                            <Trash2 className="h-4 w-4 text-danger" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!loading && total > 0 && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing{" "}
            <span className="font-semibold text-foreground">
              {rangeStart}–{rangeEnd}
            </span>{" "}
            of <span className="font-semibold text-foreground">{total}</span> users
          </p>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 border-border/60"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[4.5rem] text-center text-xs font-medium tabular-nums text-muted-foreground">
              {page} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 border-border/60"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <UserFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        plans={plans}
        onSaved={fetchUsers}
      />
      <UserFormDialog
        open={editUser !== null}
        onOpenChange={(o) => !o && setEditUser(null)}
        plans={plans}
        user={editUser}
        onSaved={fetchUsers}
      />

      <Dialog open={deleteUser !== null} onOpenChange={(o) => !o && setDeleteUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-surface">
              <AlertTriangle className="h-6 w-6 text-danger" />
            </div>
            <DialogTitle className="text-center">Delete user</DialogTitle>
            <DialogDescription className="text-center">
              Delete <span className="font-semibold text-foreground">{deleteUser?.name}</span>?
              This user&apos;s applications will become unowned. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setDeleteUser(null)} className="flex-1">
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} className="flex-1">
              Delete user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SortableTh({
  label,
  sortKey,
  active,
  order,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  order: SortOrder;
  onSort: (key: SortKey) => void;
}) {
  const isActive = active === sortKey;
  return (
    <th className="px-4 py-3 font-semibold">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-[0.14em] transition-colors hover:text-foreground",
          isActive && "text-foreground",
        )}
      >
        {label}
        {isActive &&
          (order === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          ))}
      </button>
    </th>
  );
}

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: Plan[];
  user?: AdminUser | null;
  onSaved: () => void;
}

function UserFormDialog({ open, onOpenChange, plans, user, onSaved }: UserFormDialogProps) {
  const { user: actor } = useAuth();
  const isEdit = Boolean(user);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [statusValue, setStatusValue] = useState<UserStatus>("active");
  const [planId, setPlanId] = useState("");
  const [showOverrides, setShowOverrides] = useState(false);
  const [overrides, setOverrides] = useState<Record<keyof QuotaOverrides, string>>({
    ram_mb: "",
    cpus_milli: "",
    storage_mb: "",
    max_apps: "",
    max_domains: "",
    max_backups: "",
  });
  const [saving, setSaving] = useState(false);

  // Reset fields when the dialog opens or the target user changes.
  useEffect(() => {
    if (!open) return;
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
    setPassword("");
    setRole(user?.role ?? "user");
    setStatusValue(user?.status ?? "active");
    setPlanId(user?.plan_id ?? "");
    const ov = user?.overrides;
    setOverrides({
      ram_mb: ov?.ram_mb != null ? String(ov.ram_mb) : "",
      cpus_milli: ov?.cpus_milli != null ? String(ov.cpus_milli) : "",
      storage_mb: ov?.storage_mb != null ? String(ov.storage_mb) : "",
      max_apps: ov?.max_apps != null ? String(ov.max_apps) : "",
      max_domains: ov?.max_domains != null ? String(ov.max_domains) : "",
      max_backups: ov?.max_backups != null ? String(ov.max_backups) : "",
    });
    setShowOverrides(
      Boolean(ov && Object.values(ov).some((v) => v != null)),
    );
  }, [open, user]);

  const submit = async () => {
    if (!name.trim() || !email.trim()) {
      toast.error("Name and email are required");
      return;
    }
    if (!isEdit && !password.trim()) {
      toast.error("Password is required for new users");
      return;
    }
    setSaving(true);
    try {
      if (isEdit && user) {
        const overridePayload: Partial<QuotaOverrides> = {};
        for (const { key } of OVERRIDE_FIELDS) {
          overridePayload[key] = toQuota(overrides[key]);
        }
        await adminSend(`/users/${user.id}`, "PATCH", {
          name,
          email,
          role,
          status: statusValue,
          plan_id: planId || null,
          overrides: overridePayload,
        });
        toast.success("User updated");
      } else {
        await adminSend("/users", "POST", {
          name,
          email,
          password,
          role,
          status: statusValue,
          plan_id: planId || null,
        });
        toast.success("User created");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save user");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit user" : "New user"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update account details, plan, and quota overrides." : "Create a new account."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
            />
          </Field>
          {!isEdit && (
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Role">
              {(() => {
                const options = assignableRoles(actor?.role);
                // In edit mode keep the target's current tier visible even if the
                // actor can't grant it, and lock the control when the actor may not
                // manage this account (peer/higher, or the owner). Server re-checks.
                const currentRole = (user?.role ?? "user") as UserRole;
                if (isEdit && !options.includes(currentRole)) options.unshift(currentRole);
                const locked =
                  isEdit && rankOf(currentRole) >= rankOf(actor?.role);
                return (
                  <SelectBox
                    value={role}
                    onChange={(v) => setRole(v as UserRole)}
                    disabled={locked}
                  >
                    {options.map((r) => (
                      <option key={r} value={r}>
                        {roleLabel(r)}
                      </option>
                    ))}
                  </SelectBox>
                );
              })()}
            </Field>
            <Field label="Status">
              <SelectBox value={statusValue} onChange={(v) => setStatusValue(v as UserStatus)}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="pending">Pending</option>
              </SelectBox>
            </Field>
          </div>
          <Field label="Plan">
            <SelectBox value={planId} onChange={setPlanId}>
              <option value="">No plan</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectBox>
          </Field>

          {isEdit && (
            <div className="rounded-xl border border-border/60">
              <button
                type="button"
                onClick={() => setShowOverrides((s) => !s)}
                className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium"
              >
                <span>Quota overrides</span>
                {showOverrides ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>
              {showOverrides && (
                <div className="border-t border-border/60 p-4">
                  <p className="mb-3 text-xs text-muted-foreground">
                    Leave a field blank to inherit the plan value.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {OVERRIDE_FIELDS.map(({ key, label }) => (
                      <Field key={key} label={label}>
                        <Input
                          type="number"
                          value={overrides[key]}
                          onChange={(e) =>
                            setOverrides((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          placeholder="inherit"
                        />
                      </Field>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="flex-1">
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving} className="flex-1">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? "Save changes" : "Create user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SelectBox({
  value,
  onChange,
  children,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="flex h-11 w-full rounded-xl border-2 border-border bg-background px-3 text-sm transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </select>
  );
}
