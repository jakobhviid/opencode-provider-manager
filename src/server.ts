import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
  clearModelsDevCache,
  endpointContextWindow,
  enrichModels,
  fetchEndpointModels,
  isChatModel,
  modelsDevContextWindow,
  type DiscoveredModel,
  type EndpointModel,
} from "./discovery.js"
import { isValidUrl, sanitizeErrorMessage, sanitizeModelId } from "./security.js"
import { hasProvider, removeProvider, setDefaultModel, setProviderBaseURL, upsertProvider } from "./opencode-config.js"
import {
  getProviderSettings,
  removeProviderSettings,
  setDisabled,
  setDisplayStyle,
  setFilter,
  setModelOverride,
} from "./settings.js"
import { ProviderManagerRpc, type Api, type KeySource, type ProviderStatus } from "./rpc.js"

export const id = "opencode-provider-manager"

const REFRESH_INTERVAL = 60_000

/** A provider this plugin discovers models for: OpenAI-compatible, with a baseURL and no configured models. */
interface Target {
  id: string
  name: string
  baseURL: string
  apiKey?: string
  keySource: KeySource
}

/** The last discovery result for a provider. Kept through outages so models don't flicker away. */
interface Inventory {
  baseURL: string
  raw: EndpointModel[]
  models: DiscoveredModel[]
  checked: number
  error?: string
}

// Shared by every plugin instance in the process (opencode runs one per
// location), and persisted so a restart shows the last-known models before the
// first fetch returns.
const INVENTORY_FILE = path.join(os.homedir() || "/tmp", ".cache", "opencode-provider-manager", "inventory.json")
const inventories = new Map<string, Inventory>(loadInventories())
const inflight = new Map<string, Promise<void>>()

function loadInventories(): Array<[string, Inventory]> {
  try {
    const parsed = JSON.parse(fs.readFileSync(INVENTORY_FILE, "utf8")) as Record<string, Inventory>
    return Object.entries(parsed).map(([id, inv]) => [id, { ...inv, checked: 0, error: undefined }])
  } catch {
    return []
  }
}

function saveInventories(): void {
  try {
    fs.mkdirSync(path.dirname(INVENTORY_FILE), { mode: 0o700, recursive: true })
    const data = Object.fromEntries(
      [...inventories].map(([id, inv]) => [id, { baseURL: inv.baseURL, raw: inv.raw, models: inv.models }]),
    )
    fs.writeFileSync(INVENTORY_FILE, JSON.stringify(data), { mode: 0o600 })
  } catch {
    // the cache is an optimisation; discovery still works without it
  }
}

function envKey(providerId: string): string | undefined {
  return process.env[`OPENCODE_LOCAL_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`]
}

/** Discovery runs for OpenAI-compatible providers that declare a baseURL and no models of their own. */
function eligible(record: {
  provider: { id: string; name: string; package: string; settings?: Record<string, unknown> }
  models: ReadonlyMap<string, unknown>
}): Target | undefined {
  if (!record.provider.package.includes("openai-compatible")) return undefined
  if (record.models.size > 0) return undefined
  const baseURL = record.provider.settings?.baseURL
  if (typeof baseURL !== "string" || !isValidUrl(baseURL)) return undefined
  const configured = record.provider.settings?.apiKey
  const apiKey = typeof configured === "string" && configured ? configured : envKey(record.provider.id)
  return {
    id: record.provider.id,
    name: record.provider.name,
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey,
    keySource: typeof configured === "string" && configured ? "config" : apiKey ? "env" : "none",
  }
}

async function enrichFor(providerId: string, raw: readonly EndpointModel[]): Promise<DiscoveredModel[]> {
  const settings = getProviderSettings(providerId)
  return enrichModels(raw, {
    displayStyle: settings.displayStyle,
    filter: settings.filter,
    overrides: settings.overrides,
  })
}

/** Fetch one provider's models, at most once at a time per provider across all plugin instances. */
function discover(target: Target, apiKey: string | undefined): Promise<void> {
  const running = inflight.get(target.id)
  if (running) return running
  const run = (async () => {
    const previous = inventories.get(target.id)
    try {
      const raw = await fetchEndpointModels(target.baseURL, apiKey)
      const models = await enrichFor(target.id, raw)
      inventories.set(target.id, { baseURL: target.baseURL, raw, models, checked: Date.now() })
    } catch (error) {
      const message = sanitizeErrorMessage(error)
      const kept = previous?.baseURL === target.baseURL ? previous : undefined
      inventories.set(target.id, {
        baseURL: target.baseURL,
        raw: kept?.raw ?? [],
        models: kept?.models ?? [],
        checked: Date.now(),
        error: message,
      })
    }
    saveInventories()
  })().finally(() => inflight.delete(target.id))
  inflight.set(target.id, run)
  return run
}

function fingerprint(inv: Inventory | undefined): string {
  return JSON.stringify([inv?.baseURL, inv?.models])
}

