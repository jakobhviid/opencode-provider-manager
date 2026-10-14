import type { DisplayStyle, ModelFilter } from "./discovery.js"

// The contract between the TUI half (dialogs) and the server half (discovery,
// config writes). Every method takes and returns a JSON object; failures come
// back as `{ ok: false, message }` so the TUI can show the reason.

const object = { type: "object" } as const
const method = { input: object, output: object } as const

export const ProviderManagerRpc = {
  id: "opencode-provider-manager",
  methods: {
    list: method,
    refresh: method,
    add: method,
    edit: method,
    remove: method,
    models: method,
    toggle: method,
    filter: method,
    override: method,
    contextHint: method,
    defaultModel: method,
  },
  events: {},
} as const

export type Result = { ok: true; message: string } | { ok: false; message: string }

export type KeySource = "config" | "env" | "connection" | "none"

export interface ProviderStatus {
  id: string
  name: string
  baseURL: string
  keySource: KeySource
  /** Defined in the global opencode config, so the plugin can edit or remove it. */
  editable: boolean
  disabled: boolean
  displayStyle: DisplayStyle
  filter?: ModelFilter
  overrides: string[]
  models: number
  checked?: number
  error?: string
}

export interface ModelSummary {
  id: string
  name: string
  context: number
}

export interface Api {
  list(input: Record<string, never>): Promise<{ providers: ProviderStatus[] }>
  refresh(input: Record<string, never>): Promise<Result>
  add(input: { providerId: string; baseURL: string; apiKey?: string; displayStyle: DisplayStyle; overwrite: boolean }): Promise<Result>
  edit(input: { providerId: string; baseURL: string }): Promise<Result>
  remove(input: { providerId: string }): Promise<Result>
  models(input: { providerId: string }): Promise<{ models: ModelSummary[] }>
  toggle(input: { providerId: string }): Promise<Result>
  filter(input: { providerId: string; filter?: ModelFilter }): Promise<Result>
  override(input: { providerId: string; modelId: string; context?: number }): Promise<Result>
  contextHint(input: { providerId: string; modelId: string }): Promise<{ endpoint?: number; modelsDev?: number }>
  defaultModel(input: { model: string }): Promise<Result>
}
