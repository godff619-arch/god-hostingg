import { describe, expect, test } from "bun:test";
import { classifyProgressLines } from "./streamProgress";

// The exact lines routes/deployments.ts writes, emoji included — a FAILED deploy
// used to be reported as success because only `[ERROR]` was recognised.
const FAILED_TAIL = [
  "🧩 DOCKER-FREE MODE — the Docker engine is not reachable",
  "❌ Error: Docker-free mode found nothing it can run in the repository root.",
  "📊 Deployment complete! Status: FAILED ❌",
];

describe("classifyProgressLines", () => {
  test("terminal FAILED is a failure, described by the error line", () => {
    const r = classifyProgressLines(FAILED_TAIL);
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBeFalsy();
    expect(r.error).toBe(
      "Docker-free mode found nothing it can run in the repository root.",
    );
  });

  test("terminal SUCCESS wins over build output that prints Error:", () => {
    const r = classifyProgressLines([
      "[INFO] Downloading maven deps",
      "Error: peer dependency warning from npm",
      "📊 Deployment complete! Status: SUCCESS ✅",
    ]);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test("terminal SUCCESS wins over a build log [ERROR] marker", () => {
    const r = classifyProgressLines([
      "[ERROR] eslint found 3 problems",
      "📊 Deployment complete! Status: SUCCESS ✅",
    ]);
    expect(r.ok).toBe(true);
  });

  test("cancellation is not reported as a failure", () => {
    const r = classifyProgressLines([
      "🚀 Deploying...",
      "❌ Deployment cancelled",
      "📊 Deployment complete! Status: FAILED ❌",
    ]);
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(r.error).toBe("Deployment cancelled");
  });

  test("mojibake decoration is stripped, not matched", () => {
    // Some streams reach the browser double-encoded; the verdict must not depend
    // on the emoji rendering correctly.
    const r = classifyProgressLines([
      "âŒ Error: compose build failed",
      "ð Deployment complete! Status: FAILED âŒ",
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("compose build failed");
  });

  test("docker execution errors are unwrapped", () => {
    const r = classifyProgressLines([
      "❌ Docker execution error: exit code 1",
      "📊 Deployment complete! Status: FAILED ❌",
    ]);
    expect(r.error).toBe("exit code 1");
  });

  test("backup/restore streams still fail on [ERROR] alone", () => {
    const r = classifyProgressLines([
      "Restoring database...",
      "[ERROR] archive is truncated",
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("archive is truncated");
  });

  test("a clean stream with no terminal line stays successful", () => {
    const r = classifyProgressLines(["Backing up...", "Done."]);
    expect(r.ok).toBe(true);
  });

  test("a truncated deploy with no verdict and no error is not failed", () => {
    const r = classifyProgressLines(["🚀 Deploying...", "📦 Building image"]);
    expect(r.ok).toBe(true);
  });

  test("FAILED with no error line still carries a message", () => {
    const r = classifyProgressLines(["📊 Deployment complete! Status: FAILED ❌"]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Deployment failed");
  });
});
