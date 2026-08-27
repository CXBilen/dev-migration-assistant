import { z } from 'zod'
import { ProviderScanResult } from './artifacts'
import { IsoDate } from './ids'
import { ProjectDescriptor } from './project'

export const ProjectScanResult = z.object({
  project: ProjectDescriptor,
  providers: z.array(ProviderScanResult),
  estimatedBytes: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string()).default([]),
})
export type ProjectScanResult = z.infer<typeof ProjectScanResult>

/** The result of scanning a set of selected projects; the input to backup planning. */
export const ScanSession = z.object({
  id: z.string(),
  createdAt: IsoDate,
  projects: z.array(ProjectScanResult),
  /** User-scoped ("global") provider results, e.g. Global Claude Code Environment. */
  global: z.array(ProviderScanResult).default([]),
  warnings: z.array(z.string()).default([]),
})
export type ScanSession = z.infer<typeof ScanSession>
