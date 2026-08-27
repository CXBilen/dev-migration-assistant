/**
 * ClaudeProjectResolver (ADR-0004): associates <claudeConfigDir>/projects/<dir> entries with a
 * selected project using transcript `cwd` evidence, registered Git worktrees, Claude-managed
 * worktrees (<project>/.claude/worktrees/*), ~/.claude.json project keys and history.jsonl rows.
 * The directory-name encoding is only corroborating evidence, never the sole proof.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectDescriptor } from '@devmig/model'
import { canonicalizePath, dirSize, throwIfAborted, type Logger } from '@devmig/shared'
import { MAX_SAMPLED_TRANSCRIPTS_PER_DIR } from './constants'
import { encodeProjectDirName, type EncodingSample } from './encoding'
import { readClaudeJson } from './claude-json'
import { isExistingDirectory, isExistingFile, listDirectory } from './fs-helpers'
import { readHistoryRows } from './history'
import { sampleTranscriptMetadata } from './transcript'

export type ClaudeMatchKind = 'project' | 'worktree' | 'claude-worktree'
export type ClaudeMatchConfidence = 'exact' | 'strong' | 'weak'

export interface ClaudeProjectMatch {
  /** Absolute path of <claudeConfigDir>/projects/<dirName>. */
  sourceDirectory: string
  dirName: string
  /** The working directory this project dir represents (used as the remap source path). */
  matchedProjectPath: string
  kind: ClaudeMatchKind
  confidence: ClaudeMatchConfidence
  evidence: string[]
  sessionIds: string[]
  sessionCount: number
  /** Bytes of transcripts + per-session directories (auto memory excluded). */
  sizeBytes: number
  hasMemory: boolean
  /** Distinct cwd values seen in the sampled transcripts. */
  cwds: string[]
  claudeVersions: string[]
}

export interface ResolveContext {
  claudeConfigDir: string
  claudeJsonPath: string
  allProjects: readonly ProjectDescriptor[]
  signal?: AbortSignal
  logger?: Logger
}

export interface ResolveResult {
  matches: ClaudeProjectMatch[]
  warnings: string[]
  /** Encoding samples of EVERY candidate directory (for verifyEncoding). */
  encodingSamples: EncodingSample[]
}

/** A projects/<dir> directory with its sampled evidence. */
export interface CandidateDir {
  dirName: string
  directory: string
  sessionIds: string[]
  cwds: string[]
  claudeVersions: string[]
  hasMemory: boolean
  /** cwd -> number of sampled transcripts reporting it. */
  cwdVotes: Map<string, number>
}

const SESSION_FILE_RE = /^([A-Za-z0-9._-]+)\.jsonl$/
/** Files this provider writes next to transcripts during merges; never sessions. */
const PROVIDER_SIDE_FILE_RE = /\.devmig-/

export function sessionIdFromFileName(name: string): string | null {
  const m = SESSION_FILE_RE.exec(name)
  if (!m || !m[1] || m[1].startsWith('.') || PROVIDER_SIDE_FILE_RE.test(m[1])) return null
  return m[1]
}

type Relation = 'exact' | 'child' | 'worktree' | 'worktree-child' | 'claude-worktree' | 'none'

interface ProjectShape {
  project: ProjectDescriptor
  paths: string[]
  worktrees: string[]
  claudeWorktreesPrefix: string
  depth: number
}

function shapeOf(project: ProjectDescriptor): ProjectShape {
  const paths = [
    ...new Set([canonicalizePath(project.realPath), canonicalizePath(project.canonicalPath)]),
  ]
  const worktrees = (project.git?.worktrees ?? [])
    .map((w) => canonicalizePath(w.path))
    .filter((p) => !paths.includes(p))
  const real = canonicalizePath(project.realPath)
  return {
    project,
    paths,
    worktrees,
    claudeWorktreesPrefix: path.join(real, '.claude', 'worktrees'),
    depth: real.split(path.sep).filter(Boolean).length,
  }
}

function isChild(parent: string, candidate: string): boolean {
  return candidate.startsWith(`${parent}${path.sep}`)
}

function relate(rawPath: string, shape: ProjectShape): Relation {
  const p = canonicalizePath(rawPath)
  if (shape.paths.includes(p)) return 'exact'
  if (p === shape.claudeWorktreesPrefix || isChild(shape.claudeWorktreesPrefix, p))
    return 'claude-worktree'
  if (shape.worktrees.includes(p)) return 'worktree'
  if (shape.worktrees.some((w) => isChild(w, p))) return 'worktree-child'
  if (shape.paths.some((base) => isChild(base, p))) return 'child'
  return 'none'
}

