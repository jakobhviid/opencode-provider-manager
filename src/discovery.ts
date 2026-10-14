import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { isValidUrl, sanitizeModelId, sanitizeErrorMessage } from "./security.js"

const MODELS_DEV_URL = "https://models.dev/api.json"
const CACHE_DIR = path.join(os.homedir() || "/tmp", ".cache", "opencode-provider-manager")
const CACHE_FILE = path.join(CACHE_DIR, "models-dev.json")
const CACHE_TTL = 6 * 60 * 60 * 1000 // 6 hours

// ── models.dev types (the subset this plugin reads) ──

interface ModelsDevModel {
  id: string
  name: string
  family?: string
  attachment: boolean
  reasoning: boolean
  tool_call: boolean
  limit: {
    context: number
    input?: number
    output: number
  }
  modalities?: {
    input: string[]
    output: string[]
  }
}

interface ModelsDevProvider {
  models: Record<string, ModelsDevModel>
}

// ── models.dev cache + lookup ──

// Module-level singleton: built once per process on first access, then shared
// by every provider. clearModelsDevCache() forces the next lookup to refetch.
let lookupMap: Map<string, ModelsDevModel> | null = null
let lookupPromise: Promise<Map<string, ModelsDevModel>> | null = null
let forceRefresh = false

export function normalizeModelId(id: string): string {
  let normalized = id.toLowerCase()
  if (normalized.startsWith("models/")) {
    normalized = normalized.slice(7)
  }
  const slashIndex = normalized.lastIndexOf("/")
  if (slashIndex !== -1) {
    normalized = normalized.slice(slashIndex + 1)
  }
  return normalized.replaceAll(":", "-")
}

interface CacheEntry {
  timestamp: number
  data: Record<string, ModelsDevProvider>
}

function readCacheEntry(): CacheEntry | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as CacheEntry
  } catch {
    return null
  }
}

function writeCache(data: Record<string, ModelsDevProvider>): void {
  try {
    fs.mkdirSync(CACHE_DIR, { mode: 0o700, recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), data }), { mode: 0o600 })
  } catch {
    // ignore write errors
  }
}

