/**
 * Claude Code project-directory name encoding (docs/research/claude-code-storage.md §5, ADR-0004).
 *
 * The documented rule ("non-alphanumeric characters become '-'") is treated as a HYPOTHESIS that is
 * verified per machine against real directories and transcript cwd evidence. Names longer than
 * 200 characters are truncated by Claude Code and suffixed with an undocumented hash; this module
 * never guesses that hash and reports such names as unverifiable.
 */
import { CLAUDE_PROJECT_DIR_MAX_LENGTH } from './constants'

export const ENCODING_RULE = 'non-alphanumeric-to-dash' as const

export interface EncodedProjectDirName {
  /** Encoded name. When `truncated` is true this is the first 200 characters WITHOUT the hash suffix. */
  name: string
  /** True when the encoded name exceeded the documented limit; the real name carries an unknown hash. */
  truncated: boolean
}

/** Applies the documented rule. Only ASCII letters and digits survive; everything else becomes '-'. */
export function encodeProjectDirName(absPath: string): EncodedProjectDirName {
  const encoded = absPath.replace(/[^A-Za-z0-9]/g, '-')
  if (encoded.length > CLAUDE_PROJECT_DIR_MAX_LENGTH) {
    return { name: encoded.slice(0, CLAUDE_PROJECT_DIR_MAX_LENGTH), truncated: true }
  }
  return { name: encoded, truncated: false }
}

export interface EncodingSample {
  /** Name of an existing <claudeConfigDir>/projects/<dirName> directory. */
  dirName: string
  /** Distinct cwd values observed in that directory's transcripts (may be empty). */
  cwds: string[]
}

export type EncodingExampleStatus = 'matched' | 'mismatched' | 'unknown'

export interface EncodingExample {
  dirName: string
  cwd: string | null
  expected: string | null
  status: EncodingExampleStatus
  note?: string
}

export interface EncodingVerification {
  rule: typeof ENCODING_RULE
  claudeConfigDir: string
  /** True when at least one sample matched and none mismatched. */
  verified: boolean
  matched: number
  mismatched: number
  /** Samples without cwd evidence or with an unverifiable (truncated + hashed) name. */
  unknown: number
  examples: EncodingExample[]
}

const MAX_EXAMPLES = 8

/**
 * Compares `encodeProjectDirName(cwd)` with the actual directory names. A directory counts as
 * matched when ANY of its observed cwds reproduces the name (sessions can `/cd`, so a directory may
 * legitimately show several cwds); it counts as mismatched when it has cwd evidence and none agrees.
 */
export function verifyEncoding(
  claudeConfigDir: string,
  samples: readonly EncodingSample[],
): EncodingVerification {
  let matched = 0
  let mismatched = 0
  let unknown = 0
  const examples: EncodingExample[] = []
  const pushExample = (example: EncodingExample): void => {
    if (examples.length < MAX_EXAMPLES) examples.push(example)
  }
  for (const sample of samples) {
    const cwds = [...new Set(sample.cwds)]
    if (sample.dirName.length >= CLAUDE_PROJECT_DIR_MAX_LENGTH) {
      unknown += 1
      pushExample({
        dirName: sample.dirName,
        cwd: cwds[0] ?? null,
        expected: null,
        status: 'unknown',
        note: 'name reaches the 200 character limit; the hash suffix is undocumented',
      })
      continue
    }
    if (cwds.length === 0) {
      unknown += 1
      pushExample({
        dirName: sample.dirName,
        cwd: null,
        expected: null,
        status: 'unknown',
        note: 'no cwd evidence in sampled transcripts',
      })
      continue
    }
    const agreeing = cwds.find((cwd) => {
      const encoded = encodeProjectDirName(cwd)
      return !encoded.truncated && encoded.name === sample.dirName
    })
    if (agreeing !== undefined) {
      matched += 1
      pushExample({
        dirName: sample.dirName,
        cwd: agreeing,
        expected: sample.dirName,
        status: 'matched',
      })
    } else {
      mismatched += 1
      const first = cwds[0] as string
      pushExample({
        dirName: sample.dirName,
        cwd: first,
        expected: encodeProjectDirName(first).name,
        status: 'mismatched',
      })
    }
  }
  return {
    rule: ENCODING_RULE,
    claudeConfigDir,
    verified: mismatched === 0 && matched > 0,
    matched,
    mismatched,
    unknown,
    examples,
  }
}
