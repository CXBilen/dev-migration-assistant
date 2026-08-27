/**
 * The documented Claude Code project-directory encoding (docs/research/claude-code-storage.md §5):
 * every character outside [A-Za-z0-9] becomes '-'. No truncation/hash handling for >200 chars
 * (undocumented); fixture paths never get that long.
 */
export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-')
}
