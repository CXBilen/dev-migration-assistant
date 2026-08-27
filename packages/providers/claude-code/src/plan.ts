/**
 * planRestore: computes destinations, collisions (non-destructive defaults), preflight checks and
 * the remap report for the selected artifacts. Read-only — nothing is written here (ADR-0008).
 */
import path from 'node:path'
import type {
  ProviderRestoreInput,
  ProviderRestorePlan,
  RestorePlanningContext,
} from '@devmig/core'
import type { Collision, ManifestArtifact, PreflightCheck, RestoreStep } from '@devmig/model'
import {
  MigrationError,
  canonicalizePath,
  displayPath,
  isSafeArchivePath,
  throwIfAborted,
} from '@devmig/shared'
import { findProjectEntryKey, readClaudeJson } from './claude-json'
import {
  CLAUDE_CODE_PROVIDER_ID,
  CLAUDE_PROJECT_DIR_MAX_LENGTH,
  MAX_REMAP_ESTIMATE_RECORDS,
} from './constants'
import { encodeProjectDirName, verifyEncoding } from './encoding'
import { isExistingDirectory, isExistingFile, listDirectory, readOptionalJson } from './fs-helpers'
import { findRunningClaudeSessions, type IsProcessAlive } from './process'
import { collectEncodingSamples, sessionIdFromFileName } from './resolver'
import {
  BackupIndexSchema,
  ManifestMetaSchema,
  UserClaudeJsonPayloadSchema,
  type BackupIndex,
  type ManifestMeta,
  type RestoreState,
} from './schema'
import { countPathFields, type UnsupportedReferenceRecord } from './transcript'

export interface PlanDeps {
  isProcessAlive: IsProcessAlive
}

const JSON_MERGEABLE_GLOBAL_FILES = new Set([
  'settings.json',
  'settings.local.json',
  'keybindings.json',
])

