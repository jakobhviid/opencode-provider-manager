import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { DisplayStyle } from "./discovery.js"
import type { ProviderConfig } from "./types.js"
import {
  reloadAllProviders,
  addProvider,
  validateAddProviderParams,
  validateProviderId,
  persistProviderApiKey,
} from "./commands.js"
import { upsertProvider, removeProvider, removeCredential, listCredentialIds } from "./opencode-config.js"

export const id = "opencode-provider-manager"

function showPrompt(api: TuiPluginApi, title: string, placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogPrompt({
          title,
          placeholder,
          onConfirm: (value: string) => resolve(value),
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

        if (result.totalModels > 0) {
          await api.client.config.update({ config: { provider: providers } as never })
        }

        if (result.failures === 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) from ${result.providerCount} provider(s).`,
            variant: "success",
          })
        } else if (result.totalModels > 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s). Check provider URLs/keys.`,
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

        // Persist to the global config file opencode actually loads. (Works around
        // client.config.update, which writes an unloaded <cwd>/config.json.)
        const configFile = upsertProvider(providerId, result.providerEntry)

        api.ui.toast({
          message: `Added '${providerId}' (${result.modelCount} models discovered) to ${configFile}. Restart opencode to use it.`,
          variant: "success",
        })
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

        if (!existed) {
          api.ui.toast({
            message: `'${providerId}' was not in ${file}${credentialRemoved ? " (removed a stray credential)" : ""}.`,
            variant: "warning",
          })
          return
        }

        api.ui.toast({
          message: `Removed '${providerId}'${credentialRemoved ? " and its credential" : ""} from ${file}. Restart opencode to apply.`,
          variant: "success",
        })
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

        api.ui.toast({
          message: `Stored API key for '${providerId}'. Run /reload-models or restart to use it.`,
          variant: "success",
        })
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
        api.ui.toast({
          message: removed
            ? `Removed the stored key for '${providerId}'. Restart opencode to apply.`
            : `No stored key found for '${providerId}'.`,
          variant: removed ? "success" : "warning",
        })
      },
    },
  ])
}

export default { id, tui }
