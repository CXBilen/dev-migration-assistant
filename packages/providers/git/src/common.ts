/**
 * Helpers shared by scan, backup, plan, restore and verify: worktree enumeration with stable indices,
 * artifact ids, junk classification of ignored entries, slugs and selection parsing.
 */
import path from 'node:path'
import type { ManifestArtifact, ProjectGitInfo, ScannedArtifact } from '@devmig/model'
import { isSafeArchivePath, stableId } from '@devmig/shared'
import { relativeToPrimaryFor } from './git'
import { GIT_PROVIDER_ID, GitArtifactMeta, type IgnoredMeta } from './schema'

/** One worktree of the repository with the index used everywhere in the payload (0 = primary). */
export interface WorktreeRef {
  index: number
  path: string
  isPrimary: boolean
  branch: string | null
  head: string | null
  detached: boolean
  relativeToPrimary?: string
  locked: boolean
  prunable: boolean
}

/**
 * Enumerates the worktrees of a project in a stable order: the primary worktree first (index 0), then
 * the linked worktrees in the order the scanner listed them. The selected directory may itself be a
 * linked worktree; the primary is always taken from the worktree list.
 */
export function worktreesOf(git: ProjectGitInfo): WorktreeRef[] {
  const primary = git.worktrees.find((w) => w.isPrimary)
  if (!primary) {
    return [
      {
        index: 0,
        path: git.root,
        isPrimary: true,
        branch: git.branch,
        head: git.head,
        detached: git.detached,
        locked: false,
        prunable: false,
      },
    ]
  }
  const seen = new Set<string>([primary.path])
  const linked = git.worktrees.filter((w) => {
    if (w.isPrimary || seen.has(w.path)) return false
    seen.add(w.path)
    return true
  })
  return [primary, ...linked].map((w, index) => {
    const ref: WorktreeRef = {
      index,
      path: w.path,
      isPrimary: index === 0,
      branch: w.branch,
      head: w.head,
      detached: w.detached,
      locked: w.locked,
      prunable: w.prunable,
    }
    const rel =
      index === 0 ? undefined : (w.relativeToPrimary ?? relativeToPrimaryFor(primary.path, w.path))
    if (rel !== undefined) ref.relativeToPrimary = rel
    return ref
  })
}

// ---------------------------------------------------------------------------------------------
// artifact ids
// ---------------------------------------------------------------------------------------------

export function bundleArtifactId(projectId: string): string {
  return `${GIT_PROVIDER_ID}:${projectId}:bundle`
}
export function worktreeStateArtifactId(projectId: string, index: number): string {
  return `${GIT_PROVIDER_ID}:${projectId}:worktree:${index}:state`
}
export function untrackedSensitiveArtifactId(projectId: string, index: number): string {
  return `${GIT_PROVIDER_ID}:${projectId}:worktree:${index}:untracked-sensitive`
}
export function ignoredArtifactId(projectId: string, index: number, slug: string): string {
  return `${GIT_PROVIDER_ID}:${projectId}:worktree:${index}:ignored:${slug}`
}
export function junkArtifactId(projectId: string, index: number, slug: string): string {
  return `${GIT_PROVIDER_ID}:${projectId}:worktree:${index}:junk:${slug}`
}

/** Filesystem/artifact-id safe slug for a repo-relative path; unique thanks to the hash suffix. */
export function slugForPath(relPath: string): string {
  const trimmed = relPath.replace(/\/+$/, '')
  const base = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 60)
  return `${base || 'entry'}-${stableId(trimmed, 8)}`
}

// ---------------------------------------------------------------------------------------------
// junk classification
// ---------------------------------------------------------------------------------------------

const JUNK_NAMES = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
  '.DS_Store',
  '__pycache__',
  '.pytest_cache',
  'target',
  '.gradle',
  'Pods',
  'DerivedData',
  '.parcel-cache',
  '.nuxt',
  '.svelte-kit',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  'bower_components',
  '.eslintcache',
])

/** True for build output, dependency and cache directories that are never worth migrating. */
export function isJunkPath(relPath: string): boolean {
  const trimmed = relPath.replace(/\/+$/, '')
  const name = path.posix.basename(trimmed)
  if (JUNK_NAMES.has(name)) return true
  return name.toLowerCase().endsWith('.log')
}

/** Depth of a repo-relative POSIX path (`a` = 1, `a/b` = 2). Trailing slashes are ignored. */
export function pathDepth(relPath: string): number {
  return relPath
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s !== '').length
}

// ---------------------------------------------------------------------------------------------
// selection parsing (scan artifacts at backup time, manifest artifacts at restore time)
// ---------------------------------------------------------------------------------------------

export interface IgnoredSelection extends IgnoredMeta {
  artifactId: string
  payloadPath?: string
  label: string
}

export interface GitSelection {
  bundle: boolean
  bundleArtifactId?: string
  /** worktree index -> artifact id of the selected state artifact */
  worktreeStates: Map<number, string>
  /** worktree index -> artifact id of the selected sensitive-untracked artifact */
  sensitive: Map<number, string>
  ignored: IgnoredSelection[]
  /** Payload-relative path of repository.json when any artifact carried it. */
  repositoryJson?: string
  warnings: string[]
}

type AnyArtifact = Pick<ScannedArtifact, 'id' | 'meta' | 'label'> & { payloadPath?: string }

/** Interprets the selected artifacts through their typed meta. Unknown artifacts are reported, never guessed. */
export function parseSelection(
  artifacts: readonly (ScannedArtifact | ManifestArtifact)[],
): GitSelection {
  const selection: GitSelection = {
    bundle: false,
    worktreeStates: new Map(),
    sensitive: new Map(),
    ignored: [],
    warnings: [],
  }
  for (const artifact of artifacts as readonly AnyArtifact[]) {
    const parsed = GitArtifactMeta.safeParse(artifact.meta)
    if (!parsed.success) {
      selection.warnings.push(`Artifact ${artifact.id} has unrecognised metadata and was skipped.`)
      continue
    }
    const meta = parsed.data
    if (meta.repositoryJson && isSafeArchivePath(meta.repositoryJson)) {
      selection.repositoryJson ??= meta.repositoryJson
    }
    switch (meta.kind) {
      case 'bundle':
        selection.bundle = true
        selection.bundleArtifactId = artifact.id
        break
      case 'worktree-state':
        selection.worktreeStates.set(meta.worktreeIndex, artifact.id)
        break
      case 'untracked-sensitive':
        selection.sensitive.set(meta.worktreeIndex, artifact.id)
        break
      case 'ignored':
        selection.ignored.push({
          ...meta,
          artifactId: artifact.id,
          label: artifact.label,
          ...(artifact.payloadPath ? { payloadPath: artifact.payloadPath } : {}),
        })
        break
      case 'junk':
        selection.warnings.push(
          `Artifact ${artifact.id} is shown for transparency only and was skipped.`,
        )
        break
      default:
        break
    }
  }
  return selection
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : ''
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}
