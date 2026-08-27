/** The Claude Code MigrationProvider (ADR-0002). Building blocks live in the sibling modules. */
import type {
  BackupContext,
  DetectionContext,
  MigrationProvider,
  ProviderBackupInput,
  ProviderBackupOutput,
  ProviderDetection,
  ProviderRestoreInput,
  ProviderRestorePlan,
  ProviderRestoreResult,
  ProviderVerification,
  ProviderVerifyInput,
  RestoreContext,
  RestorePlanningContext,
  ScanContext,
  VerifyContext,
} from '@devmig/core'
import type { ProjectDescriptor, ProviderScanResult } from '@devmig/model'
import { createBackupArtifacts } from './backup'
import {
  CLAUDE_CODE_DISPLAY_NAME,
  CLAUDE_CODE_PROVIDER_ID,
  CLAUDE_CODE_PROVIDER_VERSION,
  CLAUDE_CODE_SCHEMA_VERSION,
} from './constants'
import { isExistingDirectory, isExistingFile } from './fs-helpers'
import { planRestore } from './plan'
import { defaultIsProcessAlive, type IsProcessAlive } from './process'
import { ClaudeProjectResolver } from './resolver'
import { restore } from './restore'
import { scanGlobal, scanProject } from './scan'
import { verify } from './verify'

export interface ClaudeCodeProviderOptions {
  /** Liveness probe for pids found in sessions/*.json (tests inject a deterministic one). */
  isProcessAlive?: IsProcessAlive
  /** Clock used for backup file names. */
  now?: () => Date
  /** Platform used for platform-specific credential listings (defaults to process.platform). */
  platform?: NodeJS.Platform
}

const VERSION_RE = /\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/

export class ClaudeCodeProvider implements MigrationProvider {
  readonly id = CLAUDE_CODE_PROVIDER_ID
  readonly displayName = CLAUDE_CODE_DISPLAY_NAME
  readonly version = CLAUDE_CODE_PROVIDER_VERSION
  readonly schemaVersion = CLAUDE_CODE_SCHEMA_VERSION
  readonly supportsGlobal = true

  private readonly resolver = new ClaudeProjectResolver()
  private readonly isProcessAlive: IsProcessAlive
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
    this.now = options.now ?? (() => new Date())
    this.platform = options.platform ?? process.platform
  }

  async detect(ctx: DetectionContext): Promise<ProviderDetection> {
    const configDirExists = await isExistingDirectory(ctx.claudeConfigDir)
    const claudeJsonExists = await isExistingFile(ctx.claudeJsonPath)
    let version: string | undefined
    let cliAvailable = false
    const notes: string[] = []
    try {
      const result = await ctx.exec('claude', ['--version'], {
        reject: false,
        timeoutMs: 10_000,
        env: ctx.env,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      if (!result.failed) {
        cliAvailable = true
        version = VERSION_RE.exec(result.stdout)?.[0] ?? result.stdout.trim()
      } else {
        notes.push('`claude --version` failed')
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'CANCELLED') throw err
      notes.push('claude CLI not found on PATH')
    }
    if (!configDirExists) notes.push(`${ctx.claudeConfigDir} does not exist`)
    return {
      providerId: this.id,
      available: cliAvailable || configDirExists,
      ...(version ? { version } : {}),
      details: {
        configDir: ctx.claudeConfigDir,
        configDirExists: String(configDirExists),
        claudeJsonPath: ctx.claudeJsonPath,
        claudeJsonExists: String(claudeJsonExists),
        cli: cliAvailable ? 'available' : 'missing',
      },
      notes,
    }
  }

  scanProject(project: ProjectDescriptor, ctx: ScanContext): Promise<ProviderScanResult> {
    return scanProject(project, ctx, { resolver: this.resolver, platform: this.platform })
  }

  scanGlobal(ctx: ScanContext): Promise<ProviderScanResult> {
    return scanGlobal(ctx, { resolver: this.resolver, platform: this.platform })
  }

  createBackupArtifacts(
    input: ProviderBackupInput,
    ctx: BackupContext,
  ): Promise<ProviderBackupOutput> {
    return createBackupArtifacts(input, ctx)
  }

  planRestore(
    input: ProviderRestoreInput,
    ctx: RestorePlanningContext,
  ): Promise<ProviderRestorePlan> {
    return planRestore(input, ctx, { isProcessAlive: this.isProcessAlive })
  }

  restore(
    plan: ProviderRestorePlan,
    input: ProviderRestoreInput,
    ctx: RestoreContext,
  ): Promise<ProviderRestoreResult> {
    return restore(plan, input, ctx, { now: this.now })
  }

  verify(input: ProviderVerifyInput, ctx: VerifyContext): Promise<ProviderVerification> {
    return verify(input, ctx)
  }
}

export function createClaudeCodeProvider(
  options: ClaudeCodeProviderOptions = {},
): MigrationProvider {
  return new ClaudeCodeProvider(options)
}
