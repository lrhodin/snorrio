// Pi extension — signals subagent turn completion via tmux.
// Only active when SUBAGENT_SESSION env var is set (by subagent spawn).

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, writeFileSync, unlinkSync } from "fs";

export default function (pi: ExtensionAPI) {
  const sessionName = process.env.SUBAGENT_SESSION;
  if (!sessionName) return;

  const markerFile = `/tmp/subagent-signaled-${sessionName}`;

  const clearMarker = () => {
    try { unlinkSync(markerFile); } catch {}
  };

  const signalDone = async () => {
    if (!existsSync(markerFile)) {
      writeFileSync(markerFile, "done");
      await pi.exec("tmux", ["wait-for", "-S", `done-${sessionName}`]);
    }
  };

  const signalFailed = async () => {
    if (!existsSync(markerFile)) {
      writeFileSync(markerFile, "failed");
      await pi.exec("tmux", ["wait-for", "-S", `failed-${sessionName}`]);
    }
  };

  pi.on("agent_start", clearMarker);
  pi.on("agent_end", signalDone);
  pi.on("session_shutdown", signalFailed);
}
