import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Plugin-owned settings live OUTSIDE opencode's config on purpose: opencode strips
// unknown provider keys during config decode, so filter/override/disabled state can't
// reliably live in the provider block. Keeping it here also avoids polluting the
// user's opencode.jsonc. Keyed by provider id.

export interface ModelOverride {
  context?: number
  output?: number
}

export interface ProviderSettings {
  disabled?: boolean
  filter?: { include?: string[]; exclude?: string[] }
  overrides?: Record<string, ModelOverride>
}

type Store = Record<string, ProviderSettings>

export function settingsFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config")
  return path.join(base, "opencode-provider-manager", "settings.json")
}

function read(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFilePath(), "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

function write(store: Store): void {
  const file = settingsFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(store, null, 2))
}

/** Prune empty settings so the store stays tidy (empty object => remove the key). */
function isEmpty(s: ProviderSettings): boolean {
  return (
    !s.disabled &&
    (!s.filter || (!(s.filter.include?.length) && !(s.filter.exclude?.length))) &&
    (!s.overrides || Object.keys(s.overrides).length === 0)
  )
}

export function getProviderSettings(id: string): ProviderSettings {
  return read()[id] ?? {}
}

export function allSettings(): Store {
  return read()
}

export function updateProviderSettings(id: string, patch: Partial<ProviderSettings>): ProviderSettings {
  const store = read()
  const next: ProviderSettings = { ...(store[id] ?? {}), ...patch }
  if (isEmpty(next)) delete store[id]
  else store[id] = next
  write(store)
  return next
}

export function setDisabled(id: string, disabled: boolean): void {
  updateProviderSettings(id, { disabled: disabled || undefined })
}

export function setFilter(id: string, filter: ProviderSettings["filter"] | undefined): void {
  updateProviderSettings(id, { filter })
}

export function setModelOverride(id: string, modelId: string, override: ModelOverride): void {
  const current = getProviderSettings(id)
  const overrides = { ...(current.overrides ?? {}) }
  const merged: ModelOverride = { ...(overrides[modelId] ?? {}), ...override }
  if (merged.context === undefined && merged.output === undefined) delete overrides[modelId]
  else overrides[modelId] = merged
  updateProviderSettings(id, { overrides })
}

/** Drop all settings for a provider (used when a provider is removed). */
export function removeProviderSettings(id: string): void {
  const store = read()
  if (id in store) {
    delete store[id]
    write(store)
  }
}
