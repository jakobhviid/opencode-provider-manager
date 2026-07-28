import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { modify, applyEdits, parse as parseJsonc } from "jsonc-parser"
import type { ProviderConfig } from "./types.js"

// Comment-preserving edits: jsonc-parser rewrites only the touched span, so the
// user's hand-authored comments and formatting survive.
const FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" as const }

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
 * The global opencode config file we read/write. Honors an explicit
 * OPENCODE_CONFIG path; otherwise prefers an existing opencode.jsonc /
 * opencode.json in the global dir, defaulting to opencode.jsonc.
 *
 * IMPORTANT: this is the file opencode actually loads. The SDK's
 * `client.config.update` writes `<cwd>/config.json`, which opencode never
 * reads back — that is the bug this module works around.
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

/** opencode's global auth store: XDG_DATA_HOME (or ~/.local/share) + /opencode/auth.json. */
export function resolveAuthFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode", "auth.json")
}

function readTextOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/**
 * Insert or replace a provider block in the global opencode config, preserving
 * surrounding comments/formatting. Creates the file and the `provider` map if
 * they don't exist yet. Returns the path written.
 */
export function upsertProvider(providerId: string, entry: ProviderConfig): string {
  const file = resolveConfigFilePath()
  let text = readTextOrEmpty(file)
  if (text.trim() === "") text = "{}\n"
  const edits = modify(text, ["provider", providerId], entry, { formattingOptions: FORMATTING })
  const next = applyEdits(text, edits)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, next)
  return file
}

/**
 * Remove a provider block from the global opencode config (comment-preserving).
 * Returns whether the provider existed and the file inspected.
 */
export function removeProvider(providerId: string): { file: string; existed: boolean } {
  const file = resolveConfigFilePath()
  const text = readTextOrEmpty(file)
  if (text.trim() === "") return { file, existed: false }
  const parsed = parseJsonc(text) as { provider?: Record<string, unknown> } | undefined
  const existed = Boolean(parsed?.provider && providerId in parsed.provider)
  if (!existed) return { file, existed: false }
  const edits = modify(text, ["provider", providerId], undefined, { formattingOptions: FORMATTING })
  fs.writeFileSync(file, applyEdits(text, edits))
  return { file, existed: true }
}

/**
 * Remove a stored credential from opencode's auth store. The SDK exposes no
 * generic credential delete, so we edit auth.json directly. No-op if the store
 * or key is absent (e.g. a non-file backend). Returns whether a key was removed.
 */
export function removeCredential(providerId: string): boolean {
  const file = resolveAuthFilePath()
  let store: Record<string, unknown>
  try {
    store = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return false
  }
  if (!(providerId in store)) return false
  delete store[providerId]
  fs.writeFileSync(file, JSON.stringify(store, null, 2))
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // best effort — keep the store's existing perms if chmod is unavailable
  }
  return true
}
