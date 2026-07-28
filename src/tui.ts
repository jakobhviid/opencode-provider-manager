import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { discoverAndEnrich, fetchEndpointModels, detectContextWindow, type DisplayStyle } from "./discovery.js"
import { getApiKey, type ProviderConfig } from "./types.js"
import { sanitizeErrorMessage } from "./security.js"
import {
  reloadAllProviders,
  addProvider,
  validateAddProviderParams,
  validateProviderId,
  persistProviderApiKey,
} from "./commands.js"
import {
  upsertProvider,
  removeProvider,
  removeCredential,
  listCredentialIds,
  setDefaultModel,
  setProviderBaseURL,
  getStoredCredential,
} from "./opencode-config.js"
import {
  getProviderSettings,
  setDisabled,
  setFilter,
  setModelOverride,
  removeProviderSettings,
  getAutoReload,
  setAutoReload,
} from "./settings.js"

export const id = "opencode-provider-manager"

function showPrompt(
  api: TuiPluginApi,
  title: string,
  placeholder?: string,
  value?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogPrompt({
          title,
          placeholder,
          value, // editable prefill (not ghost text), so confirming keeps the current value
          onConfirm: (v: string) => resolve(v),
          onCancel: () => resolve(null),
        }),
      () => resolve(null),
    )
  })
}

function showConfirm(api: TuiPluginApi, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogConfirm({
          title,
          message,
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      () => resolve(false),
    )
  })
}

function showSelect<V>(
  api: TuiPluginApi,
  title: string,
  options: Array<{ title: string; value: V; description?: string }>,
): Promise<V | null> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title,
          options: options.map((o) => ({
            ...o,
            onSelect: () => resolve(o.value),
          })),
        }),
      () => resolve(null),
    )
  })
}

