// Consume a text streaming response (deploy / backup / restore) and decide the
// real verdict, which is NOT the HTTP status: these endpoints stream progress with
// a 200 header and only later discover that the work failed.
//
// Two families of stream reach this function and they signal differently:
//   - deploy/rollback (routes/deployments.ts) ends with an explicit
//     `Deployment complete! Status: SUCCESS|FAILED` line, and reports problems
//     mid-stream as `Error:` / `Docker execution error:` / `Deployment cancelled`;
//   - backup/restore (routes/backup.ts) has no terminal line and marks problems
//     with `[ERROR]`.
//
// So the explicit terminal status wins when present, and the marker scan is the
// fallback. Getting that order wrong is how a FAILED deploy showed a green
// "Deploy completed!" toast, and how a build log that happens to print `[ERROR]`
// (maven, gradle, eslint) would flag a successful deploy as broken.
//
// Nothing here matches on emoji. The backend decorates these lines with ❌/📊 and
// some already reach the browser as mojibake (`âŒ`), so the emoji is treated as
// decoration to be stripped, never as part of the pattern.

export type StreamProgressResult = {
  ok: boolean;
  lines: string[];
  error?: string;
  /** The operator stopped it themselves — not a failure worth a red toast. */
  cancelled?: boolean;
};

const TERMINAL_STATUS = /Deployment complete!\s*Status:\s*(SUCCESS|FAILED)/i;
const CANCELLED = /Deployment cancelled/i;
const ERROR_MARKER = /\[ERROR\]/i;
const PLAIN_ERROR = /(?:Docker execution error|Deployment error|Error):\s*\S/i;

/** Strip the decoration so a toast shows the message and not `❌ Error: …`. */
function cleanErrorLine(line: string): string {
  if (ERROR_MARKER.test(line)) {
    return line.replace(/^.*?\[ERROR\]\s*/i, "").trim() || line.trim();
  }
  return (
    line
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/^(?:Docker execution error|Deployment error|Error):\s*/i, "")
      .trim() || line.trim()
  );
}

/**
 * Read a fetch Response body as text lines and classify the outcome.
 * - Non-OK HTTP status → failure (JSON error body preferred when present)
 * - `Status: FAILED` terminal line → failure, described by the best error line seen
 * - `Status: SUCCESS` terminal line → success, whatever the build log printed
 * - No terminal line → cancellation, then `[ERROR]`, then `Error:` decide
 */
export async function consumeProgressStream(
  res: Response,
  onLine?: (line: string) => void,
): Promise<StreamProgressResult> {
  const lines: string[] = [];

  if (!res.ok) {
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await res.json().catch(() => ({}) as { error?: string });
      return {
        ok: false,
        lines,
        error: data.error || `Request failed (${res.status})`,
      };
    }
    const text = await res.text().catch(() => "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      lines.push(line);
      onLine?.(line);
    }
    const marked = lines.find((l) => ERROR_MARKER.test(l));
    return {
      ok: false,
      lines,
      error: marked ? cleanErrorLine(marked) : `Request failed (${res.status})`,
    };
  }

  if (!res.body) {
    return { ok: false, lines, error: "Empty response body" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() || "";
    for (const line of parts) {
      lines.push(line);
      onLine?.(line);
    }
  }
  if (buffer) {
    lines.push(buffer);
    onLine?.(buffer);
  }

  return classifyProgressLines(lines);
}

/**
 * The verdict for a completed 200 stream. Exported for tests: this is pure, while
 * everything above it needs a live `Response`.
 */
export function classifyProgressLines(lines: string[]): StreamProgressResult {
  let status: "SUCCESS" | "FAILED" | null = null;
  let cancelled = false;
  let markerError = "";
  let plainError = "";

  for (const line of lines) {
    const terminal = TERMINAL_STATUS.exec(line);
    if (terminal) {
      status = terminal[1].toUpperCase() === "FAILED" ? "FAILED" : "SUCCESS";
      continue;
    }
    if (CANCELLED.test(line)) {
      cancelled = true;
      continue;
    }
    if (ERROR_MARKER.test(line)) markerError = line;
    else if (PLAIN_ERROR.test(line)) plainError = line;
  }

  const described = markerError || plainError;

  if (status === "FAILED") {
    if (cancelled && !described) {
      return { ok: false, cancelled: true, lines, error: "Deployment cancelled" };
    }
    return {
      ok: false,
      lines,
      error: described ? cleanErrorLine(described) : "Deployment failed",
    };
  }
  if (status === "SUCCESS") return { ok: true, lines };

  // No terminal verdict: the stream was cut short, or this is a backup/restore.
  if (cancelled) {
    return { ok: false, cancelled: true, lines, error: "Deployment cancelled" };
  }
  if (described) {
    return { ok: false, lines, error: cleanErrorLine(described) };
  }
  return { ok: true, lines };
}
