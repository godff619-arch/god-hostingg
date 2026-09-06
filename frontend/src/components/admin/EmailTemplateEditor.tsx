// Email template list and editor — §21.
//
// The `enabled` switch is a real one, not cosmetic: `renderTemplate()` returns null
// for a disabled key, so the platform stops sending that *kind* of mail rather than
// falling back to the built-in wording. That is worth saying on screen, because
// switching off "Invoice issued" quietly stops customers hearing about invoices.
//
// Preview renders the draft in the editor, not the saved row, so the button answers
// "what will this look like?" before committing. The server fills the tokens with
// obvious sample data (Alex Marsh, INV-2026-0042) — a preview must never be
// mistakable for a real customer's mail.
//
// Reset is only offered where `resettable` is true. A template an operator wrote
// themselves has no built-in to go back to, and a button that 404s is worse than an
// absent one.

import { useEffect, useState } from "react";
import { Eye, FileCode2, Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  ListEmpty,
  ListError,
  ListSkeleton,
  ToneBadge,
} from "@/components/admin/AdminList";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { EmailTemplate, TemplatePreview, TemplatesResponse } from "@/lib/adminCommsTypes";
import { formatDateTime } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

/** Renders the sample HTML in a sandboxed frame — a template is arbitrary markup. */
function PreviewFrame({ html }: { html: string }) {
  return (
    <iframe
      title="Email preview"
      // `sandbox` with no allow-* tokens: no scripts, no forms, no navigation. The
      // body comes from an operator, but this page is the admin panel and a template
      // is not a place to run code.
      sandbox=""
      srcDoc={html}
      className="h-[52vh] w-full rounded-xl border border-border/60 bg-white"
    />
  );
}

