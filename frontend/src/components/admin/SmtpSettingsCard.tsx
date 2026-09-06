// SMTP configuration, verification and a real test send — §21.
//
// Three things this form does differently from an ordinary settings form, all for
// the same reason: the password is not readable.
//
//   1. The password input starts empty and is only sent when the operator types
//      something. `PATCH /smtp` treats an absent `password` as "keep the stored
//      one", so an empty box means "unchanged", never "blank it".
//   2. `has_password` is rendered as a state ("A password is stored"), never as a
//      masked value. There is no round-trip that could leak it.
//   3. Verify and Test are separate buttons because they answer different
//      questions. Verify opens the connection and authenticates without sending
//      anything; Test puts a real mail in a real inbox. An operator debugging
//      credentials should not have to spam themselves to do it.
//
// `ready` is the server's own verdict on whether a send would be attempted, so the
// banner cannot disagree with the mailer.

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Mail, PlugZap, Save, Send, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, ListError, ListSkeleton, Metric, MetricStrip, SelectBox } from "@/components/admin/AdminList";
import { adminGet, adminSend } from "@/lib/adminApi";
import type {
  SendOutcome,
  SmtpConfig,
  SmtpPatchBody,
  SmtpResponse,
  VerifyResult,
} from "@/lib/adminCommsTypes";
import { cn } from "@/lib/utils";

/** The common ports, with what each one implies, so `secure` is not a guess. */
const PORT_PRESETS = [
  { port: 587, secure: false, label: "587 — STARTTLS (most providers)" },
  { port: 465, secure: true, label: "465 — implicit TLS" },
  { port: 2525, secure: false, label: "2525 — STARTTLS (alternate)" },
  { port: 25, secure: false, label: "25 — plain SMTP relay" },
];

interface FormState {
  enabled: boolean;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  password: string;
  from_email: string;
  from_name: string;
  reply_to: string;
}

function toForm(cfg: SmtpConfig): FormState {
  return {
    enabled: cfg.enabled,
    host: cfg.host,
    port: String(cfg.port || 587),
    secure: cfg.secure,
    user: cfg.user,
    // Always empty: there is nothing to prefill it with, by design.
    password: "",
    from_email: cfg.from_email,
    from_name: cfg.from_name,
    reply_to: cfg.reply_to,
  };
}

