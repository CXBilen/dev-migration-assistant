import { MigrationError } from '@devmig/shared'
import type { MigrationProvider } from './contract'

/** Explicit, typed provider registration. Order of registration = order of execution. */
export class ProviderRegistry {
  private readonly providers = new Map<string, MigrationProvider>()

  register(provider: MigrationProvider): this {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`)
    }
    this.providers.set(provider.id, provider)
    return this
  }

  get(id: string): MigrationProvider {
    const p = this.providers.get(id)
    if (!p)
      throw new MigrationError('PROVIDER_NOT_FOUND', `Unknown provider: ${id}`, { details: { id } })
    return p
  }

  has(id: string): boolean {
    return this.providers.has(id)
  }

  all(): MigrationProvider[] {
    return [...this.providers.values()]
  }

  ids(): string[] {
    return [...this.providers.keys()]
  }
}
