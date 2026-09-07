declare global {
  var __piModelConfigRevision: number | undefined;
}

export function getModelConfigRevision(): number {
  return globalThis.__piModelConfigRevision ?? 0;
}

/** Notify live AgentSession wrappers that models.json changed on disk. */
export function markModelConfigChanged(): number {
  const next = getModelConfigRevision() + 1;
  globalThis.__piModelConfigRevision = next;
  return next;
}