export function SmtpSettingsCard({
  canManage,
  canSend,
  onQueueChanged,
}: {
  canManage: boolean;
  canSend: boolean;
  /** Lets the page refresh the log tab after a test send writes a row. */
  onQueueChanged?: () => void;
}) {
  const [data, setData] = useState<SmtpResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState<VerifyResult | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await adminGet<SmtpResponse>("/smtp");
      setData(res);
      setForm(toForm(res.smtp));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the mail settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    // Any edit invalidates the last verdict — it described the saved config.
    setVerdict(null);
  };

  const save = async () => {
    if (!form) return;
    const port = Number(form.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      toast.error("Port must be between 1 and 65535.");
      return;
    }
    setSaving(true);
    try {
      const body: SmtpPatchBody = {
        enabled: form.enabled,
        host: form.host.trim(),
        port,
        secure: form.secure,
        user: form.user.trim(),
        from_email: form.from_email.trim(),
        from_name: form.from_name.trim(),
        reply_to: form.reply_to.trim(),
      };
      // Only when typed. An empty box means "keep what is stored".
      if (form.password) body.password = form.password;
      const res = await adminSend<{ smtp: SmtpConfig }>("/smtp", "PATCH", body);
      setData((prev) => (prev ? { ...prev, smtp: res.smtp } : prev));
      setForm(toForm(res.smtp));
      setVerdict(null);
      toast.success(
        res.smtp.ready
          ? "Mail settings saved. SMTP is on and complete."
          : "Mail settings saved. SMTP is not ready yet, so mail will be queued.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The mail settings were not saved.");
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    try {
      const res = await adminSend<VerifyResult>("/smtp/verify", "POST");
      setVerdict(res);
      if (res.ok) toast.success("Connected and authenticated.");
      else toast.error(res.error || "The server refused the connection.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reach the mail server.");
    } finally {
      setVerifying(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await adminSend<SendOutcome>("/email/test", "POST", {
        to: testTo.trim() || undefined,
      });
      // `queued` is not success. Say what happened rather than what was hoped for.
      if (res.status === "sent") toast.success(res.message);
      else if (res.status === "queued") toast.warning(res.message);
      else toast.error(res.error || res.message);
      onQueueChanged?.();
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the test.");
    } finally {
      setTesting(false);
    }
  };

  if (loading && !form) return <ListSkeleton rows={6} />;
  if (error && !form) return <ListError message={error} onRetry={load} />;
  if (!form || !data) return null;

  const dirtyPort = Number(form.port);
  const presetMatch = PORT_PRESETS.find((p) => p.port === dirtyPort && p.secure === form.secure);

  return (
    <div className="space-y-6">
      {error && <ListError message={error} onRetry={load} />}

      <MetricStrip>
        <Metric
          label="Delivery"
          value={data.smtp.ready ? "Ready" : form.enabled ? "Incomplete" : "Off"}
          tone={data.smtp.ready ? "success" : "warning"}
          hint={
            data.smtp.ready
              ? "Mail is sent as it is generated"
              : "Mail is recorded and queued until this is fixed"
          }
        />
        <Metric label="Sent" value={data.queue.sent} tone="success" hint="Delivered by the transport" />
        <Metric
          label="Queued"
          value={data.queue.queued}
          tone={data.queue.queued > 0 ? "warning" : "neutral"}
          hint="Waiting for a working transport"
        />
        <Metric
          label="Failed"
          value={data.queue.failed}
          tone={data.queue.failed > 0 ? "danger" : "neutral"}
          hint="Rejected — see the Mail log"
        />
      </MetricStrip>

      {!data.smtp.ready && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            SMTP is {form.enabled ? "switched on but incomplete" : "switched off"}, so nothing is being
            delivered. Every mail is still written to the log with status <strong>queued</strong> — finish
            the configuration and the backlog goes out on the next sweep.
          </span>
        </div>
      )}

      <section className="rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
        <header className="mb-4">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Mail className="h-4 w-4 text-brand" /> Outbound mail server
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Used for every mail the platform sends: verification, password resets, invoices,
            support replies and announcements.
          </p>
        </header>

        <label className="mb-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!canManage}
            onChange={(e) => set("enabled", e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[hsl(var(--brand))]"
          />
          <span className="text-xs">
            <span className="block font-semibold text-foreground">Send mail</span>
            <span className="block text-muted-foreground">
              Off means every mail is queued instead of delivered. Nothing is lost, and nothing
              claims to have been sent.
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Host" hint="e.g. smtp.resend.com, smtp.gmail.com.">
            <Input
              value={form.host}
              disabled={!canManage}
              onChange={(e) => set("host", e.target.value)}
              placeholder="smtp.example.com"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Port & encryption"
            hint={presetMatch ? undefined : "Custom — check your provider's docs for the TLS mode."}
          >
            <SelectBox
              value={presetMatch ? String(presetMatch.port) : "custom"}
              disabled={!canManage}
              onChange={(value) => {
                if (value === "custom") return;
                const preset = PORT_PRESETS.find((p) => String(p.port) === value);
                if (!preset) return;
                setForm((prev) =>
                  prev ? { ...prev, port: String(preset.port), secure: preset.secure } : prev,
                );
                setVerdict(null);
              }}
            >
              {PORT_PRESETS.map((p) => (
                <option key={p.port} value={String(p.port)}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </SelectBox>
          </Field>
        </div>

        {!presetMatch && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Port">
              <Input
                type="number"
                min="1"
                max="65535"
                value={form.port}
                disabled={!canManage}
                onChange={(e) => set("port", e.target.value)}
              />
            </Field>
            <Field label="Encryption">
              <SelectBox
                value={form.secure ? "tls" : "starttls"}
                disabled={!canManage}
                onChange={(value) => set("secure", value === "tls")}
              >
                <option value="starttls">STARTTLS (upgrade after connect)</option>
                <option value="tls">Implicit TLS (encrypted from the first byte)</option>
              </SelectBox>
            </Field>
          </div>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Username" hint="Blank for an unauthenticated relay.">
            <Input
              value={form.user}
              disabled={!canManage}
              onChange={(e) => set("user", e.target.value)}
              placeholder="apikey"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Password"
            hint={
              data.smtp.has_password
                ? "A password is stored and cannot be displayed. Leave blank to keep it."
                : "No password stored yet."
            }
          >
            <Input
              type="password"
              value={form.password}
              disabled={!canManage}
              onChange={(e) => set("password", e.target.value)}
              placeholder={data.smtp.has_password ? "•••••••• (unchanged)" : "Paste the SMTP password"}
              autoComplete="new-password"
            />
          </Field>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="From address" hint="Must be an address the provider lets you send as.">
            <Input
              value={form.from_email}
              disabled={!canManage}
              onChange={(e) => set("from_email", e.target.value)}
              placeholder="no-reply@example.com"
              autoComplete="off"
            />
          </Field>
          <Field label="From name" hint="Shown as the sender in the recipient's client.">
            <Input
              value={form.from_name}
              disabled={!canManage}
              onChange={(e) => set("from_name", e.target.value)}
              placeholder="God Hosting"
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="Reply-to" hint="Optional. Where replies land — often a support inbox.">
            <Input
              value={form.reply_to}
              disabled={!canManage}
              onChange={(e) => set("reply_to", e.target.value)}
              placeholder="support@example.com"
              autoComplete="off"
            />
          </Field>
        </div>

        {verdict && (
          <div
            className={cn(
              "mt-4 flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-xs",
              verdict.ok
                ? "border-success-border bg-success-surface text-success"
                : "border-danger-border bg-danger-surface text-danger",
            )}
          >
            {verdict.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>
              {verdict.ok
                ? "The server accepted the connection and these credentials."
                : verdict.error}
            </span>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={!canManage || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save settings
          </Button>
          <Button variant="outline" onClick={verify} disabled={!canManage || verifying}>
            {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            Verify connection
          </Button>
          {!canManage && (
            <span className="text-xs text-muted-foreground">
              Read-only — `smtp.manage` is required to change these.
            </span>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
        <header className="mb-4">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Send className="h-4 w-4 text-brand" /> Send a test
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Delivers a real mail and reports exactly what the transport said. If SMTP is off you
            will be told it was queued — never that it was sent.
          </p>
        </header>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Recipient" hint="Blank sends it to your own admin address.">
              <Input
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@example.com"
                autoComplete="off"
              />
            </Field>
          </div>
          <Button onClick={sendTest} disabled={!canSend || testing} className="sm:mb-[1px]">
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send test
          </Button>
        </div>
        {!canSend && (
          <p className="mt-2 text-xs text-muted-foreground">
            `email.send` is required to send mail from this panel.
          </p>
        )}
      </section>
    </div>
  );
}