function parseList(input: string | null): string[] | undefined {
  const arr = (input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return arr.length ? arr : undefined
}

/** Resolve a provider's API key from config/env or the auth store (for discovery/testing). */
function keyFor(providerId: string, provider: ProviderConfig): string | undefined {
  return getApiKey(provider, providerId) ?? getStoredCredential(providerId)
}

/**
 * Trigger opencode's built-in reload (SIGUSR2 -> invalidate config + dispose/rebuild
 * instances -> re-run discovery), but ONLY when a SIGUSR2 handler is registered.
 * Without a handler, SIGUSR2 would terminate opencode, so we never fire in that case.
 * TUI commands run in the same process as the handler, so this is safe there.
 * Returns whether a reload was actually triggered.
 */
function triggerReload(): boolean {
  try {
    if (process.listenerCount("SIGUSR2") === 0) return false
    process.kill(process.pid, "SIGUSR2")
    return true
  } catch {
    return false
  }
}

/** Report a successful change and auto-reload opencode to apply it (when enabled + safe). */
function applyReload(api: TuiPluginApi, what: string): void {
  if (getAutoReload() && triggerReload()) {
    api.ui.toast({ message: `${what} — reloaded.`, variant: "success" })
  } else {
    api.ui.toast({
      message: `${what}. Restart opencode to apply${getAutoReload() ? "" : " (auto-reload is off)"}.`,
      variant: "success",
    })
  }
}

export const tui: TuiPlugin = async (api: TuiPluginApi) => {
  api.command.register(() => [
    {
      title: "Reload Models",
      value: "reload-models",
      description: "Re-discover models from all dynamic providers without restarting",
      slash: {
        name: "reload-models",
        aliases: ["refresh-models"],
      },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}

        const result = await reloadAllProviders(providers)

        if (result.providerCount === 0) {
          api.ui.toast({ message: "No dynamic providers configured.", variant: "warning" })
          return
        }

        api.ui.toast({
          message: `Reloading models from ${result.providerCount} provider(s)...`,
          variant: "info",
        })

        for (const w of result.warnings) {
          api.ui.toast({ message: w, variant: "warning" })
        }
        for (const e of result.errors) {
          api.ui.toast({ message: e, variant: "error" })
        }

        // No config write — discovery re-runs on reload/launch. (client.config.update
        // writes an unloaded <cwd>/config.json.)
        if (result.failures === 0) {
          applyReload(api, `Re-discovered ${result.totalModels} model(s) from ${result.providerCount} provider(s)`)
        } else if (result.totalModels > 0) {
          api.ui.toast({
            message: `Re-discovered ${result.totalModels} model(s) with ${result.failures} failure(s). Restart opencode to apply.`,
            variant: "warning",
          })
        }
      },
    },
    {
      title: "Add Provider",
      value: "add-provider",
      description: "Add a new OpenAI-compatible custom provider with dynamic model discovery",
      slash: {
        name: "add-provider",
      },
      onSelect: async () => {
        const rawProviderId = await showPrompt(
          api,
          "Short name for this provider (you'll pick it by this name in the model list later)",
          "e.g. my-proxy — letters, numbers, hyphens, underscores",
        )
        if (!rawProviderId) return

        const providerId = rawProviderId.trim()
        const idError = validateProviderId(providerId)
        if (idError) {
          api.ui.toast({ message: idError, variant: "error" })
          return
        }

        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}

        let overwrite = false
        if (providers[providerId]) {
          overwrite = await showConfirm(
            api,
            "That name is already taken",
            `A provider called '${providerId}' already exists. Replace it?`,
          )
          if (!overwrite) return
        }

        const rawBaseURL = await showPrompt(
          api,
          "API address (the OpenAI-compatible endpoint, usually ending in /v1)",
          "https://api.example.com/v1",
        )
        if (!rawBaseURL) return

        const baseURL = rawBaseURL.trim()

        const rawApiKey = await showPrompt(
          api,
          "API key (leave blank if this endpoint doesn't need one)",
          "sk-… — optional",
        )
        const apiKey = rawApiKey?.trim() || undefined

        const displayStyle = await showSelect<DisplayStyle>(
          api,
          "How should model names appear in the model list?",
          [
            {
              title: "Exact model IDs (recommended for proxies)",
              value: "slug",
              description: "Shows the raw id, e.g. vertex/gemini-3.1-pro",
            },
            {
              title: "Friendly names",
              value: "name",
              description: "Cleaned-up labels, e.g. Gemini 3.1 Pro (can be ambiguous)",
            },
          ],
        )
        if (!displayStyle) return

        const params = { providerId, baseURL, apiKey, displayStyle, overwrite }
        const validationError = validateAddProviderParams(params, providers)
        if (validationError) {
          api.ui.toast({ message: validationError, variant: "error" })
          return
        }

        api.ui.toast({ message: `Discovering models from ${baseURL}...`, variant: "info" })

        const result = await addProvider(params)

        if (!result.success || !result.providerEntry) {
          api.ui.toast({ message: result.message, variant: "warning" })
          return
        }

        await persistProviderApiKey(
          result.providerEntry,
          providerId,
          apiKey,
          async (id, key) => {
            await api.client.auth.set({ providerID: id, auth: { type: "api", key } })
            return true
          },
        )

        // On overwrite, keep the existing provider's custom options (headers, etc.)
        // but not its baseURL (replaced) or in-config apiKey (would shadow the auth store).
        if (overwrite && providers[providerId]?.options) {
          const { apiKey: _k, baseURL: _b, ...keep } = providers[providerId].options as Record<string, unknown>
          result.providerEntry.options = { ...keep, ...(result.providerEntry.options ?? {}) }
        }

        // Persist to the global config file opencode actually loads. (Works around
        // client.config.update, which writes an unloaded <cwd>/config.json.)
        upsertProvider(providerId, result.providerEntry)
        applyReload(api, `Added '${providerId}' (${result.modelCount} models)`)
      },
    },
    {
      title: "Remove Provider",
      value: "remove-provider",
      description: "Remove a custom provider and delete its stored credential",
      slash: {
        name: "remove-provider",
      },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
        const ids = Object.keys(providers)

        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }

        const providerId = await showSelect<string>(
          api,
          "Which provider do you want to remove?",
          ids.map((id) => ({
            title: id,
            value: id,
            description: providers[id]?.options?.baseURL,
          })),
        )
        if (!providerId) return

        const confirmed = await showConfirm(
          api,
          "Remove this provider?",
          `This deletes '${providerId}' from your opencode config and removes its saved API key. This can't be undone.`,
        )
        if (!confirmed) return

        const { file, existed } = removeProvider(providerId)
        const credentialRemoved = removeCredential(providerId)
        removeProviderSettings(providerId)

        if (!existed) {
          api.ui.toast({
            message: `'${providerId}' was not in ${file}${credentialRemoved ? " (removed a stray credential)" : ""}.`,
            variant: "warning",
          })
          return
        }

        applyReload(api, `Removed '${providerId}'${credentialRemoved ? " and its credential" : ""}`)
      },
    },
    {
      title: "Set Provider API Key",
      value: "add-provider-auth",
      description: "Set the API key for an existing provider",
      slash: {
        name: "add-provider-auth",
      },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
        const ids = Object.keys(providers)

        if (ids.length === 0) {
          api.ui.toast({
            message: "No providers configured. Add one with /add-provider first.",
            variant: "warning",
          })
          return
        }

        const providerId = await showSelect<string>(
          api,
          "Which provider do you want to set an API key for?",
          ids.map((id) => ({
            title: id,
            value: id,
            description: providers[id]?.options?.baseURL,
          })),
        )
        if (!providerId) return

        const rawKey = await showPrompt(api, `Paste the API key for '${providerId}'`, "sk-…")
        const apiKey = rawKey?.trim()
        if (!apiKey) {
          api.ui.toast({ message: "No key entered.", variant: "warning" })
          return
        }

        try {
          await api.client.auth.set({ providerID: providerId, auth: { type: "api", key: apiKey } })
        } catch {
          api.ui.toast({ message: `Failed to store the API key for '${providerId}'.`, variant: "error" })
          return
        }

        applyReload(api, `Stored API key for '${providerId}'`)
      },
    },
    {
      title: "Remove Provider API Key",
      value: "remove-provider-auth",
      description: "Delete the stored API key for a provider (keeps the provider)",
      slash: {
        name: "remove-provider-auth",
      },
      onSelect: async () => {
        const credentialed = listCredentialIds()

        if (credentialed.length === 0) {
          api.ui.toast({ message: "No providers have a saved API key.", variant: "warning" })
          return
        }

        const providerId = await showSelect<string>(
          api,
          "Remove the saved API key for which provider?",
          credentialed.map((id) => ({ title: id, value: id })),
        )
        if (!providerId) return

        const confirmed = await showConfirm(
          api,
          "Remove this API key?",
          `Delete the saved API key for '${providerId}'? The provider stays — only the key is removed.`,
        )
        if (!confirmed) return

        const removed = removeCredential(providerId)
        if (removed) applyReload(api, `Removed the stored key for '${providerId}'`)
        else api.ui.toast({ message: `No stored key found for '${providerId}'.`, variant: "warning" })
      },
    },
    {
      title: "List Providers",
      value: "providers",
      description: "Show configured providers, their key source, and any filters/overrides",
      slash: { name: "providers" },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const credentialed = new Set(listCredentialIds())
        const keySource = (pid: string): string => {
          const p = providers[pid]
          const envKey = `OPENCODE_LOCAL_${pid.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
          if (p.options?.apiKey) return "config"
          if (credentialed.has(pid)) return "auth store"
          if (process.env[envKey]) return "env"
          return "none"
        }
        const chosen = await showSelect<string>(
          api,
          "Providers (pick one to see details)",
          ids.map((pid) => {
            const s = getProviderSettings(pid)
            const tags = [`key: ${keySource(pid)}`]
            if (s.disabled) tags.push("disabled")
            if (s.filter?.include?.length || s.filter?.exclude?.length) tags.push("filtered")
            if (s.overrides && Object.keys(s.overrides).length) tags.push("overrides")
            return {
              title: pid,
              value: pid,
              description: `${providers[pid].options?.baseURL ?? "-"} — ${tags.join(", ")}`,
            }
          }),
        )
        if (!chosen) return
        const s = getProviderSettings(chosen)
        const parts = [
          `baseURL: ${providers[chosen].options?.baseURL ?? "-"}`,
          `key: ${keySource(chosen)}`,
          `discovery: ${s.disabled ? "disabled" : "enabled"}`,
        ]
        if (s.filter?.include?.length) parts.push(`include: ${s.filter.include.join(", ")}`)
        if (s.filter?.exclude?.length) parts.push(`exclude: ${s.filter.exclude.join(", ")}`)
        if (s.overrides && Object.keys(s.overrides).length)
          parts.push(`overrides: ${Object.keys(s.overrides).join(", ")}`)
        api.ui.toast({ message: `${chosen} · ${parts.join(" · ")}`, variant: "info" })
      },
    },
    {
      title: "Test Provider",
      value: "test-provider",
      description: "Check that a provider's endpoint responds and see its model count",
      slash: { name: "test-provider" },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const chosen = await showSelect<string>(
          api,
          "Test which provider?",
          ids.map((pid) => ({ title: pid, value: pid, description: providers[pid].options?.baseURL })),
        )
        if (!chosen) return
        const p = providers[chosen]
        if (!p.options?.baseURL) {
          api.ui.toast({ message: `'${chosen}' has no base URL.`, variant: "error" })
          return
        }
        api.ui.toast({ message: `Testing ${chosen}…`, variant: "info" })
        try {
          const models = await fetchEndpointModels(p.options.baseURL, keyFor(chosen, p))
          api.ui.toast({ message: `${chosen}: OK — ${models.length} model(s) available.`, variant: "success" })
        } catch (error) {
          api.ui.toast({ message: `${chosen}: FAILED — ${sanitizeErrorMessage(error)}`, variant: "error" })
        }
      },
    },
    {
      title: "Set Default Model",
      value: "set-default-model",
      description: "Choose the default model opencode uses for new sessions",
      slash: { name: "set-default-model" },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const provId = await showSelect<string>(
          api,
          "Default model — pick the provider first",
          ids.map((pid) => ({ title: pid, value: pid, description: providers[pid].options?.baseURL })),
        )
        if (!provId) return
        const p = providers[provId]
        if (!p.options?.baseURL) {
          api.ui.toast({ message: `'${provId}' has no base URL.`, variant: "error" })
          return
        }
        api.ui.toast({ message: `Loading models from ${provId}…`, variant: "info" })
        let modelIds: string[]
        try {
          modelIds = Object.keys(await discoverAndEnrich(p.options.baseURL, keyFor(provId, p)))
        } catch (error) {
          api.ui.toast({ message: `Couldn't load models: ${sanitizeErrorMessage(error)}`, variant: "error" })
          return
        }
        if (modelIds.length === 0) {
          api.ui.toast({ message: `${provId} returned no models.`, variant: "warning" })
          return
        }
        const modelId = await showSelect<string>(
          api,
          `Default model from ${provId}`,
          modelIds.map((m) => ({ title: m, value: m })),
        )
        if (!modelId) return
        const ref = `${provId}/${modelId}`
        setDefaultModel(ref)
        applyReload(api, `Default model set to '${ref}'`)
      },
    },
    {
      title: "Edit Provider",
      value: "edit-provider",
      description: "Change an existing provider's base URL",
      slash: { name: "edit-provider" },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const provId = await showSelect<string>(
          api,
          "Edit which provider?",
          ids.map((pid) => ({ title: pid, value: pid, description: providers[pid].options?.baseURL })),
        )
        if (!provId) return
        const current = providers[provId]
        const rawURL = await showPrompt(
          api,
          `New base URL for '${provId}'`,
          "https://api.example.com/v1",
          current.options?.baseURL,
        )
        const baseURL = rawURL?.trim()
        if (!baseURL) return
        // Surgically update only options.baseURL — never write the discovered
        // `models`/`api` that config.get() carries at runtime.
        setProviderBaseURL(provId, baseURL)
        applyReload(api, `Updated '${provId}' base URL`)
      },
    },
    {
      title: "Enable / Disable Provider",
      value: "toggle-provider",
      description: "Turn a provider's model discovery on or off without removing it",
      slash: { name: "toggle-provider" },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const provId = await showSelect<string>(
          api,
          "Enable/disable which provider?",
          ids.map((pid) => ({
            title: pid,
            value: pid,
            description: getProviderSettings(pid).disabled ? "currently disabled" : "currently enabled",
          })),
        )
        if (!provId) return
        const nowDisabled = !getProviderSettings(provId).disabled
        setDisabled(provId, nowDisabled)
        applyReload(api, `'${provId}' ${nowDisabled ? "disabled" : "enabled"}`)
      },
    },
    {
      title: "Set Model Filter",
      value: "set-model-filter",
      description: "Limit which of a provider's models are discovered (include/exclude patterns)",
      slash: { name: "set-model-filter" },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const provId = await showSelect<string>(
          api,
          "Filter which provider's models?",
          ids.map((pid) => ({ title: pid, value: pid, description: providers[pid].options?.baseURL })),
        )
        if (!provId) return
        const current = getProviderSettings(provId).filter
        const include = parseList(
          await showPrompt(
            api,
            "Only keep models matching (comma-separated regex/text; blank = all)",
            "e.g. coder, qwen",
            current?.include?.join(", "),
          ),
        )
        const exclude = parseList(
          await showPrompt(
            api,
            "Drop models matching (comma-separated regex/text; blank = none)",
            "e.g. embed, whisper",
            current?.exclude?.join(", "),
          ),
        )
        const filter = include || exclude ? { include, exclude } : undefined
        setFilter(provId, filter)
        applyReload(api, filter ? `Filter saved for '${provId}'` : `Filter cleared for '${provId}'`)
      },
    },
    {
      title: "Override Model Context",
      value: "override-model",
      description: "Set a model's context window when models.dev doesn't know it",
      slash: { name: "override-model" },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const provId = await showSelect<string>(
          api,
          "Override a model on which provider?",
          ids.map((pid) => ({ title: pid, value: pid, description: providers[pid].options?.baseURL })),
        )
        if (!provId) return
        const p = providers[provId]
        if (!p.options?.baseURL) {
          api.ui.toast({ message: `'${provId}' has no base URL.`, variant: "error" })
          return
        }
        api.ui.toast({ message: `Loading models from ${provId}…`, variant: "info" })
        let modelIds: string[]
        try {
          modelIds = Object.keys(await discoverAndEnrich(p.options.baseURL, keyFor(provId, p)))
        } catch (error) {
          api.ui.toast({ message: `Couldn't load models: ${sanitizeErrorMessage(error)}`, variant: "error" })
          return
        }
        if (modelIds.length === 0) {
          api.ui.toast({ message: `${provId} returned no models.`, variant: "warning" })
          return
        }
        const modelId = await showSelect<string>(
          api,
          `Override which model on ${provId}?`,
          modelIds.map((m) => ({ title: m, value: m })),
        )
        if (!modelId) return
        const detected = await detectContextWindow(p.options.baseURL, keyFor(provId, p), modelId)
        const options: Array<{ title: string; value: number; description?: string }> = []
        if (typeof detected.endpoint === "number")
          options.push({ title: `${detected.endpoint.toLocaleString()} (reported by endpoint)`, value: detected.endpoint })
        if (typeof detected.modelsDev === "number" && detected.modelsDev !== detected.endpoint)
          options.push({ title: `${detected.modelsDev.toLocaleString()} (models.dev)`, value: detected.modelsDev })
        for (const preset of [8192, 16384, 32768, 65536, 131072, 262144])
          options.push({ title: preset.toLocaleString(), value: preset })
        const CUSTOM = -1
        const CLEAR = -2
        options.push({ title: "Custom…", value: CUSTOM })
        options.push({ title: "Clear override", value: CLEAR })
        const picked = await showSelect<number>(api, `Context window for ${modelId}`, options)
        if (picked === null) return
        let context: number | undefined
        if (picked === CLEAR) {
          context = undefined
        } else if (picked === CUSTOM) {
          const raw = await showPrompt(api, `Context window for ${modelId} (tokens)`, "e.g. 131072")
          const n = Number((raw ?? "").replace(/[_,\s]/g, ""))
          if (!raw || !Number.isFinite(n) || n <= 0) {
            api.ui.toast({ message: "Invalid number.", variant: "error" })
            return
          }
          context = Math.floor(n)
        } else {
          context = picked
        }
        setModelOverride(provId, modelId, { context })
        applyReload(
          api,
          context
            ? `Set ${provId}/${modelId} context to ${context.toLocaleString()}`
            : `Cleared context override for ${provId}/${modelId}`,
        )
      },
    },
    {
      title: "Toggle Auto-Reload",
      value: "toggle-auto-reload",
      description: "Turn automatic opencode reload after changes on or off",
      slash: { name: "toggle-auto-reload" },
      onSelect: async () => {
        const next = !getAutoReload()
        setAutoReload(next)
        api.ui.toast({
          message: next
            ? "Auto-reload ON — changes apply immediately (opencode reloads itself)."
            : "Auto-reload OFF — changes apply on the next restart.",
          variant: "info",
        })
      },
    },
  ])
}

export default { id, tui }
