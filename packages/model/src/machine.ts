import { z } from 'zod'

/** Where an executable came from (informational; derived from its resolved path). */
export const InstallMethod = z.enum([
  'native',
  'homebrew',
  'npm-global',
  'corepack',
  'version-manager',
  'system',
  'manual',
  'unknown',
])
export type InstallMethod = z.infer<typeof InstallMethod>

export const ToolVersion = z.object({
  id: z.string(),
  label: z.string(),
  version: z.string().nullable(),
  path: z.string().nullable().optional(),
  installMethod: InstallMethod.optional(),
  installed: z.boolean(),
})
export type ToolVersion = z.infer<typeof ToolVersion>

/** Informational environment manifest captured at backup time (machine.json). Contains no secrets. */
export const MachineInfo = z.object({
  platform: z.string(),
  arch: z.string(),
  osVersion: z.string().nullable(),
  /** Non-identifying label (e.g. "MacBook Air"); hostname itself is not stored unless the user opts in. */
  machineLabel: z.string().nullable(),
  homeDir: z.string(),
  userName: z.string(),
  tools: z.array(ToolVersion),
  capturedAt: z.string(),
})
export type MachineInfo = z.infer<typeof MachineInfo>
