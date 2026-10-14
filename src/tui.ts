import type { Plugin } from "@opencode/plugin/tui"
import { ProviderManagerRpc, type Api, type ProviderStatus, type Result } from "./rpc.js"

export const id = "opencode-provider-manager"

type Context = Plugin.Context

const GROUP = "Provider Manager"

function parseList(input: string | undefined): string[] | undefined {
  const arr = (input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return arr.length ? arr : undefined
}

function ago(time: number | undefined): string {
  if (!time) return "never"
  const seconds = Math.round((Date.now() - time) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}

const tui: Plugin.Definition["setup"] = (ctx: Context) => {
  const api = ctx.client.rpc(ProviderManagerRpc) as unknown as Api

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
    ctx.ui.toast.show({ title: "Provider Manager", message, variant })

  const report = (result: Result) => toast(result.message, result.ok ? "success" : "error")

  /** Run a command body, turning a failed RPC (e.g. the server half not loaded) into a toast. */
  const guarded = (run: () => Promise<void>) => async () => {
    try {
      await run()
    } catch (error) {
      toast(`Provider manager unavailable: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  async function pickProvider(title: string, filter?: (p: ProviderStatus) => boolean): Promise<ProviderStatus | undefined> {
    const providers = (await api.list({})).providers.filter(filter ?? (() => true))
    if (providers.length === 0) {
      toast("No providers to choose from. Add one with /pm-add-provider.", "warning")
      return undefined
    }
    return ctx.ui.dialog.select({
      title,
      options: providers.map((p) => ({
        title: p.id,
        value: p,
        description: p.baseURL,
        footer: p.disabled ? "disabled" : `${p.models} models`,
      })),
    })
  }

  async function pickModel(provider: ProviderStatus, title: string): Promise<string | undefined> {
    const { models } = await api.models({ providerId: provider.id })
    if (models.length === 0) {
      toast(`${provider.id} has no discovered models.`, "warning")
      return undefined
    }
    return ctx.ui.dialog.select({
      title,
      options: models.map((m) => ({
        title: m.name,
        value: m.id,
        description: m.name === m.id ? undefined : m.id,
        footer: `${m.context.toLocaleString()} ctx`,
      })),
    })
  }

  // "global" keeps the commands reachable from the prompt, not only the base mode.
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "pm.providers",
        title: "Providers",
        description: "Show discovered providers, their model counts, and any errors",
        group: GROUP,
        palette: true,
        slash: { name: "pm-providers" },
        run: guarded(async () => {
          const provider = await pickProvider("Providers (pick one for details)")
          if (!provider) return
          const lines = [
            `Address: ${provider.baseURL}`,
            `API key: ${provider.keySource}`,
            `Discovery: ${provider.disabled ? "disabled" : "enabled"} — ${provider.models} model(s), checked ${ago(provider.checked)}`,
            `Names: ${provider.displayStyle === "name" ? "friendly names" : "exact model IDs"}`,
          ]
          if (provider.error) lines.push(`Last error: ${provider.error}`)
          if (provider.filter?.include?.length) lines.push(`Include: ${provider.filter.include.join(", ")}`)
          if (provider.filter?.exclude?.length) lines.push(`Exclude: ${provider.filter.exclude.join(", ")}`)
          if (provider.overrides.length) lines.push(`Context overrides: ${provider.overrides.join(", ")}`)
          if (!provider.editable) lines.push("Defined outside the global opencode config — edit it where it's declared.")
          await ctx.ui.dialog.alert({ title: provider.id, message: lines.join("\n") })
        }),
      },
      {
        id: "pm.reload-models",
        title: "Reload models",
        description: "Re-discover models from every provider now",
        group: GROUP,
        palette: true,
        slash: { name: "pm-reload-models" },
        run: guarded(async () => {
          toast("Discovering models…")
          report(await api.refresh({}))
        }),
      },
      {
        id: "pm.add-provider",
        title: "Add provider",
        description: "Add an OpenAI-compatible provider whose models are discovered automatically",
        group: GROUP,
        palette: true,
        slash: { name: "pm-add-provider" },
        run: guarded(async () => {
          const providerId = (
            await ctx.ui.dialog.prompt({
              title: "Provider name",
              description: "You pick models by this name later, e.g. nous/<model>.",
              placeholder: "letters, numbers, hyphens, underscores",
            })
          )?.trim()
          if (!providerId) return

          const existing = (await api.list({})).providers.find((p) => p.id === providerId)
          let overwrite = false
          if (existing) {
            overwrite = Boolean(
              await ctx.ui.dialog.confirm({
                title: "That name is taken",
                message: `'${providerId}' already exists at ${existing.baseURL}. Point it at a new address?`,
              }),
            )
            if (!overwrite) return
          }

          const baseURL = (
            await ctx.ui.dialog.prompt({
              title: "API address",
              description: "The OpenAI-compatible endpoint, usually ending in /v1.",
              placeholder: "https://api.example.com/v1",
            })
          )?.trim()
          if (!baseURL) return

          const apiKey = await ctx.ui.dialog.prompt({
            title: "API key",
            description: "Leave blank if the endpoint needs none. Stored in opencode.jsonc; /connect keeps it in opencode's credential store instead.",
            placeholder: "optional",
          })
          if (apiKey === undefined) return

          const displayStyle = await ctx.ui.dialog.select({
            title: "How should model names appear?",
            options: [
              { title: "Exact model IDs", value: "slug" as const, description: "e.g. qwen3.6-35b-a3b-q4km" },
              { title: "Friendly names", value: "name" as const, description: "From the endpoint or models.dev, when known" },
            ],
          })
          if (!displayStyle) return

          toast(`Checking ${baseURL}…`)
          report(await api.add({ providerId, baseURL, apiKey: apiKey.trim() || undefined, displayStyle, overwrite }))
        }),
      },
      {
        id: "pm.edit-provider",
        title: "Edit provider address",
        description: "Change a provider's base URL",
        group: GROUP,
        palette: true,
        slash: { name: "pm-edit-provider" },
        run: guarded(async () => {
          const provider = await pickProvider("Edit which provider?", (p) => p.editable)
          if (!provider) return
          const baseURL = (
            await ctx.ui.dialog.prompt({ title: `New address for '${provider.id}'`, value: provider.baseURL })
          )?.trim()
          if (!baseURL || baseURL === provider.baseURL) return
          report(await api.edit({ providerId: provider.id, baseURL }))
        }),
      },
      {
        id: "pm.remove-provider",
        title: "Remove provider",
        description: "Delete a provider from the opencode config, with its plugin settings",
        group: GROUP,
        palette: true,
        slash: { name: "pm-remove-provider" },
        run: guarded(async () => {
          const provider = await pickProvider("Remove which provider?", (p) => p.editable)
          if (!provider) return
          const confirmed = await ctx.ui.dialog.confirm({
            title: "Remove this provider?",
            message: `This deletes '${provider.id}' from your opencode config. A key saved with /connect stays until you run \`opencode auth logout\`.`,
            label: { confirm: "Remove" },
          })
          if (!confirmed) return
          report(await api.remove({ providerId: provider.id }))
        }),
      },
      {
        id: "pm.toggle-provider",
        title: "Enable / disable provider",
        description: "Turn a provider's model discovery on or off without removing it",
        group: GROUP,
        palette: true,
        slash: { name: "pm-toggle-provider" },
        run: guarded(async () => {
          const provider = await pickProvider("Enable/disable which provider?")
          if (!provider) return
          report(await api.toggle({ providerId: provider.id }))
        }),
      },
      {
        id: "pm.set-model-filter",
        title: "Set model filter",
        description: "Limit which of a provider's models are listed (include/exclude patterns)",
        group: GROUP,
        palette: true,
        slash: { name: "pm-set-model-filter" },
        run: guarded(async () => {
          const provider = await pickProvider("Filter which provider's models?")
          if (!provider) return
          const include = await ctx.ui.dialog.prompt({
            title: "Only keep models matching",
            description: "Comma-separated regex or text. Blank keeps all.",
            placeholder: "e.g. coder, qwen",
            value: provider.filter?.include?.join(", "),
          })
          if (include === undefined) return
          const exclude = await ctx.ui.dialog.prompt({
            title: "Drop models matching",
            description: "Comma-separated regex or text. Blank drops none.",
            placeholder: "e.g. nothink, abliterated",
            value: provider.filter?.exclude?.join(", "),
          })
          if (exclude === undefined) return
          report(
            await api.filter({
              providerId: provider.id,
              filter: { include: parseList(include), exclude: parseList(exclude) },
            }),
          )
        }),
      },
      {
        id: "pm.override-model",
        title: "Override model context",
        description: "Set a model's context window when the endpoint and models.dev don't know it",
        group: GROUP,
        palette: true,
        slash: { name: "pm-override-model" },
        run: guarded(async () => {
          const provider = await pickProvider("Override a model on which provider?")
          if (!provider) return
          const modelId = await pickModel(provider, `Override which model on ${provider.id}?`)
          if (!modelId) return
          const detected = await api.contextHint({ providerId: provider.id, modelId })
          const CUSTOM = -1
          const CLEAR = -2
          const options: Array<{ title: string; value: number }> = []
          if (detected.endpoint)
            options.push({ title: `${detected.endpoint.toLocaleString()} (reported by endpoint)`, value: detected.endpoint })
          if (detected.modelsDev && detected.modelsDev !== detected.endpoint)
            options.push({ title: `${detected.modelsDev.toLocaleString()} (models.dev)`, value: detected.modelsDev })
          for (const preset of [8192, 16384, 32768, 65536, 131072, 262144])
            options.push({ title: preset.toLocaleString(), value: preset })
          options.push({ title: "Custom…", value: CUSTOM }, { title: "Clear override", value: CLEAR })
          const picked = await ctx.ui.dialog.select({ title: `Context window for ${modelId}`, options })
          if (picked === undefined) return
          let context: number | undefined = picked
          if (picked === CLEAR) context = undefined
          if (picked === CUSTOM) {
            const raw = await ctx.ui.dialog.prompt({ title: `Context window for ${modelId} (tokens)`, placeholder: "e.g. 131072" })
            const n = Number((raw ?? "").replace(/[_,\s]/g, ""))
            if (!raw || !Number.isFinite(n) || n <= 0) {
              toast("Not a valid number.", "error")
              return
            }
            context = Math.floor(n)
          }
          report(await api.override({ providerId: provider.id, modelId, context }))
        }),
      },
      {
        id: "pm.set-default-model",
        title: "Set default model",
        description: "Choose the model opencode uses for new sessions (writes `model` in opencode.jsonc)",
        group: GROUP,
        palette: true,
        slash: { name: "pm-set-default-model" },
        run: guarded(async () => {
          const provider = await pickProvider("Default model — pick the provider first", (p) => !p.disabled)
          if (!provider) return
          const modelId = await pickModel(provider, `Default model from ${provider.id}`)
          if (!modelId) return
          report(await api.defaultModel({ model: `${provider.id}/${modelId}` }))
        }),
      },
    ],
  }))
}

export default { id, setup: tui } satisfies Plugin.Definition
