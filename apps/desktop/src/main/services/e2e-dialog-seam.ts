/**
 * Test seam replacing native dialogs under the Playwright E2E harness.
 * Answers come from a JSON queue file (array of { kind, paths }) consumed FIFO per kind; the file is
 * rewritten after every pop so a test can inspect what is left. Never constructed unless
 * `DEVMIG_E2E=1` (see e2e.ts) and never reachable from the renderer.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MigrationError, type Logger } from '@devmig/shared'
import { z } from 'zod'

export const DialogKind = z.enum(['directories', 'file', 'save', 'destination'])
export type DialogKind = z.infer<typeof DialogKind>

export const DialogQueueEntry = z.object({
  kind: DialogKind,
  paths: z.array(z.string()),
})
export type DialogQueueEntry = z.infer<typeof DialogQueueEntry>
export const DialogQueue = z.array(DialogQueueEntry)

export interface DialogSeam {
  /** Next answer for the given kind: the paths, or null when the queue holds no answer (= cancelled). */
  next(kind: DialogKind): Promise<string[] | null>
}

export function createE2EDialogSeam(file: string, logger: Logger): DialogSeam {
  const log = logger.child({ component: 'e2e-dialog-seam' })
  let chain: Promise<unknown> = Promise.resolve()

  async function pop(kind: DialogKind): Promise<string[] | null> {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      log.warn('Dialog queue file missing; answering as cancelled', { kind })
      return null
    }
    let queue: DialogQueueEntry[]
    try {
      queue = DialogQueue.parse(JSON.parse(text))
    } catch (err) {
      throw new MigrationError('INVALID_INPUT', 'E2E dialog queue file is not valid.', {
        cause: err,
      })
    }
    const index = queue.findIndex((entry) => entry.kind === kind)
    if (index === -1) {
      log.warn('Dialog queue has no answer for this kind; answering as cancelled', { kind })
      return null
    }
    const [entry] = queue.splice(index, 1)
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
    await fs.writeFile(tmp, JSON.stringify(queue, null, 2), 'utf8')
    await fs.rename(tmp, file)
    log.info('Answered dialog from queue', { kind, count: entry?.paths.length ?? 0 })
    return entry?.paths ?? null
  }

  return {
    next(kind) {
      const result = chain.then(() => pop(kind))
      chain = result.catch(() => undefined)
      return result
    },
  }
}
