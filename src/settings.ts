import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { DisplayStyle, ModelFilter, ModelOverride } from "./discovery.js"

// Plugin-owned settings live OUTSIDE opencode's config on purpose: opencode strips
// unknown provider keys during config decode, so per-provider plugin state can't
// live in the provider block. Keeping it here also avoids polluting the user's
// opencode.jsonc.

export interface ProviderSettings {
  disabled?: boolean
  displayStyle?: DisplayStyle
  filter?: ModelFilter
  overrides?: Record<string, ModelOverride>
}

interface SettingsFile {
  /**
   * Show only providers declared in an opencode config file, hiding opencode's
   * own hosted models and logged-in services. A fleet manager may own this key,
   * so writes preserve it (and any other top-level key) as found.
   */
  onlyConfiguredProviders?: boolean
  providers: Record<string, ProviderSettings>
  [key: string]: unknown
}

export function settingsFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config")
  return path.join(base, "opencode-provider-manager", "settings.json")
}

function read(): SettingsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(settingsFilePath(), "utf8"))
  } catch {
    return { providers: {} }
  }
  if (!parsed || typeof parsed !== "object") return { providers: {} }
  const file = parsed as Record<string, unknown>
  const providers = file.providers && typeof file.providers === "object" ? (file.providers as SettingsFile["providers"]) : {}
  return { ...file, providers }
}

function write(data: SettingsFile): void {
  const file = settingsFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
}

/** Prune empty settings so the store stays tidy (empty object => remove the key). */
function isEmpty(s: ProviderSettings): boolean {
  return (
    !s.disabled &&
    !s.displayStyle &&
    (!s.filter || (!s.filter.include?.length && !s.filter.exclude?.length)) &&
    (!s.overrides || Object.keys(s.overrides).length === 0)
  )
}

export function getProviderSettings(id: string): ProviderSettings {
  return read().providers[id] ?? {}
}

export function updateProviderSettings(id: string, patch: Partial<ProviderSettings>): ProviderSettings {
  const data = read()
  const next: ProviderSettings = { ...(data.providers[id] ?? {}), ...patch }
  if (isEmpty(next)) delete data.providers[id]
  else data.providers[id] = next
  write(data)
  return next
}

export function setDisabled(id: string, disabled: boolean): void {
  updateProviderSettings(id, { disabled: disabled || undefined })
}

export function setDisplayStyle(id: string, displayStyle: DisplayStyle | undefined): void {
  // "slug" is the default, so only "name" is stored.
  updateProviderSettings(id, { displayStyle: displayStyle === "name" ? "name" : undefined })
}

export function setFilter(id: string, filter: ModelFilter | undefined): void {
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
  const data = read()
  if (id in data.providers) {
    delete data.providers[id]
    write(data)
  }
}

/** Whether only config-declared providers are listed. Off unless the settings file says so. */
export function getOnlyConfiguredProviders(): boolean {
  return read().onlyConfiguredProviders === true
}
