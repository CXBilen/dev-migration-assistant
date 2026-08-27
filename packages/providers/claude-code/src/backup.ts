/**
 * createBackupArtifacts: copies the selected Claude Code state into the provider staging directory
 * (payload schema v1, see docs/providers/claude-code.md) and writes index.json.
 * Everything is written through ctx.fs (a ScopedFs rooted at the staging dir); sources are never touched.
 */
import path from 'node:path'
import type { BackupContext, ProviderBackupInput, ProviderBackupOutput } from '@devmig/core'
import type { ManifestArtifact, ScannedArtifact } from '@devmig/model'
import { MigrationError, isSafeArchivePath, throwIfAborted, toPosix } from '@devmig/shared'
import { extractProjectEntries, extractUserScope, readClaudeJson } from './claude-json'
import { CLAUDE_CODE_PROVIDER_ID, CLAUDE_CODE_SCHEMA_VERSION, PAYLOAD } from './constants'
import { verifyEncoding, type EncodingVerification } from './encoding'
import {
  formatJson,
  isExistingDirectory,
  isExistingFile,
  writeChunk,
  writeStreamAtomic,
} from './fs-helpers'
import { readHistoryRows } from './history'
import { collectEncodingSamples } from './resolver'
import {
  ArtifactMetaSchema,
  type ArtifactMeta,
  type BackupIndex,
  type IndexMatch,
  type ManifestMeta,
  type McpEnvMap,
} from './schema'

interface CopyStats {
  files: number
  bytes: number
}

function parseMeta(artifact: ScannedArtifact): ArtifactMeta {
  const parsed = ArtifactMetaSchema.safeParse(artifact.meta)
  if (!parsed.success) {
    throw new MigrationError(
      'INVALID_INPUT',
      `Artifact ${artifact.id} cannot be backed up: unsupported metadata`,
      {
        details: {
          artifactId: artifact.id,
          issues: parsed.error.issues.slice(0, 3).map((i) => i.message),
        },
      },
    )
  }
  return parsed.data
}

function assertRelative(rel: string, label: string): string {
  const posix = toPosix(rel)
  if (!isSafeArchivePath(posix)) {
    throw new MigrationError('INVALID_INPUT', `Unsafe ${label}: ${rel}`, { details: { rel } })
  }
  return posix
}

