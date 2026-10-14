import { test, after } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Point the writer at a throwaway file via the same env var opencode honors, so
// the test never touches the real user config.
const CONFIG = path.join(os.tmpdir(), `opm-config-test-${process.pid}.jsonc`)
process.env.OPENCODE_CONFIG = CONFIG

const { upsertProvider, removeProvider, setProviderBaseURL, setDefaultModel, hasProvider } = await import(
  "../dist/opencode-config.js"
)

const SEED = `{
  // a hand-written comment the user cares about
  "provider": {
    "nous": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://x/v1" } }
  }
}
`

test("upsertProvider adds a legacy-style provider with no models block, preserving comments", () => {
  fs.writeFileSync(CONFIG, SEED)
  assert.equal(upsertProvider("myproxy", { name: "myproxy", baseURL: "https://api.example.com/v1" }), CONFIG)
  const text = fs.readFileSync(CONFIG, "utf8")
  assert.match(text, /a hand-written comment/, "comment preserved")
  assert.match(text, /"myproxy"/, "new provider written")
  assert.match(text, /"npm": "@ai-sdk\/openai-compatible"/, "legacy shape")
  assert.match(text, /"nous"/, "existing provider left intact")
  assert.doesNotMatch(text, /"models"/, "no frozen models block")
  assert.equal(hasProvider("myproxy"), true)
})

test("upsertProvider on an existing provider edits only its address and key", () => {
  fs.writeFileSync(
    CONFIG,
    `{ "provider": { "p": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://old/v1", "headers": { "X": "1" } } } } }`,
  )
  upsertProvider("p", { name: "p", baseURL: "https://new/v1", apiKey: "k" })
  const parsed = JSON.parse(fs.readFileSync(CONFIG, "utf8"))
  assert.deepEqual(parsed.provider.p.options, { baseURL: "https://new/v1", headers: { X: "1" }, apiKey: "k" })
})

test("upsertProvider writes the native shape into a native-style file", () => {
  fs.writeFileSync(CONFIG, `{ "providers": {} }`)
  upsertProvider("n", { name: "n", baseURL: "https://n/v1" })
  const parsed = JSON.parse(fs.readFileSync(CONFIG, "utf8"))
  assert.deepEqual(parsed.providers.n, {
    name: "n",
    package: "aisdk:@ai-sdk/openai-compatible",
    settings: { baseURL: "https://n/v1" },
  })
})

test("removeProvider removes only the target, from either section", () => {
  fs.writeFileSync(CONFIG, SEED)
  upsertProvider("myproxy", { name: "myproxy", baseURL: "https://api.example.com/v1" })
  assert.equal(removeProvider("myproxy").existed, true)
  const text = fs.readFileSync(CONFIG, "utf8")
  assert.doesNotMatch(text, /"myproxy"/)
  assert.match(text, /a hand-written comment/)
  assert.match(text, /"nous"/)
  assert.equal(removeProvider("ghost").existed, false)
})

test("setProviderBaseURL updates only the base URL, and refuses unknown providers", () => {
  fs.writeFileSync(CONFIG, SEED)
  assert.equal(setProviderBaseURL("nous", "https://new/v1"), CONFIG)
  const text = fs.readFileSync(CONFIG, "utf8")
  assert.match(text, /new\/v1/)
  assert.doesNotMatch(text, /x\/v1/)
  assert.doesNotMatch(text, /"models"/)
  assert.equal(setProviderBaseURL("ghost", "https://new/v1"), undefined)
})

test("setDefaultModel writes the model reference", () => {
  fs.writeFileSync(CONFIG, SEED)
  setDefaultModel("nous/qwen3.8-27b-q4kxl")
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, "utf8").replace(/\/\/.*\n/, "")).model, "nous/qwen3.8-27b-q4kxl")
})

after(() => {
  fs.rmSync(CONFIG, { force: true })
})

test("add and remove keep an existing enabled_providers allow-list in step", () => {
  fs.writeFileSync(CONFIG, `{ "provider": {}, "enabled_providers": ["nous"] }`)
  upsertProvider("local", { name: "local", baseURL: "http://127.0.0.1:8000/v1" })
  upsertProvider("local", { name: "local", baseURL: "http://127.0.0.1:8001/v1" })
  assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG, "utf8")).enabled_providers, ["nous", "local"])
  removeProvider("local")
  assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG, "utf8")).enabled_providers, ["nous"])
})

test("without an enabled_providers list, none is created", () => {
  fs.writeFileSync(CONFIG, `{ "provider": {} }`)
  upsertProvider("local", { name: "local", baseURL: "http://127.0.0.1:8000/v1" })
  assert.equal("enabled_providers" in JSON.parse(fs.readFileSync(CONFIG, "utf8")), false)
})
