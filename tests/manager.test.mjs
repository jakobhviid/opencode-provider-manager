import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Isolate the settings store in a throwaway XDG config dir.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "opm-cfg-"))

const settings = await import("../dist/settings.js")
const { modelPassesFilter } = await import("../dist/discovery.js")

test("settings: disabled toggles and prunes when empty", () => {
  assert.deepEqual(settings.getProviderSettings("p"), {})
  settings.setDisabled("p", true)
  assert.equal(settings.getProviderSettings("p").disabled, true)
  settings.setDisabled("p", false)
  assert.deepEqual(settings.getProviderSettings("p"), {}) // pruned
})

test("settings: filter set and clear", () => {
  settings.setFilter("p", { include: ["coder"], exclude: ["embed"] })
  assert.deepEqual(settings.getProviderSettings("p").filter, { include: ["coder"], exclude: ["embed"] })
  settings.setFilter("p", undefined)
  assert.deepEqual(settings.getProviderSettings("p"), {})
})

test("settings: model override merges then removes when emptied", () => {
  settings.setModelOverride("p", "m1", { context: 32768 })
  assert.equal(settings.getProviderSettings("p").overrides.m1.context, 32768)
  settings.setModelOverride("p", "m1", { output: 4096 })
  assert.deepEqual(settings.getProviderSettings("p").overrides.m1, { context: 32768, output: 4096 })
  settings.setModelOverride("p", "m1", { context: undefined, output: undefined })
  assert.deepEqual(settings.getProviderSettings("p"), {})
})

test("settings: removeProviderSettings clears everything", () => {
  settings.setDisabled("p2", true)
  settings.removeProviderSettings("p2")
  assert.deepEqual(settings.getProviderSettings("p2"), {})
})

test("settings: auto-reload defaults on and toggles", () => {
  assert.equal(settings.getAutoReload(), true) // default on
  settings.setAutoReload(false)
  assert.equal(settings.getAutoReload(), false)
  settings.setAutoReload(true)
  assert.equal(settings.getAutoReload(), true)
})

test("modelPassesFilter: include, exclude, regex and bad-regex fallback", () => {
  assert.equal(modelPassesFilter("qwen3-coder", undefined), true)
  assert.equal(modelPassesFilter("qwen3-coder", { include: ["coder"] }), true)
  assert.equal(modelPassesFilter("gemma", { include: ["coder"] }), false)
  assert.equal(modelPassesFilter("text-embed-3", { exclude: ["embed"] }), false)
  assert.equal(modelPassesFilter("qwen", { include: ["^qw"] }), true) // regex
  assert.equal(modelPassesFilter("qwen", { include: ["[invalid"] }), false) // bad regex -> substring, no match
})
