import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  const SNORRIO_HOME = process.env.SNORRIO_HOME || path.join(process.env.HOME!, ".snorrio");
  const FLUSH_TRIGGER = path.join(SNORRIO_HOME, "flush");
  const LOG_DIR = path.join(SNORRIO_HOME, "logs");

  pi.registerCommand("done", {
    description: "Flush all pending sessions through DMN immediately",
    handler: async (_args, ctx) => {
      fs.writeFileSync(FLUSH_TRIGGER, new Date().toISOString());

      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(LOG_DIR, `${today}.log`);

      let logOffset: number;
      try { logOffset = fs.statSync(logFile).size; } catch { logOffset = 0; }

      const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let spinIdx = 0;
      const started = Date.now();

      // Progress state
      let total = 0;
      let episodesDone = 0;
      let episodesFailed = 0;
      let phase: "waiting" | "episodes" | "days" | "done" = "waiting";
      let dayDate = "";

      const poll = setInterval(() => {
        try {
          spinIdx = (spinIdx + 1) % SPINNER.length;
          const s = SPINNER[spinIdx];

          if (Date.now() - started > 300_000) {
            ctx.ui.notify("DMN flush timed out (5m)", "warn");
            ctx.ui.setWidget("done", undefined);
            clearInterval(poll);
            return;
          }

          let stat;
          try { stat = fs.statSync(logFile); } catch { return; }
          if (stat.size <= logOffset) {
            ctx.ui.setWidget("done", [phase === "waiting"
              ? `${s} Waiting for DMN...`
              : statusLine(s)]);
            return;
          }

          // Read new log content
          const fd = fs.openSync(logFile, "r");
          const buf = Buffer.alloc(stat.size - logOffset);
          fs.readSync(fd, buf, 0, buf.length, logOffset);
          fs.closeSync(fd);
          logOffset = stat.size;

          const text = buf.toString("utf8");

          // Nothing to do
          if (text.includes("Flush: 0 sessions to process")) {
            ctx.ui.notify("✓ All sessions up to date", "info");
            ctx.ui.setWidget("done", undefined);
            clearInterval(poll);
            return;
          }

          // Parse total pending
          const pendingMatch = text.match(/Flush: (\d+) pending/);
          if (pendingMatch) {
            total = Number(pendingMatch[1]);
            phase = "episodes";
          }

          // Count completed episodes
          const doneMatches = text.match(/  Done: /g);
          if (doneMatches) episodesDone += doneMatches.length;

          const errMatches = text.match(/Flush error: /g);
          if (errMatches) episodesFailed += errMatches.length;

          // Day cache phase
          const dayMatch = text.match(/Regenerating day cache: (\S+)/);
          if (dayMatch) {
            phase = "days";
            dayDate = dayMatch[1];
          }

          // Summary line — we're done
          const summary = text.match(/Flush: (\d+) processed, (\d+) skipped, (\d+) failed/);
          if (summary) {
            const processed = Number(summary[1]);
            const failed = Number(summary[3]);

            let msg = `✓ ${processed} episode${processed !== 1 ? "s" : ""}`;
            if (failed > 0) msg += ` (${failed} failed)`;
            msg += ", day cache updated";
            msg += " — week/month/quarter continuing in background";

            ctx.ui.notify(msg, failed > 0 ? "warn" : "info");
            ctx.ui.setWidget("done", undefined);
            clearInterval(poll);
            return;
          }

          ctx.ui.setWidget("done", [statusLine(s)]);
        } catch {
          // Don't let polling errors kill the interval
        }
      }, 500);

      function statusLine(s: string): string {
        switch (phase) {
          case "waiting":
            return `${s} Waiting for DMN...`;
          case "episodes":
            return `${s} Episodes: ${episodesDone}/${total}`;
          case "days":
            return `${s} Day cache: ${dayDate}`;
          default:
            return `${s} DMN processing...`;
        }
      }
    },
  });
}
