import { test, after } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Point the writer at throwaway locations via the same env vars opencode honors,
// so the test never touches the real user config or auth store.
const CONFIG = path.join(os.tmpdir(), `dcp-config-test-${process.pid}.jsonc`)
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-data-test-"))
process.env.OPENCODE_CONFIG = CONFIG
process.env.XDG_DATA_HOME = DATA

const { upsertProvider, removeProvider, removeCredential, setProviderBaseURL } = await import(
  "../dist/opencode-config.js"
)

const SEED = `{
  // a hand-written comment the user cares about
  "provider": {
    "nous": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://x/v1" } }
  }
}
`

test("upsertProvider adds a provider and preserves comments", () => {
  fs.writeFileSync(CONFIG, SEED)
  const file = upsertProvider("myproxy", {
    name: "myproxy",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://api.example.com/v1" },
    dynamic: true,
    displayStyle: "slug",
  })
  assert.equal(file, CONFIG)
  const text = fs.readFileSync(CONFIG, "utf8")
  assert.match(text, /a hand-written comment/, "comment preserved")
  assert.match(text, /"myproxy"/, "new provider written")
  assert.match(text, /"nous"/, "existing provider left intact")
  assert.match(text, /api\.example\.com/, "baseURL written")
})

test("removeProvider removes only the target, keeping comments and siblings", () => {
  const { existed } = removeProvider("myproxy")
  assert.equal(existed, true)
  const text = fs.readFileSync(CONFIG, "utf8")
  assert.doesNotMatch(text, /"myproxy"/)
  assert.match(text, /a hand-written comment/)
  assert.match(text, /"nous"/)
})

test("removeProvider reports a missing provider", () => {
  assert.equal(removeProvider("ghost").existed, false)
})

test("removeCredential deletes only the specified provider's credential", () => {
  const authFile = path.join(DATA, "opencode", "auth.json")
  fs.mkdirSync(path.dirname(authFile), { recursive: true })
  fs.writeFileSync(
    authFile,
    JSON.stringify({ keep: { type: "api", key: "a" }, drop: { type: "api", key: "b" } }),
  )
  assert.equal(removeCredential("drop"), true)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(authFile, "utf8"))), ["keep"])
  // A credential that isn't in the store (e.g. supplied via {env:...} or shared)
  // is a no-op — never touches other providers' credentials.
  assert.equal(removeCredential("not-there"), false)
})

test("setProviderBaseURL updates only the base URL and never freezes a models block", () => {
  fs.writeFileSync(
    CONFIG,
    `{
  "provider": {
    "p": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://old/v1" } }
  }
}
`,
  )
  const file = setProviderBaseURL("p", "https://new/v1")
  assert.equal(file, CONFIG)
  const text = fs.readFileSync(CONFIG, "utf8")
  assert.match(text, /new\/v1/, "new URL written")
  assert.doesNotMatch(text, /old\/v1/, "old URL replaced")
  assert.doesNotMatch(text, /"models"/, "must NOT introduce a hardcoded models block")
})

after(() => {
  fs.rmSync(CONFIG, { force: true })
  fs.rmSync(DATA, { recursive: true, force: true })
})
