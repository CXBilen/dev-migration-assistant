import { z } from 'zod'
import { ProjectId, ProviderId } from './ids'

export const GitWorktreeInfo = z.object({
  /** Absolute canonical path of the worktree directory. */
  path: z.string(),
  /** Branch name without refs/heads/, or null when detached. */
  branch: z.string().nullable(),
  head: z.string().nullable(),
  isPrimary: z.boolean(),
  detached: z.boolean().default(false),
  locked: z.boolean().default(false),
  prunable: z.boolean().default(false),
  /** Path relative to the primary worktree when it can be expressed that way (e.g. "../looplift-onboarding"). */
  relativeToPrimary: z.string().optional(),
})
export type GitWorktreeInfo = z.infer<typeof GitWorktreeInfo>

export const GitRemoteInfo = z.object({
  name: z.string(),
  fetchUrl: z.string(),
  pushUrl: z.string().optional(),
})
export type GitRemoteInfo = z.infer<typeof GitRemoteInfo>

export const ProjectGitInfo = z.object({
  /** Top-level of the working tree containing the selected directory. */
  root: z.string(),
  /** The common .git dir (shared between worktrees). */
  commonDir: z.string().optional(),
  remotes: z.array(GitRemoteInfo).default([]),
  head: z.string().nullable(),
  branch: z.string().nullable(),
  detached: z.boolean().default(false),
  /** True when the selected directory is itself a linked worktree rather than the primary one. */
  isLinkedWorktree: z.boolean().default(false),
  worktrees: z.array(GitWorktreeInfo).default([]),
})
export type ProjectGitInfo = z.infer<typeof ProjectGitInfo>

/**
 * A user-selected project, canonicalized. Paths are absolute.
 * - originalPath: exactly what the user selected (may contain ~, symlinks, trailing slash)
 * - canonicalPath: normalized absolute path (~ expanded, trailing slash removed, NFC)
 * - realPath: canonicalPath with symlinks resolved
 */
export const ProjectDescriptor = z.object({
  id: ProjectId,
  name: z.string().min(1),
  originalPath: z.string(),
  canonicalPath: z.string(),
  realPath: z.string(),
  git: ProjectGitInfo.optional(),
  detectedProviders: z.array(ProviderId).default([]),
})
export type ProjectDescriptor = z.infer<typeof ProjectDescriptor>
