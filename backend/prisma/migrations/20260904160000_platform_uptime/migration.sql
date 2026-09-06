-- Platform uptime sessions.
--
-- One row per backend boot. The running process refreshes `last_seen_at`; the
-- next boot closes the previous row and records how long the gap was, which is
-- where the status page's downtime figures come from. Nothing here is derived
-- from a guess: an outage exists only if a heartbeat stopped and a later boot
-- saw the gap.
CREATE TABLE IF NOT EXISTS "platform_uptime" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" DATETIME,
    "clean_exit" BOOLEAN NOT NULL DEFAULT false,
    "gap_seconds" INTEGER NOT NULL DEFAULT 0,
    "version" TEXT
);

CREATE INDEX IF NOT EXISTS "platform_uptime_started_at_idx" ON "platform_uptime"("started_at");
