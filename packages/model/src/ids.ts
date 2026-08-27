import { z } from 'zod'

/** Provider identifiers. String-extensible so future providers need no core change. */
export const KnownProviderId = z.enum(['claude-code', 'git', 'project-files', 'runtime'])
export type KnownProviderId = z.infer<typeof KnownProviderId>
export const ProviderId = z.string().min(1).max(64)
export type ProviderId = z.infer<typeof ProviderId>

export const ProjectId = z.string().min(1).max(128)
export type ProjectId = z.infer<typeof ProjectId>

export const ArtifactId = z.string().min(1).max(256)
export type ArtifactId = z.infer<typeof ArtifactId>

export const JobId = z.string().min(1).max(128)
export type JobId = z.infer<typeof JobId>

/** ISO-8601 timestamp string. */
export const IsoDate = z.string().min(1)
export type IsoDate = z.infer<typeof IsoDate>
