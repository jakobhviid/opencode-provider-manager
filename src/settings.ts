import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Plugin-owned settings live OUTSIDE opencode's config on purpose: opencode strips
// unknown provider keys during config decode, so filter/override/disabled state can't
// reliably live in the provider block. Keeping it here also avoids polluting the
// user's opencode.jsonc.

export interface ModelOverride {
  context?: number
  output?: number
}

export interface ProviderSettings {
  disabled?: boolean
  filter?: { include?: string[]; exclude?: string[] }
  overrides?: Record<string, ModelOverride>
}

interface SettingsFile {
  // When to auto-apply changes by reloading opencode. Default on (undefined = on);
  // set false to disable auto-reload and fall back to a manual restart.
  autoReload?: boolean
  providers: Record<string, ProviderSettings>
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
  const obj = parsed as Record<string, unknown>
  // Migrate the older flat shape (Record<providerId, ProviderSettings>) into { providers }.
  if (!("providers" in obj)) {
    const { autoReload, ...rest } = obj
    return {
      autoReload: typeof autoReload === "boolean" ? autoReload : undefined,
      providers: rest as Record<string, ProviderSettings>,
    }
  }
  return {
    autoReload: typeof obj.autoReload === "boolean" ? obj.autoReload : undefined,
    providers: (obj.providers as Record<string, ProviderSettings>) ?? {},
  }
}

function write(data: SettingsFile): void {
  const file = settingsFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

/** Prune empty settings so the store stays tidy (empty object => remove the key). */
function isEmpty(s: ProviderSettings): boolean {
  return (
    !s.disabled &&
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
  const data = read()
  if (id in data.providers) {
    delete data.providers[id]
    write(data)
  }
}

// ── global reload preference ──

/** Whether to auto-apply changes by reloading opencode. Defaults to true. */
export function getAutoReload(): boolean {
  return read().autoReload !== false
}

/** Enable/disable auto-reload. Stored only when disabled (default is enabled). */
export function setAutoReload(enabled: boolean): void {
  const data = read()
  data.autoReload = enabled ? undefined : false
  write(data)
}