function nameRelation(
  dirName: string,
  shape: ProjectShape,
): { relation: Relation; path: string; truncated: boolean } | null {
  for (const p of shape.paths) {
    const enc = encodeProjectDirName(p)
    if (enc.truncated ? dirName.startsWith(enc.name) : dirName === enc.name) {
      return { relation: 'exact', path: p, truncated: enc.truncated }
    }
  }
  for (const w of shape.worktrees) {
    const enc = encodeProjectDirName(w)
    if (enc.truncated ? dirName.startsWith(enc.name) : dirName === enc.name) {
      return { relation: 'worktree', path: w, truncated: enc.truncated }
    }
  }
  const cw = encodeProjectDirName(`${shape.claudeWorktreesPrefix}${path.sep}`)
  if (dirName.startsWith(cw.name) && dirName.length > cw.name.length) {
    const rest = dirName.slice(cw.name.length)
    return {
      relation: 'claude-worktree',
      path: path.join(shape.claudeWorktreesPrefix, rest),
      truncated: cw.truncated,
    }
  }
  return null
}

function kindFor(relations: readonly Relation[]): ClaudeMatchKind {
  if (relations.includes('claude-worktree')) return 'claude-worktree'
  if (relations.includes('worktree') || relations.includes('worktree-child')) return 'worktree'
  return 'project'
}

const RANK: Record<ClaudeMatchConfidence, number> = { exact: 3, strong: 2, weak: 1 }

export interface MatchEvidence {
  claudeJsonKeys: string[]
  /** sessionId -> project path recorded in history.jsonl */
  historyBySession: Map<string, string>
}

export interface MatchOutcome {
  match: ClaudeProjectMatch | null
  warning?: string
}

/** Pure matching of one candidate directory against one project. Returns null when unrelated. */
export function matchCandidate(
  candidate: CandidateDir,
  project: ProjectDescriptor,
  evidence: MatchEvidence,
): MatchOutcome | null {
  const shape = shapeOf(project)
  const evidenceLines: string[] = []
  const relations = candidate.cwds.map((c) => ({ cwd: c, relation: relate(c, shape) }))
  const related = relations.filter((r) => r.relation !== 'none')
  const foreign = relations.filter((r) => r.relation === 'none')
  const name = nameRelation(candidate.dirName, shape)
  const jsonAgree = evidence.claudeJsonKeys.filter((k) => {
    const enc = encodeProjectDirName(k)
    return !enc.truncated && enc.name === candidate.dirName && relate(k, shape) !== 'none'
  })
  const historyAgree = new Map<string, number>()
  for (const sid of candidate.sessionIds) {
    const p = evidence.historyBySession.get(sid)
    if (!p) continue
    const enc = encodeProjectDirName(p)
    if (!enc.truncated && enc.name === candidate.dirName && relate(p, shape) !== 'none') {
      historyAgree.set(p, (historyAgree.get(p) ?? 0) + 1)
    }
  }

  let confidence: ClaudeMatchConfidence
  let kind: ClaudeMatchKind
  let matchedPath: string | undefined
  let warning: string | undefined

  if (candidate.cwds.length > 0) {
    if (related.length === 0) {
      if (name) {
        warning = `Claude project directory "${candidate.dirName}" reproduces the name of ${name.path} but its transcripts ran in ${candidate.cwds.slice(0, 2).join(', ')}; it was not attributed to ${project.name}.`
        return { match: null, warning }
      }
      return null
    }
    const exact = related.find((r) => r.relation === 'exact')
    const encodedMatch = related.find((r) => {
      const enc = encodeProjectDirName(r.cwd)
      return !enc.truncated && enc.name === candidate.dirName
    })
    for (const r of related) {
      const votes = candidate.cwdVotes.get(r.cwd) ?? 0
      evidenceLines.push(
        r.relation === 'exact'
          ? `cwd equals the project path (${votes} sampled transcript${votes === 1 ? '' : 's'})`
          : r.relation === 'worktree'
            ? `cwd equals registered worktree ${r.cwd}`
            : r.relation === 'worktree-child'
              ? `cwd ${r.cwd} is inside a registered worktree`
              : r.relation === 'claude-worktree'
                ? `cwd ${r.cwd} is a Claude-managed worktree of the project`
                : `cwd ${r.cwd} is inside the project`,
      )
    }
    for (const f of foreign) evidenceLines.push(`cwd ${f.cwd} is unrelated to the project`)
    if (encodedMatch)
      evidenceLines.push(`directory name reproduces the encoding of ${encodedMatch.cwd}`)
    kind = kindFor(related.map((r) => r.relation))
    if (exact) {
      confidence = 'exact'
      matchedPath = exact.cwd
    } else if (foreign.length === 0 || name || jsonAgree.length > 0 || historyAgree.size > 0) {
      confidence = 'strong'
      matchedPath = encodedMatch?.cwd ?? related[0]?.cwd
    } else {
      confidence = 'weak'
      matchedPath = encodedMatch?.cwd ?? related[0]?.cwd
      evidenceLines.push('mixed cwd evidence; review before including')
    }
  } else {
    const jsonPath = jsonAgree[0]
    const historyPath = [...historyAgree.keys()][0]
    if (name) {
      evidenceLines.push(
        name.truncated
          ? `directory name starts with the (truncated) encoding of ${name.path}; the hash suffix cannot be verified`
          : `directory name reproduces the encoding of ${name.path} (no cwd evidence in transcripts)`,
      )
      kind = kindFor([name.relation])
      matchedPath = jsonPath ?? historyPath ?? name.path
      confidence = jsonPath || historyPath ? 'strong' : 'weak'
    } else if (jsonPath || historyPath) {
      const p = (jsonPath ?? historyPath) as string
      kind = kindFor([relate(p, shape)])
      matchedPath = p
      confidence = 'strong'
    } else {
      return null
    }
  }
  if (jsonAgree.length > 0) evidenceLines.push(`~/.claude.json has an entry for ${jsonAgree[0]}`)
  for (const [p, n] of historyAgree) {
    evidenceLines.push(`history.jsonl attributes ${n} session${n === 1 ? '' : 's'} to ${p}`)
  }
  if (!matchedPath) return null
  return {
    match: {
      sourceDirectory: candidate.directory,
      dirName: candidate.dirName,
      matchedProjectPath: matchedPath,
      kind,
      confidence,
      evidence: evidenceLines,
      sessionIds: [...candidate.sessionIds],
      sessionCount: candidate.sessionIds.length,
      sizeBytes: 0,
      hasMemory: candidate.hasMemory,
      cwds: [...candidate.cwds],
      claudeVersions: [...candidate.claudeVersions],
    },
    ...(warning ? { warning } : {}),
  }
}

