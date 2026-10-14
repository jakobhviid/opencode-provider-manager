import { test } from "node:test"
import assert from "node:assert"
import { normalizeModelId, isChatModel, modelPassesFilter } from "../dist/discovery.js"

test("normalizeModelId strips models/ prefix and org prefixes", () => {
  assert.strictEqual(normalizeModelId("gpt-4o"), "gpt-4o")
  assert.strictEqual(normalizeModelId("models/gemini-2.5-flash"), "gemini-2.5-flash")
  assert.strictEqual(normalizeModelId("meta-llama/llama-3-8b"), "llama-3-8b")
  assert.strictEqual(normalizeModelId("openai/gpt-4o-mini"), "gpt-4o-mini")
})

test("normalizeModelId maps colons to hyphens", () => {
  assert.strictEqual(normalizeModelId("deepseek-ai/deepseek-coder:6.7b"), "deepseek-coder-6.7b")
})

test("isChatModel trusts the pipeline tag, both chat tags included", () => {
  const tag = (pipeline_tag) => ({ id: "m", meta: { llamaswap: { pipeline_tag } } })
  assert.strictEqual(isChatModel(tag("text-generation")), true)
  assert.strictEqual(isChatModel(tag("image-text-to-text")), true)
  assert.strictEqual(isChatModel(tag("feature-extraction")), false)
  assert.strictEqual(isChatModel(tag("text-ranking")), false)
  assert.strictEqual(isChatModel(tag("text-to-speech")), false)
})

test("isChatModel drops non-chat capabilities and non-text output, keeps bare entries", () => {
  assert.strictEqual(isChatModel({ id: "m", capabilities: { image_generation: true } }), false)
  assert.strictEqual(isChatModel({ id: "m", architecture: { output_modalities: ["image"] } }), false)
  assert.strictEqual(isChatModel({ id: "m", object: "model", owned_by: "omlx" }), true)
})

test("modelPassesFilter applies include then exclude", () => {
  const filter = { include: ["qwen"], exclude: ["nothink"] }
  assert.strictEqual(modelPassesFilter("qwen3.8-27b", filter), true)
  assert.strictEqual(modelPassesFilter("qwen3.8-27b-nothink", filter), false)
  assert.strictEqual(modelPassesFilter("gemma-4", filter), false)
  assert.strictEqual(modelPassesFilter("anything", undefined), true)
})
