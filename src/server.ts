import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { discoverAndEnrich, fetchEndpointModels } from "./discovery.js"
import { sanitizeErrorMessage, sanitizeUrl } from "./security.js"
import { reloadAllProviders, addProvider, validateAddProviderParams, persistProviderApiKey } from "./commands.js"
import { upsertProvider, removeProvider, removeCredential, setDefaultModel, listCredentialIds, getStoredCredential } from "./opencode-config.js"
import { getProviderSettings, setDisabled, setFilter, setModelOverride, removeProviderSettings } from "./settings.js"
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

        const settings = getProviderSettings(providerId)
        if (settings.disabled) continue

        const baseURL = providerConfig.options!.baseURL!
        const apiKey = getApiKey(providerConfig, providerId) ?? getStoredCredential(providerId)

        try {
          await client.app.log({
            body: {
              level: "info",
              message: `Discovering models from ${providerId} at ${sanitizeUrl(baseURL)}`,
              service: id,
            },
          })

          const displayStyle = providerConfig.displayStyle ?? "slug"
          const models = await discoverAndEnrich(baseURL, apiKey, displayStyle, {
            filter: settings.filter,
            overrides: settings.overrides,
          })
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

          // Intentionally NOT calling client.config.update — it writes an unloaded
          // <cwd>/config.json. Discovery re-runs on every opencode launch, so the
          // refreshed models + fresh models.dev metadata apply on the next restart.
          const lines: string[] = []
          if (result.failures === 0) {
            lines.push(
              `Re-discovered ${result.totalModels} model(s) from ${result.providerCount} provider(s); metadata cache cleared. Restart opencode to apply.`,
            )
          } else {
            lines.push(
              `Re-discovered ${result.totalModels} model(s) with ${result.failures} failure(s). Restart opencode to apply.`,
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

          // On overwrite, keep the existing provider's custom options (headers, etc.)
          // but not its baseURL (replaced) or in-config apiKey (would shadow the auth store).
          if (args.overwrite && providers[args.providerId]?.options) {
            const { apiKey: _k, baseURL: _b, ...keep } = providers[args.providerId].options as Record<string, unknown>
            result.providerEntry.options = { ...keep, ...(result.providerEntry.options ?? {}) }
          }

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
          removeProviderSettings(args.providerId)
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

      "list-providers": tool({
        description:
          "List configured providers with base URL, where the API key comes from, disabled state, " +
          "and any model filter/overrides. Does not run discovery.",
        args: {},
        async execute() {
          const { data: config } = await client.config.get()
          const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
          const ids = Object.keys(providers)
          if (ids.length === 0) return "No providers configured."
          const credentialed = new Set(listCredentialIds())
          return ids
            .map((pid) => {
              const p = providers[pid]
              const s = getProviderSettings(pid)
              const envKey = `OPENCODE_LOCAL_${pid.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
              const keySrc = p.options?.apiKey
                ? "config"
                : credentialed.has(pid)
                  ? "auth store"
                  : process.env[envKey]
                    ? "env"
                    : "none"
              const bits = [`baseURL=${p.options?.baseURL ?? "-"}`, `key=${keySrc}`]
              if (s.disabled) bits.push("DISABLED")
              if (s.filter?.include?.length) bits.push(`include=[${s.filter.include.join(",")}]`)
              if (s.filter?.exclude?.length) bits.push(`exclude=[${s.filter.exclude.join(",")}]`)
              if (s.overrides && Object.keys(s.overrides).length)
                bits.push(`overrides=${Object.keys(s.overrides).length}`)
              return `- ${pid}: ${bits.join(", ")}`
            })
            .join("\n")
        },
      }),

      "test-provider": tool({
        description:
          "Test a provider's endpoint by fetching /v1/models and reporting how many models it returns (or the error).",
        args: {
          providerId: tool.schema.string().describe("ID of the provider to test"),
        },
        async execute(args) {
          const { data: config } = await client.config.get()
          const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}
          const p = providers[args.providerId]
          if (!p?.options?.baseURL) return `Provider '${args.providerId}' not found or has no baseURL.`
          const apiKey = getApiKey(p, args.providerId) ?? getStoredCredential(args.providerId)
          try {
            const models = await fetchEndpointModels(p.options.baseURL, apiKey)
            return `OK — '${args.providerId}' returned ${models.length} model(s) from ${sanitizeUrl(p.options.baseURL)}.`
          } catch (error) {
            return `FAILED — '${args.providerId}': ${sanitizeErrorMessage(error)}`
          }
        },
      }),

      "set-default-model": tool({
        description: "Set opencode's default model (the `model` field) to a 'providerID/modelID' reference.",
        args: {
          model: tool.schema
            .string()
            .describe("Default model as 'providerID/modelID', e.g. nous/qwen3-coder-next-q4"),
        },
        async execute(args) {
          const file = setDefaultModel(args.model)
          return `Set default model to '${args.model}' in ${file}. Restart opencode to apply.`
        },
      }),

      "toggle-provider": tool({
        description: "Enable or disable a provider's model discovery without removing it.",
        args: {
          providerId: tool.schema.string().describe("ID of the provider"),
          disabled: tool.schema.boolean().describe("true to disable discovery, false to enable"),
        },
        async execute(args) {
          setDisabled(args.providerId, args.disabled)
          return `Provider '${args.providerId}' ${args.disabled ? "disabled" : "enabled"}. Restart opencode to apply.`
        },
      }),

      "set-model-filter": tool({
        description:
          "Restrict which of a provider's models are discovered, via include/exclude patterns " +
          "(case-insensitive regex). Omit both to clear the filter.",
        args: {
          providerId: tool.schema.string().describe("ID of the provider"),
          include: tool.schema
            .string()
            .array()
            .optional()
            .describe("Only keep models whose id matches one of these patterns"),
          exclude: tool.schema
            .string()
            .array()
            .optional()
            .describe("Drop models whose id matches one of these patterns"),
        },
        async execute(args) {
          const filter =
            args.include?.length || args.exclude?.length
              ? { include: args.include, exclude: args.exclude }
              : undefined
          setFilter(args.providerId, filter)
          return filter
            ? `Filter set for '${args.providerId}'. Restart opencode to apply.`
            : `Filter cleared for '${args.providerId}'. Restart opencode to apply.`
        },
      }),

      "override-model": tool({
        description:
          "Override a model's metadata (context window and/or max output tokens) for a provider — " +
          "useful when models.dev doesn't know a self-hosted model. Omit both to clear the override.",
        args: {
          providerId: tool.schema.string().describe("ID of the provider"),
          modelId: tool.schema.string().describe("The model id as it appears in the provider, e.g. qwen3.6-35b"),
          context: tool.schema.number().optional().describe("Context window in tokens"),
          output: tool.schema.number().optional().describe("Max output tokens"),
        },
        async execute(args) {
          const clearing = args.context === undefined && args.output === undefined
          // Only pass the fields the caller specified, so a partial call (e.g. output
          // only) doesn't clobber a previously-set context. Both omitted => clear.
          setModelOverride(args.providerId, args.modelId, {
            ...(args.context !== undefined ? { context: args.context } : {}),
            ...(args.output !== undefined ? { output: args.output } : {}),
            ...(clearing ? { context: undefined, output: undefined } : {}),
          })
          return clearing
            ? `Cleared override for '${args.providerId}/${args.modelId}'. Restart opencode to apply.`
            : `Override set for '${args.providerId}/${args.modelId}'. Restart opencode to apply.`
        },
      }),
    },
  }
}

export default { id, server }
