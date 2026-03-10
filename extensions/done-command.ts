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
      ctx.ui.notify("DMN flush triggered", "info");

      // Find today's log file
      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(LOG_DIR, `${today}.log`);

      let logOffset: number;
      try { logOffset = fs.statSync(logFile).size; } catch { logOffset = 0; }

      const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let spinIdx = 0;
      let sawDMN = false;
      const started = Date.now();

      const poll = setInterval(() => {
        try {
          spinIdx = (spinIdx + 1) % SPINNER.length;

          if (Date.now() - started > 300_000) {
            ctx.ui.setWidget("done", undefined);
            clearInterval(poll);
            return;
          }

          let stat;
          try { stat = fs.statSync(logFile); } catch { return; }
          if (stat.size <= logOffset) {
            ctx.ui.setWidget("done", [sawDMN
              ? `${SPINNER[spinIdx]} DMN processing...`
              : `${SPINNER[spinIdx]} Waiting for DMN...`]);
            return;
          }

          sawDMN = true;

          const fd = fs.openSync(logFile, "r");
          const buf = Buffer.alloc(stat.size - logOffset);
          fs.readSync(fd, buf, 0, buf.length, logOffset);
          fs.closeSync(fd);
          logOffset = stat.size;

          const text = buf.toString("utf8");

          if (text.includes("Flush: 0 sessions to process")) {
            ctx.ui.setWidget("done", ["✓ All sessions up to date"]);
            clearInterval(poll);
            setTimeout(() => ctx.ui.setWidget("done", undefined), 5000);
            return;
          }

          const m = text.match(/Flush: (\d+) processed, (\d+) skipped, (\d+) failed/);
          if (m) {
            const processed = Number(m[1]);
            const failed = Number(m[3]);
            let msg = `✓ ${processed} processed`;
            if (failed > 0) msg += `, ${failed} failed`;
            ctx.ui.setWidget("done", [msg]);
            clearInterval(poll);
            setTimeout(() => ctx.ui.setWidget("done", undefined), 5000);
            return;
          }

          ctx.ui.setWidget("done", [`${SPINNER[spinIdx]} DMN processing...`]);
        } catch {
          // Don't let polling errors kill the interval
        }
      }, 500);
    },
  });
}
