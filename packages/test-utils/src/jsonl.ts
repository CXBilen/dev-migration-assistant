import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

export interface JsonlInvalidLine {
  /** 1-based line number in the file. */
  lineNumber: number
  text: string
}

export interface JsonlReadResult {
  /** Parsed JSON objects in file order (non-object JSON values count as invalid). */
  records: Record<string, unknown>[]
  invalidLines: JsonlInvalidLine[]
}

/** Streams a JSONL file line by line; never loads the whole file. Blank lines are skipped. */
export async function readJsonl(filePath: string): Promise<JsonlReadResult> {
  const records: Record<string, unknown>[] = []
  const invalidLines: JsonlInvalidLine[] = []
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let lineNumber = 0
  for await (const line of rl) {
    lineNumber += 1
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        records.push(value as Record<string, unknown>)
      } else {
        invalidLines.push({ lineNumber, text: line })
      }
    } catch {
      invalidLines.push({ lineNumber, text: line })
    }
  }
  return { records, invalidLines }
}

/** Writes pre-serialized lines (one record per line, trailing newline). Creates parent dirs. */
export async function writeJsonlLines(filePath: string, lines: readonly string[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
}

/** Serializes each record with JSON.stringify and writes the file. */
export async function writeJsonl(filePath: string, records: readonly unknown[]): Promise<void> {
  await writeJsonlLines(
    filePath,
    records.map((r) => JSON.stringify(r)),
  )
}
