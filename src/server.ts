import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { discoverAndEnrich } from "./discovery.js"
import { sanitizeErrorMessage, sanitizeUrl } from "./security.js"
import { reloadAllProviders, addProvider, validateAddProviderParams, persistProviderApiKey } from "./commands.js"
import { upsertProvider, removeProvider, removeCredential } from "./opencode-config.js"
import { shouldDiscover, getApiKey, type ProviderConfig, type OpenCodeConfig } from "./types.js"

export const id = "opencode-provider-manager"

export type { ProviderConfig, OpenCodeConfig } from "./types.js"
export { getApiKey } from "./types.js"

export const server: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      level: "info",
      message: "Plugin initialized",
      service: id,
    },
  })

  return {
    config: async (cfg: OpenCodeConfig) => {
      if (!cfg.provider) return

      for (const [providerId, providerConfig] of Object.entries(cfg.provider)) {
        if (!shouldDiscover(providerConfig)) continue

        const baseURL = providerConfig.options!.baseURL!
        const apiKey = getApiKey(providerConfig, providerId)

        try {
          await client.app.log({
            body: {
              level: "info",
              message: `Discovering models from ${providerId} at ${sanitizeUrl(baseURL)}`,
              service: id,
            },
          })

          const displayStyle = providerConfig.displayStyle ?? "slug"
          const models = await discoverAndEnrich(baseURL, apiKey, displayStyle)
          const count = Object.keys(models).length

          if (count === 0) {
            await client.app.log({
              body: {
                level: "warn",
                message: `No models discovered from ${providerId}`,
                service: id,
              },
            })
            continue
          }

          providerConfig.models = { ...(providerConfig.models as Record<string, unknown> ?? {}), ...models }
          providerConfig.npm = providerConfig.npm ?? "@ai-sdk/openai-compatible"
          providerConfig.api = providerConfig.api ?? baseURL

          await client.app.log({
            body: {
              level: "info",
              message: `Discovered ${count} model(s) from ${providerId}`,
              service: id,
            },
          })
        } catch (error) {
          await client.app.log({
            body: {
              level: "warn",
              message: `Failed to discover models from ${providerId}: ${sanitizeErrorMessage(error)}`,
              service: id,
            },
          })
        }
      }
    },

    tool: {
      "refresh-models": tool({
        description:
          "Re-discover models from all dynamic providers and update the live config. " +
          "Clears the models.dev metadata cache, fetches /models from every provider " +
          "with a baseURL, enriches them, and persists the updated config.",
        args: {},
        async execute() {
          const { data: config } = await client.config.get()
          const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}

          const result = await reloadAllProviders(providers)

          if (result.providerCount === 0) {
            return "No dynamic providers configured. Add a provider with a baseURL first."
          }

          if (result.totalModels > 0) {
            await client.config.update({
              body: { provider: providers } as never,
            })
          }

          const lines: string[] = []
          if (result.failures === 0) {
            lines.push(
              `Reloaded ${result.totalModels} model(s) from ${result.providerCount} provider(s).`,
            )
          } else {
            lines.push(
              `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s).`,
            )
          }
          for (const w of result.warnings) lines.push(`Warning: ${w}`)
          for (const e of result.errors) lines.push(`Error: ${e}`)

          return lines.join("\n")
        },
      }),

      "add-provider": tool({
        description:
          "Add a new OpenAI-compatible provider with dynamic model discovery. " +
          "Validates the endpoint, discovers available models, enriches them with " +
          "models.dev metadata, and persists the provider to the config.",
        args: {
          providerId: tool.schema
            .string()
            .describe("Unique provider ID (alphanumeric, hyphens, underscores only)"),
          baseURL: tool.schema
            .string()
            .describe("Base URL of the OpenAI-compatible API endpoint (e.g. https://api.example.com/v1)"),
          apiKey: tool.schema
            .string()
            .optional()
            .describe("API key for authentication (optional)"),
          displayStyle: tool.schema
            .enum(["slug", "name"])
            .optional()
            .describe("How to display model names: 'slug' for full ID (default), 'name' for friendly name"),
          overwrite: tool.schema
            .boolean()
            .optional()
            .describe("Overwrite if a provider with this ID already exists (default: false)"),
        },
        async execute(args) {
          const { data: config } = await client.config.get()
          const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}

          const validationError = validateAddProviderParams(args, providers)
          if (validationError) return validationError

          const result = await addProvider(args)
          if (!result.success || !result.providerEntry) return result.message

          await persistProviderApiKey(
            result.providerEntry,
            args.providerId,
            args.apiKey,
            async (id, key) => {
              await client.auth.set({ path: { id }, body: { type: "api", key } })
              return true
            },
          )

          // Persist to the global config file opencode actually loads. (Works
          // around client.config.update writing an unloaded <cwd>/config.json.)
          const configFile = upsertProvider(args.providerId, result.providerEntry)

          return `${result.message} Persisted to ${configFile}. Restart opencode to use it.`
        },
      }),

      "remove-provider": tool({
        description:
          "Remove a custom provider from the opencode config and delete its stored credential.",
        args: {
          providerId: tool.schema.string().describe("ID of the provider to remove"),
        },
        async execute(args) {
          const { file, existed } = removeProvider(args.providerId)
          const credentialRemoved = removeCredential(args.providerId)
          if (!existed) {
            return (
              `Provider '${args.providerId}' not found in ${file}.` +
              (credentialRemoved ? " Removed a stray credential." : "")
            )
          }
          return (
            `Removed provider '${args.providerId}'` +
            (credentialRemoved ? " and its stored credential" : "") +
            ` from ${file}. Restart opencode to apply.`
          )
        },
      }),

      "add-provider-auth": tool({
        description:
          "Set (or replace) the API key for an existing provider. Stores the key in opencode's auth store.",
        args: {
          providerId: tool.schema.string().describe("ID of an existing provider"),
          apiKey: tool.schema.string().describe("API key to store for the provider"),
        },
        async execute(args) {
          try {
            await client.auth.set({ path: { id: args.providerId }, body: { type: "api", key: args.apiKey } })
          } catch (error) {
            return `Failed to store the API key for '${args.providerId}': ${sanitizeErrorMessage(error)}`
          }
          return `Stored API key for '${args.providerId}'. Run refresh-models or restart to use it.`
        },
      }),

      "remove-provider-auth": tool({
        description:
          "Delete the stored API key for a provider without removing the provider itself.",
        args: {
          providerId: tool.schema.string().describe("ID of the provider whose stored key should be removed"),
        },
        async execute(args) {
          const removed = removeCredential(args.providerId)
          return removed
            ? `Removed the stored API key for '${args.providerId}'. Restart opencode to apply.`
            : `No stored API key found for '${args.providerId}'.`
        },
      }),
    },
  }
}

export default { id, server }
