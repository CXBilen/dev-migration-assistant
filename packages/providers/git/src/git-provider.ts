/**
 * The Git MigrationProvider (ADR-0006): repository objects travel as a bundle, per-worktree working
 * state as binary-safe diffs + untracked files, worktrees are reconstructed from logical state.
 */
import type {
  BackupContext,
  DetectionContext,
  MigrationProvider,
  PathRemapResult,
  ProviderBackupInput,
  ProviderBackupOutput,
  ProviderDetection,
  ProviderRestoreInput,
  ProviderRestorePlan,
  ProviderRestoreResult,
  ProviderVerification,
  ProviderVerifyInput,
  RemapContext,
  RestoreContext,
  RestorePlanningContext,
  ScanContext,
  VerifyContext,
} from '@devmig/core'
import type { PathMapping, ProjectDescriptor, ProviderScanResult } from '@devmig/model'
import { createGitBackupArtifacts } from './backup'
import { parseSelection } from './common'
import { GIT_MIN_SUPPORTED, checkGitAvailable } from './git'
import { planGitRestore } from './plan'
import { restoreGit } from './restore'
import { scanGitProject } from './scan'
import { GIT_PROVIDER_ID, GIT_SCHEMA_VERSION } from './schema'
import { verifyGitRestore } from './verify'

export class GitProvider implements MigrationProvider {
  readonly id = GIT_PROVIDER_ID
  readonly displayName = 'Git'
  readonly version = '0.1.0'
  readonly schemaVersion = GIT_SCHEMA_VERSION
  readonly supportsGlobal = false

  async detect(ctx: DetectionContext): Promise<ProviderDetection> {
    const availability = await checkGitAvailable(ctx.exec, ctx.env, ctx.signal)
    const details: Record<string, string> = {
      minimumVersion: `${GIT_MIN_SUPPORTED.major}.${GIT_MIN_SUPPORTED.minor}`,
    }
    if (availability.version) details.version = availability.version.raw
    const notes: string[] = []
    if (!availability.available) {
      notes.push(
        'git was not found on PATH; install the Xcode Command Line Tools or git via Homebrew.',
      )
    }
    return {
      providerId: this.id,
      available: availability.available,
      ...(availability.version ? { version: availability.version.raw } : {}),
      details,
      notes,
    }
  }

  scanProject(project: ProjectDescriptor, ctx: ScanContext): Promise<ProviderScanResult> {
    return scanGitProject(project, ctx)
  }

  createBackupArtifacts(
    input: ProviderBackupInput,
    ctx: BackupContext,
  ): Promise<ProviderBackupOutput> {
    return createGitBackupArtifacts(input, ctx)
  }

  planRestore(
    input: ProviderRestoreInput,
    ctx: RestorePlanningContext,
  ): Promise<ProviderRestorePlan> {
    return planGitRestore(input, ctx)
  }

  restore(
    plan: ProviderRestorePlan,
    input: ProviderRestoreInput,
    ctx: RestoreContext,
  ): Promise<ProviderRestoreResult> {
    return restoreGit(plan, input, ctx)
  }

  verify(input: ProviderVerifyInput, ctx: VerifyContext): Promise<ProviderVerification> {
    return verifyGitRestore(input, ctx)
  }

  /** Dry run for the mapping screen: worktrees are recomputed from logical state, never string-replaced. */
  remapPaths(
    mappings: PathMapping[],
    input: ProviderRestoreInput,
    _ctx: RemapContext,
  ): Promise<PathRemapResult> {
    const selection = parseSelection(input.artifacts)
    const linked = [...selection.worktreeStates.keys()].filter((index) => index !== 0).length
    return Promise.resolve({
      report: {
        mappings,
        affected: [
          {
            providerId: this.id,
            label: 'Git worktrees (recreated from logical state)',
            count: linked,
          },
        ],
        safeRewriteCount: linked,
        warnings: [],
        unsupportedReferences: [],
      },
    })
  }
}

export function createGitProvider(): MigrationProvider {
  return new GitProvider()
}
