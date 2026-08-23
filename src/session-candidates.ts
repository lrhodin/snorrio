import { isAbsolute, relative } from "node:path";
import type { SessionInfo } from "./session-meta.ts";
import { canonicalSessionPath, type SessionLineageIndex } from "./session-lineage.ts";

/**
 * Return every session reached by the explicit lineage/dependency traversal.
 * The lineage index follows only paths named by session records; this function
 * never recursively scans an external project tree.
 */
export function lineageSessionCandidates(index: SessionLineageIndex): SessionInfo[] {
  return index.sessions.map((lineage) => ({
    id: lineage.sessionId,
    path: lineage.sessionPath,
  }));
}

export function externalLineageSessionCandidates(
  index: SessionLineageIndex,
  watchedSessionsDir: string,
): SessionInfo[] {
  const watched = canonicalSessionPath(watchedSessionsDir);
  return lineageSessionCandidates(index).filter((session) => {
    const rel = relative(watched, session.path);
    return rel.startsWith("..") || isAbsolute(rel);
  });
}
