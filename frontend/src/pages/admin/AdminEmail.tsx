// Admin Email (/admin/email) — §21.
//
// Three tabs, one subject: whether mail actually works. The SMTP tab configures the
// transport and can prove it two ways (Verify authenticates without sending; Send
// test puts a real mail in a real inbox). Templates owns the wording. The mail log
// is the receipt — every attempt, its outcome, and the transport's own error text.
//
// The page fetches `GET /smtp` itself, in addition to the card doing so, because the
// log tab needs to know whether a send would be attempted before deciding to offer
// "Send them now" — and Radix unmounts an inactive tab, so it cannot learn that from
// a sibling that was never rendered. It is a settings read plus three counts.
//
// Permissions are read from the server (`/me`) and only used to decide what is worth
// offering; `adminPermissionGate` on every route is the actual boundary.

import { useCallback, useEffect, useState } from "react";
import { FileCode2, Mail, RefreshCw, ScrollText, Server } from "lucide-react";
import { PageHeader, StatChip } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ListError } from "@/components/admin/AdminList";
import { SmtpSettingsCard } from "@/components/admin/SmtpSettingsCard";
import { EmailTemplateEditor } from "@/components/admin/EmailTemplateEditor";
import { EmailLogTable } from "@/components/admin/EmailLogTable";
import { useAdminMe } from "@/hooks/useAdminMe";
import { adminGet } from "@/lib/adminApi";
import type { SmtpResponse } from "@/lib/adminCommsTypes";
import { cn } from "@/lib/utils";

export default function AdminEmail() {
  const { can } = useAdminMe();
  const canManage = can("smtp.manage");
  const canSend = can("email.send");

  const [smtp, setSmtp] = useState<SmtpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped whenever a send or a save may have written a row, so the log refetches.
  const [logKey, setLogKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSmtp(await adminGet<SmtpResponse>("/smtp"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the mail settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onQueueChanged = () => {
    setLogKey((k) => k + 1);
    void load();
  };

  const ready = Boolean(smtp?.smtp.ready);
  const queued = smtp?.queue.queued ?? 0;
  const failed = smtp?.queue.failed ?? 0;

  return (
    <>
      <PageHeader
        title="Email"
        eyebrow="Communications"
        description="The outbound mail server, the wording of every automated mail, and a log of every attempt with the reason it failed."
        icon={Mail}
        meta={
          smtp ? (
            <>
              <StatChip
                label="Delivery"
                value={ready ? "Ready" : smtp.smtp.enabled ? "Incomplete" : "Off"}
                tone={ready ? "success" : "warning"}
              />
              <StatChip label="Sent" value={smtp.queue.sent} tone="neutral" />
              {queued > 0 && <StatChip label="Queued" value={queued} tone="warning" />}
              {failed > 0 && <StatChip label="Failed" value={failed} tone="warning" />}
            </>
          ) : undefined
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={load}
            title="Refresh"
            className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
          >
            <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
          </Button>
        }
      />

      {error && <ListError message={error} onRetry={load} />}

      <Tabs defaultValue="smtp">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="smtp">
            <Server className="h-4 w-4" /> Mail server
          </TabsTrigger>
          <TabsTrigger value="templates">
            <FileCode2 className="h-4 w-4" /> Templates
          </TabsTrigger>
          <TabsTrigger value="log">
            <ScrollText className="h-4 w-4" /> Mail log
            {queued > 0 && (
              <span className="rounded-full bg-warning-surface px-1.5 py-0.5 text-[10px] font-bold text-warning ring-1 ring-warning-border">
                {queued}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="smtp">
          <SmtpSettingsCard canManage={canManage} canSend={canSend} onQueueChanged={onQueueChanged} />
        </TabsContent>

        <TabsContent value="templates">
          <EmailTemplateEditor canManage={canManage} />
        </TabsContent>

        <TabsContent value="log">
          <EmailLogTable canSend={canSend} smtpReady={ready} reloadKey={logKey} />
        </TabsContent>
      </Tabs>
    </>
  );
}