async function fetchModelsDevCatalog(): Promise<Record<string, ModelsDevProvider>> {
  const entry = readCacheEntry()
  const isFresh = !forceRefresh && entry && Date.now() - entry.timestamp <= CACHE_TTL
  forceRefresh = false
  if (isFresh && entry) return entry.data

  try {
    const res = await fetch(MODELS_DEV_URL, {
      headers: { "User-Agent": "opencode-provider-manager" },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = (await res.json()) as Record<string, ModelsDevProvider>
      writeCache(data)
      return data
    }
  } catch {
    // Ignore fetch error, fall back to stale cache if available
  }

  return entry?.data ?? {}
}

function buildLookupMap(catalog: Record<string, ModelsDevProvider>): Map<string, ModelsDevModel> {
  const map = new Map<string, ModelsDevModel>()
  for (const provider of Object.values(catalog)) {
    if (!provider.models) continue
    for (const model of Object.values(provider.models)) {
      const key = normalizeModelId(model.id)
      if (!map.has(key)) {
        map.set(key, model)
      }
    }
  }
  return map
}

async function getLookupMap(): Promise<Map<string, ModelsDevModel>> {
  if (lookupMap) return lookupMap
  if (!lookupPromise) {
    lookupPromise = fetchModelsDevCatalog().then((catalog) => {
      lookupMap = buildLookupMap(catalog)
      return lookupMap
    })
  }
  return lookupPromise
}

export function clearModelsDevCache(): void {
  lookupMap = null
  lookupPromise = null
  // Bypass the freshness check once, but keep the disk cache as an offline fallback.
  forceRefresh = true
}

// ── endpoint model response ──

// OpenAI's Model object only guarantees `id`; everything else here is the
// OpenRouter / llama-swap / vLLM convention, read when present.
export interface EndpointModel {
  id: string
  name?: string
  owned_by?: string
  context_length?: number
  context_window?: number
  max_model_len?: number
  max_completion_tokens?: number
  max_output_tokens?: number
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  capabilities?: Record<string, unknown>
  supported_parameters?: string[]
  meta?: {
    llamaswap?: {
      pipeline_tag?: string
      family?: string
    }
  }
}

export async function fetchEndpointModels(baseURL: string, apiKey?: string): Promise<EndpointModel[]> {
  if (!isValidUrl(baseURL)) return []

  const url = new URL(baseURL)
  const cleanPath = url.pathname.replace(/\/+$/, "")
  const modelsPath = cleanPath.endsWith("/models") ? cleanPath : `${cleanPath}/models`
  const modelsUrl = new URL(modelsPath, url.origin)
  modelsUrl.search = url.search

  const headers: Record<string, string> = { Accept: "application/json" }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  const res = await fetch(modelsUrl.toString(), {
    headers,
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.text()
      if (body) detail = sanitizeErrorMessage(body.slice(0, 500))
    } catch {
      /* ignore read errors */
    }
    throw new Error(`HTTP ${res.status}: ${detail}`)
  }

  const rawData = await res.json()
  const data = Array.isArray(rawData) ? rawData : Array.isArray(rawData?.data) ? rawData.data : null

  if (!data) {
    throw new Error("Unexpected response format from /v1/models")
  }

  return data.filter((item: Record<string, unknown>) => typeof item?.id === "string")
}

// ── classification ──

// Hugging Face pipeline tags that are chat models. Everything else an endpoint
// tags (embeddings, rerankers, TTS/STT, image generation) can't hold a conversation.
const CHAT_PIPELINES = new Set(["text-generation", "image-text-to-text"])
const NON_CHAT_CAPABILITIES = [
  "embedding",
  "embeddings",
  "reranker",
  "rerank",
  "image_generation",
  "image_to_image",
  "audio_transcriptions",
  "audio_speech",
  "text_to_speech",
]

/** Whether an endpoint entry is a chat model, judged from the metadata it reports. Unannotated entries count as chat. */
export function isChatModel(item: EndpointModel): boolean {
  const pipeline = item.meta?.llamaswap?.pipeline_tag
  if (pipeline) return CHAT_PIPELINES.has(pipeline)
  if (NON_CHAT_CAPABILITIES.some((name) => item.capabilities?.[name] === true)) return false
  const output = item.architecture?.output_modalities
  if (output && !output.includes("text")) return false
  return true
}

// ── enrichment: merge endpoint data with models.dev ──

export type DisplayStyle = "name" | "slug"

/** A discovered model in the shape the server plugin writes into opencode's model catalog. */
export interface DiscoveredModel {
  id: string
  name: string
  family?: string
  tools: boolean
  vision: boolean
  context: number
  output: number
}

export interface ModelFilter {
  include?: string[]
  exclude?: string[]
}

export interface ModelOverride {
  context?: number
  output?: number
}

/** Whether a model id survives an include/exclude filter (case-insensitive regex, substring fallback). */
export function modelPassesFilter(id: string, filter?: ModelFilter): boolean {
  if (!filter) return true
  const matches = (patterns: string[] | undefined) =>
    (patterns ?? []).some((p) => {
      try {
        return new RegExp(p, "i").test(id)
      } catch {
        return id.toLowerCase().includes(p.toLowerCase())
      }
    })
  if (filter.include && filter.include.length > 0 && !matches(filter.include)) return false
  if (filter.exclude && filter.exclude.length > 0 && matches(filter.exclude)) return false
  return true
}

export function endpointContextWindow(item: EndpointModel): number | undefined {
  const v = item.context_length ?? item.context_window ?? item.max_model_len
  return typeof v === "number" && v > 0 ? v : undefined
}

function endpointMaxOutput(item: EndpointModel): number | undefined {
  const v = item.max_completion_tokens ?? item.max_output_tokens
  return typeof v === "number" && v > 0 ? v : undefined
}

/** Whether the entry describes itself beyond the bare OpenAI fields, so an absent capability means "no". */
function selfDescribing(item: EndpointModel): boolean {
  return Boolean(item.architecture || item.capabilities || item.supported_parameters || item.meta)
}

function endpointTools(item: EndpointModel): boolean {
  return (
    item.capabilities?.function_calling === true ||
    item.capabilities?.tool_choice === true ||
    item.capabilities?.tools === true ||
    Boolean(item.supported_parameters?.includes("tools"))
  )
}

function endpointVision(item: EndpointModel): boolean {
  return item.capabilities?.vision === true || Boolean(item.architecture?.input_modalities?.includes("image"))
}

const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 32_000

/**
 * Enrich a provider's raw /models entries into catalog models: chat models only,
 * endpoint-reported values first, then models.dev, then defaults. Filter and
 * overrides come from the plugin's per-provider settings.
 */
export async function enrichModels(
  raw: readonly EndpointModel[],
  options: { displayStyle?: DisplayStyle; filter?: ModelFilter; overrides?: Record<string, ModelOverride> } = {},
): Promise<DiscoveredModel[]> {
  const lookup = await getLookupMap()
  const seen = new Set<string>()
  const result: DiscoveredModel[] = []

  for (const item of raw) {
    if (!isChatModel(item)) continue
    const id = sanitizeModelId(item.id)
    if (seen.has(id) || !modelPassesFilter(id, options.filter)) continue
    seen.add(id)
    const meta = lookup.get(normalizeModelId(id))

    const name =
      options.displayStyle === "name"
        ? ((item.name && item.name !== item.id ? item.name : undefined) ?? meta?.name ?? id)
        : id

    const context = endpointContextWindow(item) ?? meta?.limit.context ?? DEFAULT_CONTEXT
    const output = endpointMaxOutput(item) ?? meta?.limit.output ?? Math.min(DEFAULT_OUTPUT, Math.floor(context / 2))

    const model: DiscoveredModel = {
      id,
      name,
      family: item.meta?.llamaswap?.family ?? meta?.family,
      // A self-describing endpoint (llama-swap, OpenRouter) omits tools when the
      // model has none; a bare one (oMLX, plain vLLM) says nothing, so fall back
      // to models.dev and then to opencode's own default of tools on.
      tools: selfDescribing(item) ? endpointTools(item) : (meta?.tool_call ?? true),
      vision: endpointVision(item) || Boolean(meta?.attachment && meta.modalities?.input.includes("image")),
      context,
      output,
    }

    const override = options.overrides?.[id]
    if (typeof override?.context === "number") model.context = override.context
    if (typeof override?.output === "number") model.output = override.output

    result.push(model)
  }

  return result.sort((a, b) => a.id.localeCompare(b.id))
}

/** What models.dev knows about a model's context window, if anything. */
export async function modelsDevContextWindow(modelId: string): Promise<number | undefined> {
  try {
    return (await getLookupMap()).get(normalizeModelId(modelId))?.limit.context
  } catch {
    return undefined
  }
}