function metaOf(artifact: ManifestArtifact): ManifestMeta {
  const parsed = ManifestMetaSchema.safeParse(artifact.meta)
  if (!parsed.success) {
    throw new MigrationError(
      'MANIFEST_INVALID',
      `Artifact ${artifact.id} has unsupported metadata`,
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

export function payloadFile(payloadRoot: string, payloadPath: string): string {
  const clean = payloadPath.replace(/^\.\/+/, '')
  if (!isSafeArchivePath(clean)) {
    throw new MigrationError('ARCHIVE_ENTRY_REJECTED', `Unsafe payload path: ${payloadPath}`, {
      details: { payloadPath },
    })
  }
  return path.join(payloadRoot, ...clean.split('/'))
}

async function readIndex(
  payloadRoot: string,
  indexPayloadPath: string | undefined,
): Promise<BackupIndex | undefined> {
  if (!indexPayloadPath) return undefined
  const raw = await readOptionalJson(payloadFile(payloadRoot, indexPayloadPath))
  if (raw === undefined) return undefined
  const parsed = BackupIndexSchema.safeParse(raw)
  if (!parsed.success) {
    throw new MigrationError('MANIFEST_INVALID', 'The Claude Code payload index is invalid', {
      details: {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    })
  }
  return parsed.data
}

async function dirHasTranscripts(dir: string): Promise<boolean> {
  for (const entry of await listDirectory(dir)) {
    if (entry.isFile() && sessionIdFromFileName(entry.name)) return true
  }
  return false
}

export async function planRestore(
  input: ProviderRestoreInput,
  ctx: RestorePlanningContext,
  deps: PlanDeps,
): Promise<ProviderRestorePlan> {
  const steps: RestoreStep[] = []
  const collisions: Collision[] = []
  const preflight: PreflightCheck[] = []
  const warnings: string[] = []
  const remapWarnings: string[] = []
  const affected = new Map<string, number>()
  const unsupportedReferences: UnsupportedReferenceRecord[] = []
  let safeRewriteCount = 0
  const section = input.project ? 'project' : 'global'
  const bump = (label: string, n: number): void => {
    affected.set(label, (affected.get(label) ?? 0) + n)
  }

  const indexPayloadPath =
    (typeof input.section.summary.indexPayloadPath === 'string'
      ? input.section.summary.indexPayloadPath
      : undefined) ??
    input.artifacts
      .map((a) => (a.meta as { indexPayloadPath?: string }).indexPayloadPath)
      .find((p) => typeof p === 'string')
  const index = await readIndex(ctx.payloadRoot, indexPayloadPath)
  if (!index && section === 'project') {
    warnings.push(
      'The backup has no Claude Code index; destinations are derived from artifact metadata only.',
    )
  }

  const state: RestoreState = {
    version: 1,
    section,
    claudeConfigDir: ctx.claudeConfigDir,
    claudeJsonPath: ctx.claudeJsonPath,
    oldPaths: [...new Set(ctx.mappings.map((m) => canonicalizePath(m.oldPath)))],
    sessions: [],
    memory: [],
    projectFiles: [],
    global: [],
    mcpEnvServersNotRestored: [],
  }
  if (input.project) {
    const mapped = ctx.mapPath(input.project.oldPath)
    state.project = {
      id: input.project.id,
      oldPath: input.project.oldPath,
      newPath: input.project.newPath,
      pathChanged:
        mapped.changed ||
        canonicalizePath(input.project.oldPath) !== canonicalizePath(input.project.newPath),
    }
    if (!state.oldPaths.includes(canonicalizePath(input.project.oldPath))) {
      state.oldPaths.push(canonicalizePath(input.project.oldPath))
    }
  }
  const pathChanged = state.project?.pathChanged ?? false

  // ---- preflight ----
  const configDirExists = await isExistingDirectory(ctx.claudeConfigDir)
  preflight.push({
    id: 'claude-data-dir',
    label: 'Claude Code data directory',
    status: configDirExists ? 'pass' : 'warn',
    detail: configDirExists
      ? displayPath(ctx.claudeConfigDir, ctx.homeDir)
      : `Claude Code has not been run on this Mac yet — ${displayPath(ctx.claudeConfigDir, ctx.homeDir)} will be created`,
    blocking: false,
  })
  const running = configDirExists
    ? await findRunningClaudeSessions(ctx.claudeConfigDir, deps.isProcessAlive)
    : []
  preflight.push({
    id: 'claude-running',
    label: 'Claude Code not running',
    status: running.length === 0 ? 'pass' : 'warn',
    detail:
      running.length === 0
        ? undefined
        : `${running.length} Claude Code process${running.length === 1 ? ' is' : 'es are'} running (pid ${running.map((r) => r.pid).join(', ')}). Quit Claude Code before restoring: it rewrites ~/.claude.json and transcripts while running, and the restore could be overwritten or corrupt live sessions.`,
    blocking: false,
  })
  if (configDirExists) {
    try {
      const samples = await collectEncodingSamples(ctx.claudeConfigDir, {
        signal: ctx.signal,
        maxDirs: 50,
      })
      if (samples.length > 0) {
        const verification = verifyEncoding(ctx.claudeConfigDir, samples)
        preflight.push({
          id: 'claude-encoding',
          label: 'Claude project directory encoding',
          status: verification.mismatched > 0 ? 'warn' : verification.matched > 0 ? 'pass' : 'warn',
          detail:
            verification.mismatched > 0
              ? `${verification.mismatched} existing project director${verification.mismatched === 1 ? 'y does' : 'ies do'} not follow the expected encoding on this Mac; restored sessions may not be found by Claude Code`
              : verification.matched > 0
                ? `verified against ${verification.matched} existing project director${verification.matched === 1 ? 'y' : 'ies'}`
                : 'no existing transcripts with cwd evidence to verify against',
          blocking: false,
        })
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'CANCELLED') throw err
      warnings.push(
        `Could not verify the project directory encoding on this Mac: ${(err as Error).message}`,
      )
    }
  }
  const sourceEncoding = index?.encoding
  if (sourceEncoding && !sourceEncoding.verified && section === 'project') {
    warnings.push(
      'The project directory encoding was not verified on the source Mac; destination directory names are derived from the documented rule.',
    )
  }

  const existingClaudeJson = await readClaudeJson(ctx.claudeJsonPath).catch((err: unknown) => {
    warnings.push(
      `Existing ${displayPath(ctx.claudeJsonPath, ctx.homeDir)} could not be parsed: ${(err as Error).message}`,
    )
    return undefined
  })

  const stepFor = (
    id: string,
    label: string,
    destination: string,
    artifactIds: string[],
    detail?: string,
  ): void => {
    steps.push({
      id,
      providerId: CLAUDE_CODE_PROVIDER_ID,
      ...(input.project ? { projectId: input.project.id } : {}),
      label,
      ...(detail ? { detail } : {}),
      destination,
      artifactIds,
    })
  }

  const allSectionArtifacts = input.section.artifacts
  const selectedIds = new Set(input.artifacts.map((a) => a.id))

  for (const artifact of input.artifacts) {
    throwIfAborted(ctx.signal)
    const meta = metaOf(artifact)
    switch (meta.artifactKind) {
      case 'sessions': {
        if (!meta.dirName || !meta.sourcePath || !meta.kind || !meta.confidence) {
          throw new MigrationError(
            'MANIFEST_INVALID',
            `Sessions artifact ${artifact.id} lacks its directory metadata`,
          )
        }
        const sessionIds =
          meta.sessionIds ??
          index?.matches.find((m) => m.dirName === meta.dirName)?.sessionIds ??
          []
        const mapped = ctx.mapPath(meta.sourcePath)
        const newCwd = mapped.newPath
        const encoded = encodeProjectDirName(newCwd)
        let destDirName = encoded.name
        let unverifiable = false
        if (encoded.truncated) {
          unverifiable = true
          if (!mapped.changed) {
            destDirName = meta.dirName
            remapWarnings.push(
              `${displayPath(newCwd, ctx.homeDir)} encodes to more than ${CLAUDE_PROJECT_DIR_MAX_LENGTH} characters; the original directory name is reused verbatim because the path is unchanged.`,
            )
          } else {
            remapWarnings.push(
              `${displayPath(newCwd, ctx.homeDir)} encodes to more than ${CLAUDE_PROJECT_DIR_MAX_LENGTH} characters; Claude Code appends an undocumented hash, so the restored sessions may need to be relocated manually.`,
            )
          }
        }
        const destDir = path.join(ctx.claudeConfigDir, 'projects', destDirName)
        const rewrite = pathChanged || mapped.changed
        let collisionId: string | undefined
        if (await dirHasTranscripts(destDir)) {
          collisionId = `sessions:${meta.dirName}`
          collisions.push({
            id: collisionId,
            providerId: CLAUDE_CODE_PROVIDER_ID,
            ...(input.project ? { projectId: input.project.id } : {}),
            kind: 'claude-project-exists',
            path: destDir,
            detail: `Claude Code already has sessions for ${displayPath(newCwd, ctx.homeDir)}. Merge adds sessions by id; identical transcripts are skipped and differing ones are kept as <id>.devmig-conflict.jsonl.`,
            allowedPolicies: ['merge', 'skip'],
            policy: 'merge',
          })
        }
        state.sessions.push({
          artifactId: artifact.id,
          payloadPath: artifact.payloadPath,
          dirName: meta.dirName,
          sourcePath: meta.sourcePath,
          newCwd,
          destDirName,
          destDir,
          sessionIds,
          kind: meta.kind,
          confidence: meta.confidence,
          rewrite,
          unverifiable,
          ...(collisionId ? { collisionId } : {}),
        })
        if (rewrite) {
          bump('Claude sessions', sessionIds.length)
          const srcDir = payloadFile(ctx.payloadRoot, artifact.payloadPath)
          let budget = MAX_REMAP_ESTIMATE_RECORDS
          for (const sid of sessionIds) {
            throwIfAborted(ctx.signal)
            if (budget <= 0) {
              remapWarnings.push(
                'Remap estimate truncated: more than 50,000 transcript records; counts are lower bounds.',
              )
              break
            }
            const file = path.join(srcDir, `${sid}.jsonl`)
            if (!(await isExistingFile(file))) continue
            const counted = await countPathFields(file, ctx.mapPath, {
              oldPaths: state.oldPaths,
              signal: ctx.signal,
              unsupportedReferences,
              label: `${sid}.jsonl`,
              maxRecords: budget,
            })
            budget -= counted.records
            safeRewriteCount += counted.pathFields
          }
        }
        stepFor(
          `sessions:${meta.dirName}`,
          `Restore ${sessionIds.length} Claude Code session${sessionIds.length === 1 ? '' : 's'}${meta.kind === 'project' ? '' : ` (${meta.kind})`}`,
          destDir,
          [artifact.id],
          rewrite
            ? 'transcripts are re-encoded for the new path (metadata fields only)'
            : 'copied verbatim',
        )
        break
      }
      case 'memory': {
        if (!meta.dirName || !meta.sourcePath) {
          throw new MigrationError(
            'MANIFEST_INVALID',
            `Memory artifact ${artifact.id} lacks its directory metadata`,
          )
        }
        const mapped = ctx.mapPath(meta.sourcePath)
        const encoded = encodeProjectDirName(mapped.newPath)
        const destDirName = encoded.truncated && !mapped.changed ? meta.dirName : encoded.name
        const destDir = path.join(ctx.claudeConfigDir, 'projects', destDirName, 'memory')
        let collisionId: string | undefined
        if (await isExistingDirectory(destDir)) {
          collisionId = `memory:${meta.dirName}`
          collisions.push({
            id: collisionId,
            providerId: CLAUDE_CODE_PROVIDER_ID,
            ...(input.project ? { projectId: input.project.id } : {}),
            kind: 'directory-exists',
            path: destDir,
            detail:
              'Auto memory already exists for this project. Merge adds missing files only; existing notes are kept.',
            allowedPolicies: ['merge', 'skip'],
            policy: 'merge',
          })
        }
        state.memory.push({
          artifactId: artifact.id,
          payloadPath: artifact.payloadPath,
          dirName: meta.dirName,
          destDir,
          ...(collisionId ? { collisionId } : {}),
        })
        stepFor(`memory:${meta.dirName}`, 'Restore Claude Code project memory', destDir, [
          artifact.id,
        ])
        break
      }
      case 'file-history':
      case 'session-env': {
        const folder = meta.artifactKind === 'file-history' ? 'file-history' : 'session-env'
        const destRoot = path.join(ctx.claudeConfigDir, folder)
        const entry = {
          artifactId: artifact.id,
          payloadPath: artifact.payloadPath,
          destRoot,
          sessionIds: meta.sessionIds ?? [],
        }
        if (meta.artifactKind === 'file-history') state.fileHistory = entry
        else state.sessionEnv = entry
        stepFor(
          folder,
          meta.artifactKind === 'file-history'
            ? 'Restore checkpoint blobs (file history)'
            : 'Restore session environment scripts',
          destRoot,
          [artifact.id],
          'add-only; existing files are kept',
        )
        break
      }
      case 'history': {
        const destFile = path.join(ctx.claudeConfigDir, 'history.jsonl')
        state.history = { artifactId: artifact.id, payloadPath: artifact.payloadPath, destFile }
        bump('history entries', meta.fileCount ?? artifact.fileCount ?? 0)
        stepFor(
          'history',
          'Append prompt history entries',
          destFile,
          [artifact.id],
          'entries already present (same session id and timestamp) are skipped',
        )
        break
      }
      case 'claude-json-project': {
        const entries: { oldPath: string; newPath: string; collisionId?: string }[] = []
        for (const oldPath of meta.paths ?? []) {
          const newPath = ctx.mapPath(oldPath).newPath
          let collisionId: string | undefined
          if (
            existingClaudeJson?.projects &&
            findProjectEntryKey(existingClaudeJson.projects, newPath)
          ) {
            collisionId = `claude-json:${newPath}`
            collisions.push({
              id: collisionId,
              providerId: CLAUDE_CODE_PROVIDER_ID,
              ...(input.project ? { projectId: input.project.id } : {}),
              kind: 'json-entry-exists',
              path: `${ctx.claudeJsonPath} → projects["${newPath}"]`,
              detail:
                'This Mac already has a ~/.claude.json entry for the destination. Merge adds missing keys only.',
              allowedPolicies: ['skip', 'merge'],
              policy: 'skip',
            })
          }
          entries.push({ oldPath, newPath, ...(collisionId ? { collisionId } : {}) })
        }
        state.claudeJson = {
          artifactId: artifact.id,
          payloadPath: artifact.payloadPath,
          destFile: ctx.claudeJsonPath,
          entries,
          includeMcpEnv: false,
        }
        bump('Claude project entries', entries.length)
        stepFor(
          'claude-json',
          `Merge ${entries.length} project entr${entries.length === 1 ? 'y' : 'ies'} into ~/.claude.json`,
          ctx.claudeJsonPath,
          [artifact.id],
          'a backup copy of the original file is written first',
        )
        break
      }
      case 'claude-json-mcp-env':
        // handled after the loop (depends on the project entry artifact)
        break
      case 'project-file': {
        if (!meta.relativePath || !input.project) {
          throw new MigrationError(
            'MANIFEST_INVALID',
            `Project file artifact ${artifact.id} lacks its relative path`,
          )
        }
        if (!isSafeArchivePath(meta.relativePath)) {
          throw new MigrationError(
            'ARCHIVE_ENTRY_REJECTED',
            `Unsafe project file path: ${meta.relativePath}`,
          )
        }
        const dest = path.join(input.project.newPath, ...meta.relativePath.split('/'))
        let collisionId: string | undefined
        if (await isExistingFile(dest)) {
          collisionId = `file:${meta.relativePath}`
          collisions.push({
            id: collisionId,
            providerId: CLAUDE_CODE_PROVIDER_ID,
            projectId: input.project.id,
            kind: 'file-exists',
            path: dest,
            detail: `${meta.relativePath} already exists in the destination project.`,
            allowedPolicies: ['skip', 'backup-then-replace'],
            policy: 'skip',
          })
        }
        state.projectFiles.push({
          artifactId: artifact.id,
          payloadPath: artifact.payloadPath,
          relativePath: meta.relativePath,
          dest,
          ...(collisionId ? { collisionId } : {}),
        })
        stepFor(`file:${meta.relativePath}`, `Restore ${meta.relativePath}`, dest, [artifact.id])
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
        const entries: RestoreState['global'][number]['entries'] = []
        const srcBase = payloadFile(ctx.payloadRoot, artifact.payloadPath)
        for (const rel of meta.entries ?? []) {
          if (!isSafeArchivePath(rel)) {
            throw new MigrationError('ARCHIVE_ENTRY_REJECTED', `Unsafe payload entry: ${rel}`)
          }
          const src = path.join(srcBase, ...rel.split('/'))
          const dest = path.join(ctx.claudeConfigDir, ...rel.split('/'))
          const isDirectory = await isExistingDirectory(src)
          let collisionId: string | undefined
          if (isDirectory && (await isExistingDirectory(dest))) {
            collisionId = `global:${rel}`
            collisions.push({
              id: collisionId,
              providerId: CLAUDE_CODE_PROVIDER_ID,
              kind: 'directory-exists',
              path: dest,
              detail: `${rel}/ already exists. Merge adds missing files only; backup-then-replace moves the existing directory aside.`,
              allowedPolicies: ['merge', 'skip', 'backup-then-replace'],
              policy: 'merge',
            })
          } else if (!isDirectory && (await isExistingFile(dest))) {
            collisionId = `global:${rel}`
            const mergeable = JSON_MERGEABLE_GLOBAL_FILES.has(path.basename(rel))
            collisions.push({
              id: collisionId,
              providerId: CLAUDE_CODE_PROVIDER_ID,
              kind: 'file-exists',
              path: dest,
              detail: mergeable
                ? `${rel} already exists. Merge adds missing keys only (existing values win); backup-then-replace keeps a copy of the current file.`
                : `${rel} already exists. Backup-then-replace keeps a copy of the current file.`,
              allowedPolicies: mergeable
                ? ['skip', 'merge', 'backup-then-replace']
                : ['skip', 'backup-then-replace'],
              policy: 'skip',
            })
          }
          entries.push({
            relative: rel,
            dest,
            isDirectory,
            ...(collisionId ? { collisionId } : {}),
          })
        }
        state.global.push({
          artifactId: artifact.id,
          artifactKind: meta.artifactKind,
          payloadPath: artifact.payloadPath,
          entries,
        })
        stepFor(
          meta.artifactKind,
          `Restore ${artifact.label}`,
          ctx.claudeConfigDir,
          [artifact.id],
          (meta.entries ?? []).join(', '),
        )
        break
      }
      case 'global-claude-json-user': {
        const payload = UserClaudeJsonPayloadSchema.safeParse(
          await readOptionalJson(payloadFile(ctx.payloadRoot, artifact.payloadPath)),
        )
        const servers = payload.success ? Object.keys(payload.data.mcpServers) : []
        const serverCollisions: { name: string; collisionId: string }[] = []
        let fileCollisionId: string | undefined
        if (existingClaudeJson) {
          fileCollisionId = 'claude-json-file'
          collisions.push({
            id: fileCollisionId,
            providerId: CLAUDE_CODE_PROVIDER_ID,
            kind: 'json-entry-exists',
            path: ctx.claudeJsonPath,
            detail:
              '~/.claude.json already exists. Merge adds missing MCP servers and config keys only; a backup copy is written first.',
            allowedPolicies: ['merge', 'skip'],
            policy: 'merge',
          })
          for (const name of servers) {
            if (
              existingClaudeJson.mcpServers &&
              Object.hasOwn(existingClaudeJson.mcpServers, name)
            ) {
              const collisionId = `mcp-server:${name}`
              serverCollisions.push({ name, collisionId })
              collisions.push({
                id: collisionId,
                providerId: CLAUDE_CODE_PROVIDER_ID,
                kind: 'json-entry-exists',
                path: `${ctx.claudeJsonPath} → mcpServers["${name}"]`,
                detail: `User-scope MCP server "${name}" already exists. Merge adds missing keys only.`,
                allowedPolicies: ['skip', 'merge'],
                policy: 'skip',
              })
            }
          }
        }
        state.globalClaudeJson = {
          artifactId: artifact.id,
          payloadPath: artifact.payloadPath,
          destFile: ctx.claudeJsonPath,
          includeMcpEnv: false,
          serverCollisions,
          ...(fileCollisionId ? { fileCollisionId } : {}),
        }
        stepFor(
          'claude-json-user',
          'Merge user-scope MCP servers and global config into ~/.claude.json',
          ctx.claudeJsonPath,
          [artifact.id],
        )
        break
      }
      case 'global-claude-json-user-mcp-env':
        break
      case 'credential':
      case 'ephemeral':
        throw new MigrationError('INVALID_INPUT', `Artifact ${artifact.id} can never be restored`, {
          details: { artifactId: artifact.id },
        })
    }
  }

  // ---- MCP env artifacts (depend on the entries artifact) ----
  const mcpEnvArtifact = allSectionArtifacts.find(
    (a) => (a.meta as { artifactKind?: string }).artifactKind === 'claude-json-mcp-env',
  )
  if (mcpEnvArtifact) {
    if (selectedIds.has(mcpEnvArtifact.id)) {
      if (state.claudeJson) {
        state.claudeJson.includeMcpEnv = true
        state.claudeJson.mcpEnvArtifactId = mcpEnvArtifact.id
        stepFor(
          'claude-json-mcp-env',
          'Restore MCP server environment values',
          ctx.claudeJsonPath,
          [mcpEnvArtifact.id],
        )
      } else {
        warnings.push(
          'MCP server environment values were selected without the project entries; they can only be restored together.',
        )
        state.mcpEnvServersNotRestored = metaOf(mcpEnvArtifact).servers ?? []
      }
    } else {
      state.mcpEnvServersNotRestored = metaOf(mcpEnvArtifact).servers ?? []
    }
  } else if (index && index.mcpEnvServersExcluded.length > 0 && state.claudeJson) {
    state.mcpEnvServersNotRestored = [...index.mcpEnvServersExcluded]
  }
  const userMcpEnvArtifact = allSectionArtifacts.find(
    (a) => (a.meta as { artifactKind?: string }).artifactKind === 'global-claude-json-user-mcp-env',
  )
  if (userMcpEnvArtifact) {
    if (selectedIds.has(userMcpEnvArtifact.id) && state.globalClaudeJson) {
      state.globalClaudeJson.includeMcpEnv = true
      state.globalClaudeJson.mcpEnvArtifactId = userMcpEnvArtifact.id
      state.globalClaudeJson.mcpEnvPayloadPath = userMcpEnvArtifact.payloadPath
      stepFor(
        'claude-json-user-mcp-env',
        'Restore user-scope MCP server environment values',
        ctx.claudeJsonPath,
        [userMcpEnvArtifact.id],
      )
    } else {
      state.mcpEnvServersNotRestored = [
        ...state.mcpEnvServersNotRestored,
        ...(metaOf(userMcpEnvArtifact).servers ?? []),
      ]
    }
  }

  if (index && index.sessionCount > 0 && index.claudeCodeVersions.length > 0) {
    warnings.push(
      `Sessions were written by Claude Code ${index.claudeCodeVersions.join(', ')}; the transcript format is internal and may differ on this Mac.`,
    )
  }
  const unsupportedList = unsupportedReferences.map((u) => ({
    location: u.location,
    reason: u.reason,
  }))

  return {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    ...(input.project ? { projectId: input.project.id } : {}),
    steps,
    collisions,
    preflight,
    remap: {
      affected: [...affected].map(([label, count]) => ({ label, count })),
      safeRewriteCount,
      warnings: remapWarnings,
      unsupportedReferences: unsupportedList,
    },
    warnings,
    state: state as unknown as Record<string, unknown>,
  }
}