const server: Plugin.Plugin["setup"] = async (ctx) => {
  const rpc = ctx.rpc
  let targets = new Map<string, Target>()
  // What this instance last put into its provider catalog, so it reloads only on change.
  const applied = new Map<string, string>()
  // Keys from opencode's own credential store (/connect), resolved per refresh.
  const connectionKeys = new Map<string, string>()

  async function resolveKey(target: Target): Promise<string | undefined> {
    if (target.apiKey) return target.apiKey
    try {
      const connection = await ctx.integration.connection.active(target.id)
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
      if (credential?.type === "key") {
        connectionKeys.set(target.id, credential.key)
        return credential.key
      }
    } catch {
      // no integration for this provider — discover without a key
    }
    connectionKeys.delete(target.id)
    return undefined
  }

  let chain: Promise<void> = Promise.resolve()
  /** Re-discover stale (or, when forced, all) providers, then reload the catalog if anything changed. */
  function refresh(force = false): Promise<void> {
    chain = chain.then(async () => {
      const due = [...targets.values()].filter((target) => {
        if (getProviderSettings(target.id).disabled) return false
        const inv = inventories.get(target.id)
        return force || !inv || inv.baseURL !== target.baseURL || Date.now() - inv.checked >= REFRESH_INTERVAL
      })
      await Promise.all(due.map(async (target) => discover(target, await resolveKey(target))))
      const changed = [...targets.keys()].some((id) => applied.get(id) !== fingerprint(inventories.get(id)))
      if (changed) await ctx.model.reload()
    })
    return chain.catch(() => {})
  }

  // A model transform, not a provider transform: it runs after every provider
  // source (including the config's own) has resolved, so configured providers
  // are visible here, and it can add models to any available provider.
  await ctx.model.transform((editor) => {
    const next = new Map<string, Target>()
    for (const record of editor.provider.list()) {
      const target = eligible(record)
      if (!target) continue
      next.set(target.id, target)
      const inv = inventories.get(target.id)
      applied.set(target.id, fingerprint(inv))
      if (!inv || inv.baseURL !== target.baseURL || getProviderSettings(target.id).disabled) continue
      for (const found of inv.models) {
        editor.update(target.id, found.id, (model) => {
          model.name = found.name
          if (found.family) model.family = found.family as unknown as typeof model.family
          model.capabilities = {
            tools: found.tools,
            input: found.vision ? ["text", "image"] : ["text"],
            output: ["text"],
          }
          model.limit = { context: found.context, output: found.output }
        })
      }
    }
    const added = [...next.keys()].some((id) => targets.get(id)?.baseURL !== next.get(id)?.baseURL)
    targets = next
    // Transforms are synchronous; discovery for new or re-pointed providers runs after.
    if (added) queueMicrotask(() => void refresh())
  })

  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL)
  void refresh()

  /** Re-enrich a provider from its cached /models response after a settings change, then reload. */
  async function reenrich(providerId: string): Promise<void> {
    const inv = inventories.get(providerId)
    if (inv) {
      inventories.set(providerId, { ...inv, models: await enrichFor(providerId, inv.raw) })
      saveInventories()
    }
    await ctx.model.reload()
    await refresh()
  }

  const keySource = (target: Target): KeySource =>
    target.keySource === "none" && connectionKeys.has(target.id) ? "connection" : target.keySource

  const handlers: { [Name in keyof Api]: (input: any) => Promise<object> } = {
    async list() {
      const providers: ProviderStatus[] = [...targets.values()].map((target) => {
        const settings = getProviderSettings(target.id)
        const inv = inventories.get(target.id)
        return {
          id: target.id,
          name: target.name,
          baseURL: target.baseURL,
          keySource: keySource(target),
          editable: hasProvider(target.id),
          disabled: Boolean(settings.disabled),
          displayStyle: settings.displayStyle ?? "slug",
          filter: settings.filter,
          overrides: Object.keys(settings.overrides ?? {}),
          models: inv?.baseURL === target.baseURL ? inv.models.length : 0,
          checked: inv?.checked || undefined,
          error: inv?.error,
        }
      })
      return { providers: providers.sort((a, b) => a.id.localeCompare(b.id)) }
    },

    async refresh() {
      clearModelsDevCache()
      await refresh(true)
      const all = [...targets.values()].filter((t) => !getProviderSettings(t.id).disabled)
      const failed = all.filter((t) => inventories.get(t.id)?.error)
      const models = all.reduce((sum, t) => sum + (inventories.get(t.id)?.models.length ?? 0), 0)
      if (all.length === 0) return { ok: false, message: "No providers to discover. Add one with /pm-add-provider." }
      if (failed.length === 0) return { ok: true, message: `Discovered ${models} model(s) from ${all.length} provider(s).` }
      return {
        ok: false,
        message:
          `Discovered ${models} model(s); ${failed.length} provider(s) failed: ` +
          failed.map((t) => `${t.id} (${inventories.get(t.id)?.error})`).join("; "),
      }
    },

    async add(input: Parameters<Api["add"]>[0]) {
      const providerId = String(input.providerId ?? "").trim()
      const baseURL = String(input.baseURL ?? "").trim().replace(/\/+$/, "")
      const apiKey = input.apiKey?.trim() || undefined
      if (!/^[a-zA-Z0-9_-]+$/.test(providerId))
        return { ok: false, message: "Invalid name. Use letters, numbers, hyphens, or underscores only." }
      if (!isValidUrl(baseURL)) return { ok: false, message: "Invalid address. Enter a full URL, including https://." }
      if (!input.overwrite && (targets.has(providerId) || hasProvider(providerId)))
        return { ok: false, message: `A provider called '${providerId}' already exists.` }

      let raw: EndpointModel[]
      try {
        raw = await fetchEndpointModels(baseURL, apiKey)
      } catch (error) {
        return { ok: false, message: `Couldn't list models at ${baseURL}: ${sanitizeErrorMessage(error)}` }
      }
      const chat = raw.filter(isChatModel).length
      if (chat === 0) return { ok: false, message: `${baseURL} reports no chat models. Provider not added.` }

      setDisplayStyle(providerId, input.displayStyle)
      // Seed the inventory so the models appear as soon as opencode picks up the config change.
      inventories.set(providerId, { baseURL, raw, models: await enrichFor(providerId, raw), checked: Date.now() })
      saveInventories()
      upsertProvider(providerId, { name: providerId, baseURL, apiKey })
      return { ok: true, message: `Added '${providerId}' with ${chat} model(s).` }
    },

    async edit(input: Parameters<Api["edit"]>[0]) {
      const baseURL = String(input.baseURL ?? "").trim().replace(/\/+$/, "")
      if (!isValidUrl(baseURL)) return { ok: false, message: "Invalid address. Enter a full URL, including https://." }
      const file = setProviderBaseURL(input.providerId, baseURL)
      if (!file) return { ok: false, message: `'${input.providerId}' isn't defined in the global opencode config.` }
      return { ok: true, message: `Updated '${input.providerId}' to ${baseURL}.` }
    },

    async remove(input: Parameters<Api["remove"]>[0]) {
      const { file, existed } = removeProvider(input.providerId)
      if (!existed) return { ok: false, message: `'${input.providerId}' isn't defined in ${file}.` }
      removeProviderSettings(input.providerId)
      inventories.delete(input.providerId)
      saveInventories()
      return { ok: true, message: `Removed '${input.providerId}'.` }
    },

    async models(input: Parameters<Api["models"]>[0]) {
      const models = inventories.get(input.providerId)?.models ?? []
      return { models: models.map((m) => ({ id: m.id, name: m.name, context: m.context })) }
    },

    async toggle(input: Parameters<Api["toggle"]>[0]) {
      const disabled = !getProviderSettings(input.providerId).disabled
      setDisabled(input.providerId, disabled)
      await ctx.model.reload()
      if (!disabled) await refresh()
      return { ok: true, message: `'${input.providerId}' ${disabled ? "disabled" : "enabled"}.` }
    },

    async filter(input: Parameters<Api["filter"]>[0]) {
      const filter = input.filter?.include?.length || input.filter?.exclude?.length ? input.filter : undefined
      setFilter(input.providerId, filter)
      await reenrich(input.providerId)
      const count = inventories.get(input.providerId)?.models.length ?? 0
      return {
        ok: true,
        message: `${filter ? "Filter saved" : "Filter cleared"} for '${input.providerId}' — ${count} model(s).`,
      }
    },

    async override(input: Parameters<Api["override"]>[0]) {
      const modelId = sanitizeModelId(input.modelId)
      setModelOverride(input.providerId, modelId, { context: input.context })
      await reenrich(input.providerId)
      return {
        ok: true,
        message: input.context
          ? `Set ${input.providerId}/${modelId} context to ${input.context.toLocaleString()}.`
          : `Cleared the context override for ${input.providerId}/${modelId}.`,
      }
    },

    async contextHint(input: Parameters<Api["contextHint"]>[0]) {
      const item = inventories.get(input.providerId)?.raw.find((m) => sanitizeModelId(m.id) === input.modelId)
      return {
        endpoint: item ? endpointContextWindow(item) : undefined,
        modelsDev: await modelsDevContextWindow(input.modelId),
      }
    },

    async defaultModel(input: Parameters<Api["defaultModel"]>[0]) {
      setDefaultModel(input.model)
      return { ok: true, message: `Default model set to '${input.model}'.` }
    },
  }

  // RPC output must be strict JSON; round-tripping drops the undefined optionals.
  const json = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      async (input: unknown) => JSON.parse(JSON.stringify(await handler(input ?? {}))),
    ]),
  )
  const registration = await rpc.register(ProviderManagerRpc, json as never)

  return async () => {
    clearInterval(timer)
    await registration.dispose()
  }
}

export default { id, setup: server } satisfies Plugin.Plugin
