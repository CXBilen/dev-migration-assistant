/**
 * Fails fast with a clear message when the app has not been built (the suite drives apps/desktop/out).
 */
import { assertBuilt, electronExecutablePath } from './helpers/launch'

export default async function globalSetup(): Promise<void> {
  await assertBuilt()
  electronExecutablePath()
}