function TemplateDialog({
  template,
  canManage,
  onClose,
  onSaved,
}: {
  template: EmailTemplate;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(template.name);
  const [subject, setSubject] = useState(template.subject);
  const [bodyHtml, setBodyHtml] = useState(template.body_html);
  const [enabled, setEnabled] = useState(template.enabled);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);

  const dirty =
    name !== template.name ||
    subject !== template.subject ||
    bodyHtml !== template.body_html ||
    enabled !== template.enabled;

  const save = async () => {
    if (!subject.trim() || !bodyHtml.trim() || !name.trim()) {
      toast.error("Name, subject and body are all required.");
      return;
    }
    setSaving(true);
    try {
      await adminSend(`/email/templates/${template.key}`, "PATCH", {
        name: name.trim(),
        subject: subject.trim(),
        body_html: bodyHtml,
        enabled,
      });
      toast.success(`${name.trim()} saved.`);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The template was not saved.");
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      // Send the draft, so the preview describes what is on screen.
      const res = await adminSend<TemplatePreview>(`/email/templates/${template.key}/preview`, "POST", {
        subject,
        body_html: bodyHtml,
      });
      setPreview(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not render the preview.");
    } finally {
      setPreviewing(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      const res = await adminSend<{ template: EmailTemplate }>(
        `/email/templates/${template.key}/reset`,
        "POST",
      );
      setName(res.template.name);
      setSubject(res.template.subject);
      setBodyHtml(res.template.body_html);
      setEnabled(res.template.enabled);
      setPreview(null);
      toast.success("Put back to the shipped wording.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reset the template.");
    } finally {
      setResetting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{template.name}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-[11px]">{template.key}</span> — sent by the platform
            automatically. Switching it off stops this kind of mail entirely.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="Internal label for this list.">
              <Input value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Subject" hint="Tokens work here too.">
              <Input
                value={subject}
                disabled={!canManage}
                onChange={(e) => setSubject(e.target.value)}
              />
            </Field>
          </div>

          {template.tokens.length > 0 && (
            <Field
              label="Available tokens"
              hint="Click to copy. `{{&token}}` inserts HTML unescaped; plain `{{token}}` is escaped."
            >
              <div className="flex flex-wrap gap-1.5">
                {template.tokens.map((token) => (
                  <button
                    key={token}
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(`{{${token}}}`);
                      toast.success(`{{${token}}} copied.`);
                    }}
                    className="press rounded-full border border-border/60 bg-secondary/40 px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {`{{${token}}}`}
                  </button>
                ))}
              </div>
            </Field>
          )}

          <Field
            label="HTML body"
            hint="Inline styles only — mail clients ignore stylesheets. The plaintext part is regenerated on save."
          >
            <Textarea
              value={bodyHtml}
              disabled={!canManage}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={12}
              className="font-mono text-[12px] leading-relaxed"
              spellCheck={false}
            />
          </Field>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!canManage}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[hsl(var(--brand))]"
            />
            <span className="text-xs">
              <span className="block font-semibold text-foreground">Enabled</span>
              <span className="block text-muted-foreground">
                Off means the platform sends no mail of this kind at all — it does not fall back to
                the built-in wording.
              </span>
            </span>
          </label>

          {preview && (
            <div className="space-y-2 rounded-2xl border border-border/60 bg-secondary/20 p-3">
              <p className="text-xs font-semibold text-muted-foreground">
                Subject: <span className="font-normal text-foreground">{preview.subject}</span>
              </p>
              <PreviewFrame html={preview.html} />
              <p className="text-[11px] text-muted-foreground">
                {preview.tokens_used.length > 0
                  ? `Tokens filled: ${preview.tokens_used.join(", ")}`
                  : "This body references no tokens."}{" "}
                Sample values — not a real customer's mail.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={runPreview} disabled={previewing || !canManage}>
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
              Preview
            </Button>
            {template.resettable && canManage && (
              <Button variant="ghost" onClick={reset} disabled={resetting}>
                {resetting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                Reset to default
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Close
            </Button>
            <Button onClick={save} disabled={!canManage || saving || !dirty}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EmailTemplateEditor({ canManage }: { canManage: boolean }) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<EmailTemplate | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await adminGet<TemplatesResponse>("/email/templates");
      setTemplates(res.templates);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the templates");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggle = async (template: EmailTemplate) => {
    try {
      await adminSend(`/email/templates/${template.key}`, "PATCH", { enabled: !template.enabled });
      toast.success(
        template.enabled
          ? `${template.name} switched off — this kind of mail will no longer be sent.`
          : `${template.name} switched on.`,
      );
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change that.");
    }
  };

  if (loading && templates.length === 0) return <ListSkeleton rows={7} />;

  return (
    <div className="space-y-4">
      {error && <ListError message={error} onRetry={load} />}

      {templates.length === 0 && !loading ? (
        <ListEmpty
          message="No templates are stored."
          hint="The built-ins are created at boot. Restart the backend, or check the server log for a seeding warning."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {templates.map((t) => (
            <article
              key={t.key}
              className={cn(
                "flex flex-col justify-between gap-3 rounded-2xl border bg-card p-4",
                t.enabled ? "border-border/60" : "border-warning-border bg-warning-surface/30",
              )}
            >
              <div className="min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="flex min-w-0 items-center gap-2 text-sm font-bold">
                    <FileCode2 className="h-4 w-4 shrink-0 text-brand" />
                    <span className="truncate">{t.name}</span>
                  </h3>
                  <ToneBadge
                    label={t.enabled ? "Enabled" : "Off"}
                    tone={t.enabled ? "success" : "warning"}
                  />
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={t.key}>
                  {t.key}
                </p>
                <p className="mt-2 line-clamp-2 text-xs text-muted-foreground" title={t.subject}>
                  {t.subject}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground/80">
                  {t.updated_at ? `Edited ${formatDateTime(t.updated_at)}` : "Never edited"}
                  {t.resettable ? "" : " · custom template"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setOpen(t)}>
                  {canManage ? "Edit" : "View"}
                </Button>
                {canManage && (
                  <Button
                    variant={t.enabled ? "ghost" : "success"}
                    size="sm"
                    onClick={() => toggle(t)}
                  >
                    {t.enabled ? "Switch off" : "Switch on"}
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {open && (
        <TemplateDialog
          template={open}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
