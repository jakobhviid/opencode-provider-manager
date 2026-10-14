import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { modify, applyEdits, parse as parseJsonc, type JSONPath } from "jsonc-parser"

// Comment-preserving edits: jsonc-parser rewrites only the touched span, so the
// user's hand-authored comments and formatting survive. opencode watches its
// config directory and reloads on change, so every write here applies live.
const FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" as const }

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

/**
 * opencode's global config directory, resolved the same way opencode does:
 * XDG_CONFIG_HOME (or ~/.config) + /opencode.
 */
function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, "opencode")
}

/**
 * The global opencode config file this plugin reads and writes. Honors an
 * explicit OPENCODE_CONFIG path; otherwise prefers an existing opencode.jsonc /
 * opencode.json in the global dir, defaulting to opencode.jsonc.
 */
export function resolveConfigFilePath(): string {
  const override = process.env.OPENCODE_CONFIG
  if (override && override.trim()) return override
  const dir = globalConfigDir()
  const jsonc = path.join(dir, "opencode.jsonc")
  const json = path.join(dir, "opencode.json")
  if (fs.existsSync(jsonc)) return jsonc
  if (fs.existsSync(json)) return json
  return jsonc
}

function readText(file: string): string {
  try {
    const text = fs.readFileSync(file, "utf8")
    return text.trim() === "" ? "{}\n" : text
  } catch {
    return "{}\n"
  }
}

function edit(text: string, at: JSONPath, value: unknown): string {
  return applyEdits(text, modify(text, at, value, { formattingOptions: FORMATTING }))
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

type Parsed = { provider?: Record<string, unknown>; providers?: Record<string, unknown> } | undefined

/**
 * Which section defines a provider. opencode reads both the legacy `provider`
 * map (npm/options) and the native `providers` map (package/settings).
 */
function sectionOf(parsed: Parsed, providerId: string): "provider" | "providers" | undefined {
  if (parsed?.provider && providerId in parsed.provider) return "provider"
  if (parsed?.providers && providerId in parsed.providers) return "providers"
  return undefined
}

/** Whether the global config file defines this provider (as opposed to a project config or plugin). */
export function hasProvider(providerId: string): boolean {
  const text = readText(resolveConfigFilePath())
  return sectionOf(parseJsonc(text) as Parsed, providerId) !== undefined
}

/**
 * Add an OpenAI-compatible provider with no `models` block, which is what makes
 * it eligible for discovery. Written in whichever style the file already uses.
 * An existing provider keeps its block: only its base URL (and key, if given)
 * change, so custom headers or settings survive. Returns the path written.
 */
export function upsertProvider(providerId: string, entry: { name: string; baseURL: string; apiKey?: string }): string {
  const file = resolveConfigFilePath()
  let text = readText(file)
  const parsed = parseJsonc(text) as Parsed
  const existing = sectionOf(parsed, providerId)
  if (existing) {
    const options = existing === "provider" ? "options" : "settings"
    text = edit(text, [existing, providerId, options, "baseURL"], entry.baseURL)
    if (entry.apiKey) text = edit(text, [existing, providerId, options, "apiKey"], entry.apiKey)
  } else if (!parsed?.provider && parsed?.providers) {
    text = edit(text, ["providers", providerId], {
      name: entry.name,
      package: `aisdk:${OPENAI_COMPATIBLE}`,
      settings: { baseURL: entry.baseURL, ...(entry.apiKey ? { apiKey: entry.apiKey } : {}) },
    })
  } else {
    text = edit(text, ["provider", providerId], {
      name: entry.name,
      npm: OPENAI_COMPATIBLE,
      options: { baseURL: entry.baseURL, ...(entry.apiKey ? { apiKey: entry.apiKey } : {}) },
    })
  }
  write(file, text)
  return file
}

/**
 * Remove a provider block from the global opencode config (comment-preserving).
 * Returns whether the provider existed and the file inspected.
 */
export function removeProvider(providerId: string): { file: string; existed: boolean } {
  const file = resolveConfigFilePath()
  let text = readText(file)
  const parsed = parseJsonc(text) as Parsed
  let existed = false
  for (const section of ["provider", "providers"] as const) {
    if (!parsed?.[section] || !(providerId in parsed[section]!)) continue
    text = edit(text, [section, providerId], undefined)
    existed = true
  }
  if (existed) write(file, text)
  return { file, existed }
}

/**
 * Update ONLY a provider's base URL, preserving everything else in its block, so
 * a discovered model list is never frozen into the file. Returns the path
 * written, or undefined if the global config doesn't define the provider.
 */
export function setProviderBaseURL(providerId: string, baseURL: string): string | undefined {
  const file = resolveConfigFilePath()
  const text = readText(file)
  const section = sectionOf(parseJsonc(text) as Parsed, providerId)
  if (!section) return undefined
  const at = section === "provider" ? ["provider", providerId, "options", "baseURL"] : ["providers", providerId, "settings", "baseURL"]
  write(file, edit(text, at, baseURL))
  return file
}

/**
 * Set the default model (`model` field) in the global opencode config,
 * comment-preserving. `modelRef` is a "providerID/modelID" string. Returns the path.
 */
export function setDefaultModel(modelRef: string): string {
  const file = resolveConfigFilePath()
  write(file, edit(readText(file), ["model"], modelRef))
  return file
}
