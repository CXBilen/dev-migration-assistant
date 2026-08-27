import { z } from 'zod'
import { ProviderId } from './ids'
import { MachineInfo } from './machine'

export const ProviderStatus = z.object({
  id: ProviderId,
  displayName: z.string(),
  version: z.string(),
  available: z.boolean(),
  details: z.record(z.string(), z.string()).default({}),
  notes: z.array(z.string()).default([]),
})
export type ProviderStatus = z.infer<typeof ProviderStatus>

export const Diagnostics = z.object({
  appVersion: z.string(),
  backupFormatVersion: z.number().int(),
  electronVersion: z.string().nullable(),
  nodeVersion: z.string(),
  machine: MachineInfo,
  claudeConfigDir: z.string().nullable(),
  claudeConfigDirExists: z.boolean(),
  claudeCodeVersion: z.string().nullable(),
  providers: z.array(ProviderStatus),
  logsDirectory: z.string(),
  generatedAt: z.string(),
})
export type Diagnostics = z.infer<typeof Diagnostics>