/** Enumerates <claudeConfigDir>/projects/* and samples transcript evidence for each directory. */
export async function enumerateCandidates(
  claudeConfigDir: string,
  options: { signal?: AbortSignal; maxTranscripts?: number; logger?: Logger } = {},
): Promise<CandidateDir[]> {
  const projectsDir = path.join(claudeConfigDir, 'projects')
  const maxTranscripts = options.maxTranscripts ?? MAX_SAMPLED_TRANSCRIPTS_PER_DIR
  const candidates: CandidateDir[] = []
  for (const entry of await listDirectory(projectsDir)) {
    throwIfAborted(options.signal)
    if (!entry.isDirectory()) continue
    const directory = path.join(projectsDir, entry.name)
    const transcripts: { file: string; sessionId: string; mtimeMs: number; size: number }[] = []
    for (const child of await listDirectory(directory)) {
      if (!child.isFile()) continue
      const sid = sessionIdFromFileName(child.name)
      if (!sid) continue
      const file = path.join(directory, child.name)
      let st
      try {
        st = await fs.stat(file)
      } catch {
        continue
      }
      transcripts.push({ file, sessionId: sid, mtimeMs: st.mtimeMs, size: st.size })
    }
    transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size)
    const cwdVotes = new Map<string, number>()
    const versions = new Set<string>()
    for (const t of transcripts.slice(0, maxTranscripts)) {
      throwIfAborted(options.signal)
      try {
        const meta = await sampleTranscriptMetadata(t.file, {
          ...(options.signal ? { signal: options.signal } : {}),
        })
        for (const cwd of meta.cwds) cwdVotes.set(cwd, (cwdVotes.get(cwd) ?? 0) + 1)
        for (const v of meta.versions) versions.add(v)
      } catch (err) {
        if ((err as { code?: string }).code === 'CANCELLED') throw err
        options.logger?.warn('Could not sample transcript', { file: t.file })
      }
    }
    candidates.push({
      dirName: entry.name,
      directory,
      sessionIds: transcripts.map((t) => t.sessionId).sort(),
      cwds: [...cwdVotes.keys()],
      claudeVersions: [...versions].sort(),
      hasMemory: await isExistingDirectory(path.join(directory, 'memory')),
      cwdVotes,
    })
  }
  candidates.sort((a, b) => a.dirName.localeCompare(b.dirName))
  return candidates
}

