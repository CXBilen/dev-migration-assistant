/** zod schemas for everything the runtime provider reads from disk or from a backup. */
import { MachineInfo } from '@devmig/model'
import { z } from 'zod'
import { Remediation } from './remediation'

export const PACKAGE_MANAGER_IDS = ['pnpm', 'yarn', 'npm', 'bun'] as const
export const PackageManagerId = z.enum(PACKAGE_MANAGER_IDS)
export type PackageManagerId = z.infer<typeof PackageManagerId>

const ShortString = z.string().max(128)

/** Loose package.json: only the fields we care about, everything else ignored. */
export const PackageJsonLoose = z.looseObject({
  name: ShortString.optional(),
  version: ShortString.optional(),
  packageManager: ShortString.optional(),
  engines: z.record(z.string(), z.string().max(128)).optional(),
  workspaces: z.union([z.array(z.string()), z.looseObject({})]).optional(),
  dependencies: z.record(z.string(), z.string().max(256)).optional(),
  devDependencies: z.record(z.string(), z.string().max(256)).optional(),
})
export type PackageJsonLoose = z.infer<typeof PackageJsonLoose>

export const PackageManagerInfo = z.object({
  id: PackageManagerId,
  /** Exact version when package.json declares `packageManager`, else null. */
  version: z.string().max(64).nullable(),
  source: z.enum(['packageManager', 'lockfile']),
  lockfile: z.string().max(64).nullable(),
})
export type PackageManagerInfo = z.infer<typeof PackageManagerInfo>

export const NodeVersionPin = z.object({
  source: z.enum(['.nvmrc', '.node-version']),
  raw: z.string().max(64),
  major: z.number().int().nullable(),
})
export type NodeVersionPin = z.infer<typeof NodeVersionPin>

export const FrameworkInfo = z.object({
  /** Dependency name, e.g. `next`. */
  id: z.string().max(128),
  label: z.string().max(64),
  spec: z.string().max(256),
  major: z.number().int().nullable(),
})
export type FrameworkInfo = z.infer<typeof FrameworkInfo>

export const ProjectRuntimeInfo = z.object({
  hasPackageJson: z.boolean(),
  packageName: z.string().max(128).nullable(),
  packageManager: PackageManagerInfo.nullable(),
  lockfiles: z.array(z.string().max(64)),
  /** `pnpm` when pnpm-workspace.yaml exists, `package.json` when `workspaces` is declared, else null. */
  workspace: z.enum(['pnpm-workspace.yaml', 'package.json']).nullable(),
  engines: z.record(z.string(), z.string().max(128)),
  nodePin: NodeVersionPin.nullable(),
  frameworks: z.array(FrameworkInfo),
})
export type ProjectRuntimeInfo = z.infer<typeof ProjectRuntimeInfo>

export const RuntimeMachinePayload = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string(),
  machine: MachineInfo,
})
export type RuntimeMachinePayload = z.infer<typeof RuntimeMachinePayload>

export const ProjectRuntimePayload = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string(),
  projectPath: z.string(),
  runtime: ProjectRuntimeInfo,
})
export type ProjectRuntimePayload = z.infer<typeof ProjectRuntimePayload>

/** ScannedArtifact.meta / ManifestArtifact.meta shapes. */
export const MachineArtifactMeta = z.object({ machine: MachineInfo })
export const ProjectArtifactMeta = z.object({
  runtime: ProjectRuntimeInfo,
  projectPath: z.string(),
})

export const PlanState = z.object({
  kind: z.enum(['machine', 'project']),
  payloadPath: z.string().min(1),
})
export type PlanState = z.infer<typeof PlanState>

export const RestoreState = z.object({
  remediations: z.array(Remediation).default([]),
})
export type RestoreState = z.infer<typeof RestoreState>
