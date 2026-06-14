/** Generate the opaque per-invocation run id used for correlation. */
export function generateRunId(): string {
  return `run_${crypto.randomUUID()}`;
}
