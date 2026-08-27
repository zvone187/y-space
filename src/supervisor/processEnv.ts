import { sanitizePrivilegedChildEnvironment } from "@/supervisor/privilegedChildEnvironment";

/**
 * Snapshot `process.env` as a plain string→string record, dropping any keys
 * whose value is `undefined`. With `exactOptionalPropertyTypes`, spreading
 * `process.env` directly leaks `undefined` values that don't satisfy the
 * `Record<string, string>` env shapes that node-pty (and our merged spawn
 * envs) expect — the filter is the whole point.
 */
export function processEnvRecord(): Record<string, string> {
  return sanitizePrivilegedChildEnvironment(process.env);
}
