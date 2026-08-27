/**
 * Structured path remapping (ADR-0005). The mapper answers "where does this old absolute path live
 * now?" using prefix-aware, segment-boundary-safe comparison. Providers own the field-level rewrites;
 * this module only computes the mapping itself.
 */
import path from 'node:path'
import type { ManifestProject, PathMapping, PathRemapReport } from '@devmig/model'
import { MigrationError, canonicalizePath, expandHome } from '@devmig/shared'

export interface MapPathResult {
  newPath: string
  /** True when newPath differs from the input path. */
  changed: boolean
  /** True when a mapping applied (even if old == new). */
  mapped: boolean
}

export interface PathMapper {
  readonly mappings: PathMapping[]
  /** Property (not a method) so it can be passed around detached without losing `this`. */
  readonly mapPath: (oldPath: string) => MapPathResult
}

export interface CreatePathMapperOptions {
  /** Home directory used to expand a leading `~` (defaults to the process home). */
  homeDir?: string
}

interface CompiledMapping {
  mapping: PathMapping
  oldCanonical: string
  newCanonical: string
}

function canonicalAbsolute(p: string, homeDir: string | undefined, what: string): string {
  const expanded = expandHome(p.trim(), homeDir)
  if (!path.isAbsolute(expanded)) {
    throw new MigrationError('INVALID_INPUT', `${what} must be an absolute path: ${p}`, {
      details: { path: p },
    })
  }
  return canonicalizePath(expanded, homeDir)
}

/** True when `candidate` equals `prefix` or is located inside it (segment-boundary aware). */
export function isPrefixPath(prefix: string, candidate: string): boolean {
  if (candidate === prefix) return true
  const withSep = prefix.endsWith(path.sep) ? prefix : prefix + path.sep
  return candidate.startsWith(withSep)
}

export function createPathMapper(
  mappings: PathMapping[],
  options: CreatePathMapperOptions = {},
): PathMapper {
  const homeDir = options.homeDir
  const compiled: CompiledMapping[] = []
  const seen = new Map<string, CompiledMapping>()
  for (const mapping of mappings) {
    const oldCanonical = canonicalAbsolute(mapping.oldPath, homeDir, 'mapping.oldPath')
    const newCanonical = canonicalAbsolute(mapping.newPath, homeDir, 'mapping.newPath')
    const existing = seen.get(oldCanonical)
    if (existing) {
      if (existing.newCanonical !== newCanonical) {
        throw new MigrationError(
          'INVALID_INPUT',
          `Conflicting mappings for ${oldCanonical}: ${existing.newCanonical} vs ${newCanonical}`,
          { details: { oldPath: oldCanonical } },
        )
      }
      continue
    }
    const entry: CompiledMapping = { mapping, oldCanonical, newCanonical }
    seen.set(oldCanonical, entry)
    compiled.push(entry)
  }
  // Longest prefix first so the most specific mapping wins.
  compiled.sort((a, b) => b.oldCanonical.length - a.oldCanonical.length)

  const mapPath = (oldPath: string): MapPathResult => {
    const trimmed = oldPath.trim()
    if (trimmed === '') return { newPath: oldPath, changed: false, mapped: false }
    const expanded = expandHome(trimmed, homeDir)
    if (!path.isAbsolute(expanded)) return { newPath: oldPath, changed: false, mapped: false }
    const canonical = canonicalizePath(expanded, homeDir)
    const hit = compiled.find((c) => isPrefixPath(c.oldCanonical, canonical))
    if (!hit) return { newPath: oldPath, changed: false, mapped: false }
    const remainder = canonical.slice(hit.oldCanonical.length).replace(/^[\\/]+/, '')
    const newPath = remainder ? path.join(hit.newCanonical, remainder) : hit.newCanonical
    return { newPath, changed: newPath !== canonical, mapped: true }
  }

  return { mappings: compiled.map((c) => c.mapping), mapPath }
}

/**
 * Derives mappings for the linked worktrees of a project that live OUTSIDE the project directory.
 * Worktrees inside the project (e.g. `.claude/worktrees/x`) follow the project mapping automatically.
 */
export function deriveWorktreeMappings(
  manifestProject: ManifestProject,
  mapping: PathMapping,
  options: CreatePathMapperOptions = {},
): PathMapping[] {
  const homeDir = options.homeDir
  const worktrees = manifestProject.git?.worktrees ?? []
  if (worktrees.length === 0) return []
  const oldProject = canonicalAbsolute(mapping.oldPath, homeDir, 'mapping.oldPath')
  const newProject = canonicalAbsolute(mapping.newPath, homeDir, 'mapping.newPath')
  const primary = worktrees.find((w) => w.isPrimary)
  const primaryPath = primary ? canonicalizePath(primary.path, homeDir) : oldProject
  const projectIsPrimary = primaryPath === oldProject

  const derived: PathMapping[] = []
  const seen = new Set<string>()
  for (const wt of worktrees) {
    const wtPath = canonicalizePath(wt.path, homeDir)
    if (wtPath === oldProject) continue
    if (isPrefixPath(oldProject, wtPath)) continue
    if (seen.has(wtPath)) continue
    seen.add(wtPath)
    let rel: string | undefined
    if (projectIsPrimary) {
      rel = wt.relativeToPrimary
    } else {
      // Project is itself a linked worktree: express the other worktree relative to it when it is a
      // sibling or a child; otherwise fall back to the basename next to the new project path.
      const candidate = path.relative(oldProject, wtPath)
      const isChild = candidate !== '' && !candidate.startsWith('..') && !path.isAbsolute(candidate)
      const isSibling = path.dirname(wtPath) === path.dirname(oldProject)
      if (isChild || isSibling) rel = candidate
    }
    const newWorktreePath = rel
      ? path.resolve(newProject, rel)
      : path.join(path.dirname(newProject), path.basename(wtPath))
    derived.push({
      projectId: manifestProject.id,
      oldPath: wtPath,
      newPath: canonicalizePath(newWorktreePath, homeDir),
    })
  }
  return derived
}

export interface ProviderRemapSection {
  providerId: string
  remap: {
    affected: { label: string; count: number }[]
    safeRewriteCount: number
    warnings: string[]
    unsupportedReferences: { location: string; reason: string }[]
  }
}

/** Merges the remap sections of several provider plans into the plan-level PathRemapReport. */
export function buildRemapReport(
  providerPlans: ProviderRemapSection[],
  mappings: PathMapping[],
): PathRemapReport {
  const report: PathRemapReport = {
    mappings: [...mappings],
    affected: [],
    safeRewriteCount: 0,
    warnings: [],
    unsupportedReferences: [],
  }
  for (const plan of providerPlans) {
    for (const a of plan.remap.affected) {
      report.affected.push({ providerId: plan.providerId, label: a.label, count: a.count })
    }
    report.safeRewriteCount += plan.remap.safeRewriteCount
    for (const w of plan.remap.warnings) report.warnings.push(w)
    for (const u of plan.remap.unsupportedReferences) {
      report.unsupportedReferences.push({
        providerId: plan.providerId,
        location: u.location,
        reason: u.reason,
      })
    }
  }
  return report
}
