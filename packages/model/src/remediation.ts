import { z } from 'zod'

/**
 * A structured "what to do about it" attached to attention items and bootstrap actions. `command` is
 * an argv array so it can be displayed unambiguously and, from v0.2, executed without a shell after
 * explicit user consent.
 */
export const Remediation = z.object({
  /** Stable id, e.g. `install-claude-code`. */
  id: z.string().min(1).max(64),
  title: z.string().min(1),
  detail: z.string().optional(),
  /** Suggested command as argv. First element is the executable. */
  command: z.array(z.string().min(1)).min(1).optional(),
  /** Working directory the command expects (project root for `pnpm install`). */
  cwd: z.string().optional(),
  /** Documentation or download page. */
  url: z.string().url().optional(),
  /** True when running the command uses the network (installs, logins). */
  network: z.boolean().optional(),
  /** True when the command needs a terminal (device-flow logins, prompts). */
  interactive: z.boolean().optional(),
})
export type Remediation = z.infer<typeof Remediation>