export async function createBackupArtifacts(
  input: ProviderBackupInput,
  ctx: BackupContext,
): Promise<ProviderBackupOutput> {
  const out: ManifestArtifact[] = []
  const warnings: string[] = []
  const section = input.project ? 'project' : 'global'
  const indexPayloadPath = ctx.payloadPathFor(PAYLOAD.index)
  const staging = (rel: string): string => path.join(ctx.stagingDir, ...rel.split('/'))

  const matches: IndexMatch[] = []
  const versions = new Set<string>()
  const memoryDirs: string[] = []
  let fileHistorySessionIds: string[] = []
  let sessionCount = 0
  let worktreeSessionSets = 0
  let projectClaudeJson: { paths: string[] } | undefined
  let mcpEnvSelected: { paths: string[] } | undefined
  let mcpEnvPending: McpEnvMap | undefined
  let mcpEnvServersExcluded: string[] = []

  const copyTree = async (
    src: string,
    destRel: string,
    filter?: (rel: string) => boolean,
  ): Promise<CopyStats> => {
    const stats = await ctx.fs.copyDir(
      src,
      staging(destRel),
      filter ? { filter: (rel) => filter(rel) } : {},
    )
    for (const link of stats.skippedSymlinks) {
      warnings.push(`Skipped symbolic link ${link} under ${src}`)
    }
    return { files: stats.files, bytes: stats.bytes }
  }
  const copyOne = async (src: string, destRel: string): Promise<CopyStats> => {
    await ctx.fs.copyFile(src, staging(destRel))
    return { files: 1, bytes: (await ctx.fs.stat(src)).size }
  }
  const manifestArtifact = (
    artifact: ScannedArtifact,
    payloadRel: string,
    stats: CopyStats,
    meta: Omit<ManifestMeta, 'indexPayloadPath'>,
    sourcePath?: string,
  ): ManifestArtifact => ({
    id: artifact.id,
    providerId: CLAUDE_CODE_PROVIDER_ID,
    kind: artifact.kind,
    label: artifact.label,
    payloadPath: ctx.payloadPathFor(payloadRel),
    sizeBytes: stats.bytes,
    fileCount: stats.files,
    sensitivity: artifact.sensitivity,
    ...(sourcePath ? { sourcePath } : {}),
    meta: { ...meta, indexPayloadPath, fileCount: stats.files },
  })

  const total = input.artifacts.length
  let done = 0
  for (const artifact of input.artifacts) {
    throwIfAborted(ctx.signal)
    if (artifact.sensitivity === 'credential' || !artifact.selectable) {
      throw new MigrationError('INVALID_INPUT', `Artifact ${artifact.id} can never be backed up`, {
        details: { artifactId: artifact.id },
      })
    }
    const meta = parseMeta(artifact)
    ctx.progress(`Collecting ${artifact.label}…`, total > 0 ? done / total : undefined, {
      id: artifact.id,
      label: artifact.label,
      status: 'running',
    })
    switch (meta.artifactKind) {
      case 'sessions': {
        const destRel = `${PAYLOAD.sessions}/${assertRelative(meta.dirName, 'directory name')}`
        const stats: CopyStats = { files: 0, bytes: 0 }
        const copied: string[] = []
        for (const sid of meta.sessionIds) {
          throwIfAborted(ctx.signal)
          assertRelative(sid, 'session id')
          const transcript = path.join(meta.sourceDirectory, `${sid}.jsonl`)
          if (!(await isExistingFile(transcript))) {
            warnings.push(`Transcript ${sid}.jsonl disappeared from ${meta.sourceDirectory}`)
            continue
          }
          const t = await copyOne(transcript, `${destRel}/${sid}.jsonl`)
          stats.files += t.files
          stats.bytes += t.bytes
          copied.push(sid)
          const sessionDir = path.join(meta.sourceDirectory, sid)
          if (await isExistingDirectory(sessionDir)) {
            const d = await copyTree(sessionDir, `${destRel}/${sid}`)
            stats.files += d.files
            stats.bytes += d.bytes
          }
        }
        for (const v of meta.claudeVersions) versions.add(v)
        sessionCount += copied.length
        if (meta.kind === 'claude-worktree') worktreeSessionSets += 1
        matches.push({
          dirName: meta.dirName,
          kind: meta.kind,
          sourcePath: meta.sourcePath,
          sessionIds: copied,
          confidence: meta.confidence,
        })
        out.push(
          manifestArtifact(
            artifact,
            destRel,
            stats,
            {
              artifactKind: 'sessions',
              dirName: meta.dirName,
              sourcePath: meta.sourcePath,
              kind: meta.kind,
              confidence: meta.confidence,
              sessionIds: copied,
            },
            meta.sourcePath,
          ),
        )
        break
      }
      case 'memory': {
        const destRel = `${PAYLOAD.memory}/${assertRelative(meta.dirName, 'directory name')}`
        const stats = await copyTree(meta.sourceDirectory, destRel)
        memoryDirs.push(meta.dirName)
        out.push(
          manifestArtifact(
            artifact,
            destRel,
            stats,
            { artifactKind: 'memory', dirName: meta.dirName, sourcePath: meta.sourcePath },
            meta.sourcePath,
          ),
        )
        break
      }
      case 'file-history':
      case 'session-env': {
        const base = meta.artifactKind === 'file-history' ? PAYLOAD.fileHistory : PAYLOAD.sessionEnv
        const stats: CopyStats = { files: 0, bytes: 0 }
        const copied: string[] = []
        for (const sid of meta.sessionIds) {
          throwIfAborted(ctx.signal)
          assertRelative(sid, 'session id')
          const dir = path.join(meta.root, sid)
          if (!(await isExistingDirectory(dir))) continue
          const s = await copyTree(dir, `${base}/${sid}`)
          stats.files += s.files
          stats.bytes += s.bytes
          copied.push(sid)
        }
        if (copied.length === 0) {
          await ctx.fs.mkdir(staging(base))
        }
        if (meta.artifactKind === 'file-history') fileHistorySessionIds = copied
        out.push(
          manifestArtifact(artifact, base, stats, {
            artifactKind: meta.artifactKind,
            sessionIds: copied,
          }),
        )
        break
      }
      case 'history': {
        let rows = 0
        let bytes = 0
        await writeStreamAtomic(ctx.fs, staging(PAYLOAD.history), async (outStream) => {
          for await (const line of readHistoryRows(meta.file, {
            paths: meta.paths,
            signal: ctx.signal,
          })) {
            rows += 1
            bytes += Buffer.byteLength(line.text, 'utf8') + 1
            await writeChunk(outStream, `${line.text}\n`)
          }
        })
        out.push(
          manifestArtifact(
            artifact,
            PAYLOAD.history,
            { files: rows, bytes },
            { artifactKind: 'history', paths: meta.paths },
          ),
        )
        break
      }
      case 'claude-json-project': {
        projectClaudeJson = { paths: meta.paths }
        break
      }
      case 'claude-json-mcp-env': {
        mcpEnvSelected = { paths: meta.paths }
        break
      }
      case 'project-file': {
        const rel = assertRelative(meta.relativePath, 'project file path')
        const destRel = `${PAYLOAD.projectFiles}/${rel}`
        const stats = await copyOne(meta.absolutePath, destRel)
        out.push(
          manifestArtifact(
            artifact,
            destRel,
            stats,
            { artifactKind: 'project-file', relativePath: rel },
            meta.absolutePath,
          ),
        )
        break
      }
      case 'global-settings':
      case 'global-claude-md':
      case 'global-skills':
      case 'global-agents':
      case 'global-output-styles':
      case 'global-commands':
      case 'global-themes':
      case 'global-statusline':
      case 'global-plugins': {
        const base = {
          'global-settings': PAYLOAD.settings,
          'global-claude-md': PAYLOAD.claudeMd,
          'global-skills': PAYLOAD.skills,
          'global-agents': PAYLOAD.agents,
          'global-output-styles': PAYLOAD.outputStyles,
          'global-commands': PAYLOAD.commands,
          'global-themes': PAYLOAD.themes,
          'global-statusline': PAYLOAD.statusline,
          'global-plugins': PAYLOAD.plugins,
        }[meta.artifactKind]
        const stats: CopyStats = { files: 0, bytes: 0 }
        const copiedEntries: string[] = []
        for (const entry of meta.entries) {
          throwIfAborted(ctx.signal)
          const rel = assertRelative(entry, 'entry')
          const src = path.join(meta.root, ...rel.split('/'))
          if (await isExistingFile(src)) {
            const s = await copyOne(src, `${base}/${rel}`)
            stats.files += s.files
            stats.bytes += s.bytes
            copiedEntries.push(rel)
          } else if (await isExistingDirectory(src)) {
            const s = await copyTree(src, `${base}/${rel}`, (childRel) => {
              const full = `${rel}/${childRel}`
              return !meta.exclude.some((ex) => full === ex || full.startsWith(`${ex}/`))
            })
            stats.files += s.files
            stats.bytes += s.bytes
            copiedEntries.push(rel)
          } else {
            warnings.push(`${entry} disappeared from ${meta.root}`)
          }
        }
        if (copiedEntries.length === 0) await ctx.fs.mkdir(staging(base))
        out.push(
          manifestArtifact(artifact, base, stats, {
            artifactKind: meta.artifactKind,
            entries: copiedEntries,
          }),
        )
        break
      }
      case 'global-claude-json-user': {
        const json = await readClaudeJson(meta.file)
        const user = extractUserScope(json)
        const payload = { mcpServers: user.mcpServers, config: user.config }
        const text = formatJson(payload)
        await ctx.fs.writeFileAtomic(staging(PAYLOAD.userClaudeJson), text)
        out.push(
          manifestArtifact(
            artifact,
            PAYLOAD.userClaudeJson,
            { files: 1, bytes: Buffer.byteLength(text, 'utf8') },
            { artifactKind: 'global-claude-json-user', servers: Object.keys(user.mcpServers) },
          ),
        )
        break
      }
      case 'global-claude-json-user-mcp-env': {
        const json = await readClaudeJson(meta.file)
        const user = extractUserScope(json)
        const text = formatJson({ mcpServers: user.mcpEnv })
        await ctx.fs.writeFileAtomic(staging(PAYLOAD.userMcpEnv), text)
        out.push(
          manifestArtifact(
            artifact,
            PAYLOAD.userMcpEnv,
            { files: 1, bytes: Buffer.byteLength(text, 'utf8') },
            { artifactKind: 'global-claude-json-user-mcp-env', servers: Object.keys(user.mcpEnv) },
          ),
        )
        break
      }
    }
    done += 1
    ctx.progress(`✓ ${artifact.label}`, total > 0 ? done / total : undefined, {
      id: artifact.id,
      label: artifact.label,
      status: 'done',
    })
  }

  // ---- claude-json.json (project entries + optional MCP env) ----
  if (projectClaudeJson || mcpEnvSelected) {
    const claudeJsonArtifacts = input.artifacts.filter((a) => {
      const kind = (a.meta as { artifactKind?: string }).artifactKind
      return kind === 'claude-json-project' || kind === 'claude-json-mcp-env'
    })
    const file = (claudeJsonArtifacts[0]?.meta as { file?: string } | undefined)?.file
    if (!file)
      throw new MigrationError('INVALID_INPUT', 'claude.json artifact without a source file')
    const json = await readClaudeJson(file)
    const paths = [
      ...new Set([...(projectClaudeJson?.paths ?? []), ...(mcpEnvSelected?.paths ?? [])]),
    ]
    const extracted = extractProjectEntries(json, paths)
    const payload: { projects: Record<string, unknown>; mcpEnv?: McpEnvMap } = {
      projects: projectClaudeJson ? extracted.projects : {},
    }
    if (mcpEnvSelected) {
      mcpEnvPending = {}
      for (const p of mcpEnvSelected.paths) {
        const key = Object.keys(extracted.mcpEnv).find((k) => k === p)
        if (key) mcpEnvPending[key] = extracted.mcpEnv[key] as McpEnvMap[string]
      }
      payload.mcpEnv = mcpEnvPending
    }
    const includedServers = new Set(
      Object.values(mcpEnvPending ?? {}).flatMap((servers) => Object.keys(servers)),
    )
    mcpEnvServersExcluded = [
      ...new Set(Object.values(extracted.mcpEnv).flatMap((servers) => Object.keys(servers))),
    ].filter((name) => !includedServers.has(name))
    const text = formatJson(payload)
    await ctx.fs.writeFileAtomic(staging(PAYLOAD.claudeJson), text)
    for (const artifact of claudeJsonArtifacts) {
      const kind = (
        artifact.meta as { artifactKind: 'claude-json-project' | 'claude-json-mcp-env' }
      ).artifactKind
      const servers =
        kind === 'claude-json-mcp-env'
          ? [...new Set(Object.values(mcpEnvPending ?? {}).flatMap((s) => Object.keys(s)))]
          : undefined
      out.push(
        manifestArtifact(
          artifact,
          PAYLOAD.claudeJson,
          { files: 1, bytes: Buffer.byteLength(text, 'utf8') },
          {
            artifactKind: kind,
            paths:
              kind === 'claude-json-mcp-env'
                ? Object.keys(mcpEnvPending ?? {})
                : Object.keys(payload.projects),
            ...(servers ? { servers } : {}),
          },
        ),
      )
    }
  }

  // ---- encoding verification on the source + index.json ----
  let encoding: EncodingVerification
  try {
    const samples = await collectEncodingSamples(ctx.claudeConfigDir, { signal: ctx.signal })
    encoding = verifyEncoding(ctx.claudeConfigDir, samples)
  } catch (err) {
    if ((err as { code?: string }).code === 'CANCELLED') throw err
    warnings.push(
      `Could not verify the Claude project directory encoding: ${(err as Error).message}`,
    )
    encoding = verifyEncoding(ctx.claudeConfigDir, [])
  }
  if (!encoding.verified && section === 'project') {
    warnings.push(
      encoding.mismatched > 0
        ? `The Claude project directory encoding did not verify on this Mac (${encoding.mismatched} mismatch${encoding.mismatched === 1 ? '' : 'es'}); restored sessions may need manual relocation.`
        : 'The Claude project directory encoding could not be verified on this Mac (no cwd evidence).',
    )
  }
  const index: BackupIndex = {
    schemaVersion: 1,
    section,
    claudeCodeVersions: [...versions].sort(),
    encoding: {
      rule: encoding.rule,
      verified: encoding.verified,
      matched: encoding.matched,
      mismatched: encoding.mismatched,
      unknown: encoding.unknown,
    },
    matches,
    sessionCount,
    memoryDirs,
    fileHistorySessionIds,
    mcpEnvServersExcluded,
    ...(input.project ? { project: { id: input.project.id, path: input.project.realPath } } : {}),
  }
  await ctx.fs.writeFileAtomic(staging(PAYLOAD.index), formatJson(index))

  return {
    artifacts: out,
    schemaVersion: CLAUDE_CODE_SCHEMA_VERSION,
    summary: {
      sessionCount,
      worktreeSessionSets,
      memoryDirs: memoryDirs.length,
      indexPayloadPath,
      claudeCodeVersions: index.claudeCodeVersions,
    },
    restoreHints: {
      claudeEncodingVerified: encoding.verified,
      claudeEncodingRule: encoding.rule,
      claudeEncodingSamples: encoding.examples,
      claudeEncodingStats: {
        matched: encoding.matched,
        mismatched: encoding.mismatched,
        unknown: encoding.unknown,
      },
    },
    warnings,
  }
}