async function collectEvidence(ctx: ResolveContext): Promise<MatchEvidence> {
  const evidence: MatchEvidence = { claudeJsonKeys: [], historyBySession: new Map() }
  try {
    const json = await readClaudeJson(ctx.claudeJsonPath)
    evidence.claudeJsonKeys = Object.keys(json?.projects ?? {})
  } catch (err) {
    ctx.logger?.warn('Could not read ~/.claude.json for matching evidence', {
      file: ctx.claudeJsonPath,
      error: (err as Error).message,
    })
  }
  const historyFile = path.join(ctx.claudeConfigDir, 'history.jsonl')
  if (await isExistingFile(historyFile)) {
    try {
      for await (const line of readHistoryRows(
        historyFile,
        ctx.signal ? { signal: ctx.signal } : {},
      )) {
        if (line.row.sessionId && line.row.project) {
          evidence.historyBySession.set(line.row.sessionId, line.row.project)
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'CANCELLED') throw err
      ctx.logger?.warn('Could not read history.jsonl for matching evidence', { file: historyFile })
    }
  }
  return evidence
}

function compareClaims(
  a: { confidence: ClaudeMatchConfidence; shape: ProjectShape },
  b: { confidence: ClaudeMatchConfidence; shape: ProjectShape },
): number {
  const byRank = RANK[b.confidence] - RANK[a.confidence]
  if (byRank !== 0) return byRank
  const byDepth = b.shape.depth - a.shape.depth
  if (byDepth !== 0) return byDepth
  return a.shape.project.realPath.localeCompare(b.shape.project.realPath)
}

export class ClaudeProjectResolver {
  /** Resolves the Claude project directories that belong to `project`, deduplicated across all selected projects. */
  async resolve(project: ProjectDescriptor, ctx: ResolveContext): Promise<ResolveResult> {
    const candidates = await enumerateCandidates(ctx.claudeConfigDir, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.logger ? { logger: ctx.logger } : {}),
    })
    const evidence = await collectEvidence(ctx)
    const others = ctx.allProjects.filter((p) => p.id !== project.id)
    const matches: ClaudeProjectMatch[] = []
    const warnings: string[] = []
    for (const candidate of candidates) {
      throwIfAborted(ctx.signal)
      const mine = matchCandidate(candidate, project, evidence)
      if (!mine) continue
      if (!mine.match) {
        if (mine.warning) warnings.push(mine.warning)
        continue
      }
      const claims = [{ confidence: mine.match.confidence, shape: shapeOf(project), project }]
      for (const other of others) {
        const theirs = matchCandidate(candidate, other, evidence)
        if (theirs?.match) {
          claims.push({
            confidence: theirs.match.confidence,
            shape: shapeOf(other),
            project: other,
          })
        }
      }
      if (claims.length > 1) {
        claims.sort(compareClaims)
        const winner = claims[0] as (typeof claims)[number]
        const names = claims.map((c) => c.project.name).join(', ')
        if (winner.project.id !== project.id) {
          warnings.push(
            `CLAUDE_PROJECT_AMBIGUOUS: Claude project directory "${candidate.dirName}" is claimed by ${names}; it was assigned to "${winner.project.name}" (${winner.project.realPath}).`,
          )
          continue
        }
        warnings.push(
          `CLAUDE_PROJECT_AMBIGUOUS: Claude project directory "${candidate.dirName}" is also claimed by ${claims
            .slice(1)
            .map((c) => c.project.name)
            .join(', ')}; it was assigned to "${project.name}".`,
        )
      }
      const size = await dirSize(candidate.directory, {
        filter: (rel) => rel !== 'memory' && !rel.startsWith('memory/'),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      matches.push({ ...mine.match, sizeBytes: size.bytes })
    }
    matches.sort(
      (a, b) => RANK[b.confidence] - RANK[a.confidence] || a.dirName.localeCompare(b.dirName),
    )
    return {
      matches,
      warnings,
      encodingSamples: candidates.map((c) => ({ dirName: c.dirName, cwds: [...c.cwds] })),
    }
  }
}

/** Encoding samples for every project directory of a config dir (used on the destination during planning). */
export async function collectEncodingSamples(
  claudeConfigDir: string,
  options: { signal?: AbortSignal; maxDirs?: number } = {},
): Promise<EncodingSample[]> {
  const candidates = await enumerateCandidates(claudeConfigDir, {
    ...(options.signal ? { signal: options.signal } : {}),
    maxTranscripts: 2,
  })
  const limited = options.maxDirs !== undefined ? candidates.slice(0, options.maxDirs) : candidates
  return limited
    .filter((c) => c.sessionIds.length > 0)
    .map((c) => ({ dirName: c.dirName, cwds: [...c.cwds] }))
}
