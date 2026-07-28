# OpenCode Provider Manager

A standalone [opencode](https://opencode.ai) plugin for OpenAI-compatible providers. **Add, remove, edit, and test providers; manage their API keys; enable/disable, filter, or override their models; and set your default model** — all from the TUI or via agent tools. Models are discovered automatically and enriched with [models.dev](https://models.dev) metadata.

> **Fork notice.** This is a fork of [b3nw/opencode-dynamic-custom-providers](https://github.com/b3nw/opencode-dynamic-custom-providers) (full credit in [Credits](#credits)). It fixes provider persistence so providers added through the UI survive a restart, and adds provider- and key-management commands. **Install it from this repository — not the upstream npm package,** which does not include these changes.

## Commands

| Command (TUI) | Agent tool | What it does |
| --- | --- | --- |
| `/add-provider` | `add-provider` | Add a new OpenAI-compatible provider (validates the endpoint, discovers models) |
| `/edit-provider` | — | Change an existing provider's base URL |
| `/remove-provider` | `remove-provider` | Remove a provider and delete its stored credential + settings |
| `/providers` | `list-providers` | Show providers with base URL, key source, disabled state, filters/overrides |
| `/test-provider` | `test-provider` | Check that a provider's endpoint responds and report its model count |
| `/toggle-provider` | `toggle-provider` | Enable/disable a provider's discovery without removing it |
| `/add-provider-auth` | `add-provider-auth` | Set (or replace) the API key for an existing provider |
| `/remove-provider-auth` | `remove-provider-auth` | Delete a provider's stored key (keeps the provider) |
| `/set-default-model` | `set-default-model` | Choose opencode's default model (writes the `model` field) |
| `/set-model-filter` | `set-model-filter` | Include/exclude patterns for which models a provider discovers |
| `/override-model` | `override-model` | Override a model's context window / output when models.dev doesn't know it |
| `/reload-models` (`/refresh-models`) | `refresh-models` | Re-discover all providers' models |
| `/toggle-auto-reload` | — | Turn automatic reload-after-changes on/off (default: on) |

## How model discovery works

- On startup, the plugin's `config` hook fetches `/v1/models` from every provider that has a `baseURL` and no explicit `models` list (or has `dynamic: true`).
- Each discovered model is cross-referenced against the [models.dev](https://models.dev) catalog for context windows, output limits, costs, and capabilities (tool calling, reasoning, modalities).
- Models are injected into the live config before opencode loads providers, so your model list stays current without hand-maintaining it.

## Installation

Two ways to install. **Homebrew is recommended** — one line, and `brew upgrade` keeps the plugin current. If you don't use Homebrew, install from a Git clone.

### Homebrew (macOS / Linux) — recommended

```bash
brew install jakobhviid/tap/opencode-provider-manager
opencode-provider-manager setup      # wire the plugin into opencode's config
```

Homebrew installs `opencode` first (the formula depends on it), then the plugin. Restart opencode and you're done. `setup` (alias `install`) is idempotent: it adds the plugin to your `opencode.jsonc` **and** `tui.json` (preserving comments), installs shell completions, and points opencode at Homebrew's stable path — so updating is just:

```bash
brew upgrade opencode-provider-manager   # automatic on Bazzite; enable `brew autoupdate --upgrade` on macOS
```

then restart opencode — no need to re-run `setup`. Uninstall with `opencode-provider-manager uninstall` (then `brew uninstall opencode-provider-manager`).

> `opencode-provider-manager` (the command) is a small Rust helper that manages only the *wiring*; the plugin itself is the JavaScript package Homebrew installs and upgrades. Run `opencode-provider-manager --llm` for a full machine-readable guide.

### From a Git clone (any platform)

This fork isn't published to npm, so without Homebrew you install from source:

```bash
git clone git@github.com:jakobhviid/opencode-provider-manager.git
cd opencode-provider-manager
npm install          # the `prepare` script builds dist/
```

Then point opencode at the built plugin — either run:

```bash
opencode plugin "$(pwd)"
```

…or add the absolute path to the `plugin` array in **both** `~/.config/opencode/opencode.jsonc` (server) and `~/.config/opencode/tui.json` (TUI):

```jsonc
{
  "plugin": ["/absolute/path/to/opencode-provider-manager"]
}
```

The path is a live reference: after `git pull && npm run build`, restart opencode to pick up changes.

## Walkthrough

A typical first run, all from the opencode TUI. Each step auto-applies in place (see [Applying changes](#applying-changes)), so you don't restart between them.

1. **Add a provider** — run `/add-provider`:
   - *Name* → `my-proxy` (the short name you'll pick it by later)
   - *Base URL* → `https://api.my-proxy.com/v1`
   - *API key* → paste it, or leave blank if the endpoint needs none
   - *Display style* → **Exact model IDs** (best for proxies)

   It validates the endpoint, discovers the models, writes the provider to your `opencode.jsonc`, and reloads — the models appear in opencode's picker right away.

2. **Check what you've got** — `/providers` lists each provider with its base URL, where its key comes from (config / auth store / env / none), and any filters or overrides. `/test-provider` re-checks an endpoint and reports how many models it returns — handy when a key looks wrong or a local server is down.

3. **Trim the noise** — if the endpoint exposes models you don't want (embeddings, deprecated variants), run `/set-model-filter` and add exclude patterns like `embed, whisper` (or an include list like `coder, qwen` to keep only those).

4. **Fix a wrong context window** — if a self-hosted model shows the default 128k because models.dev doesn't know it, run `/override-model`, pick the model, and choose the real context (it offers whatever the endpoint reports, the models.dev value, common presets, or a custom number).

5. **Set your default** — `/set-default-model` → pick the provider → pick the model. That becomes opencode's default for new sessions.

Later on: `/add-provider-auth` sets a key on an existing provider and `/remove-provider-auth` clears it; `/edit-provider` changes a base URL; `/toggle-provider` disables discovery without removing the provider; `/remove-provider` deletes a provider and its key. Prefer to apply changes yourself? `/toggle-auto-reload` turns the in-place reload off.

## Configuration

### Add a provider — TUI
Run `/add-provider` and follow the prompts (name, base URL, optional API key, display style). The provider is written to your global `opencode.jsonc` and its models are discovered automatically.

### Add a provider — agent
Ask the agent, e.g. *"Add an OpenAI-compatible provider called my-proxy at https://api.proxy.com/v1 with API key sk-…"* — it calls the `add-provider` tool.

### Add a provider — manually
Add a block with a `baseURL` to `opencode.jsonc`; models are discovered automatically:

```json
{
  "provider": {
    "my-proxy": {
      "name": "My Proxy",
      "options": { "baseURL": "https://api.proxy.com/v1" }
    }
  }
}
```

Set `"dynamic": true` to force re-discovery even when a `models` list is present.

### Manage a provider's API key
- `/add-provider-auth` — pick an existing provider and set (or replace) its key. Useful when a provider was defined in config, or discovered from a keyless endpoint that later needs auth.
- `/remove-provider-auth` — pick a provider that has a stored key and delete just the key; the provider stays.

### Remove a provider
`/remove-provider` deletes the provider from `opencode.jsonc` (comments preserved) and removes its stored credential. Credentials supplied via `{env:…}` or otherwise shared are left untouched.

### Where API keys come from
1. The `/add-provider` / `/add-provider-auth` commands (stored in opencode's auth store)
2. `options.apiKey` in config
3. The environment variable `OPENCODE_LOCAL_<PROVIDER_ID>_API_KEY`

### Filtering, overrides, and disabling

Per-provider settings that don't belong in your opencode config (opencode strips unknown provider keys) are kept in `~/.config/opencode-provider-manager/settings.json`:

- **`/set-model-filter`** — keep only models matching include patterns and/or drop models matching exclude patterns (case-insensitive regex, substring fallback). Useful for noisy endpoints that expose embeddings or deprecated models.
- **`/override-model`** — set a model's context window (and max output) when models.dev doesn't know it. The picker offers any value the endpoint reports, the models.dev value, common presets, or a custom number.
- **`/toggle-provider`** — disable a provider's discovery without removing it.

By default these apply immediately — see [Applying changes](#applying-changes).

## Applying changes

By default, a change made through any of these commands **applies immediately**: the plugin asks opencode to reload itself in place — re-reading config, re-running discovery, rebuilding providers — via opencode's built-in `SIGUSR2` reload. No restart needed, and your session is preserved.

It's guarded: the reload only fires when opencode's reload handler is actually registered (i.e. the TUI is running), so it can **never terminate opencode**. When it can't reload safely, the command says "restart to apply" instead.

Turn it off with **`/toggle-auto-reload`** (stored in `~/.config/opencode-provider-manager/settings.json`); changes then apply on the next restart. You can also reload manually any time with `kill -USR2 $(pgrep -x opencode)`.

## Discovery eligibility

A provider is discovered when it has `options.baseURL` **and** either `dynamic: true` or no (empty) `models` list. Providers with an explicit `models` list are left alone unless `dynamic: true` is set.

## Limitations
- **Startup latency**: each dynamic provider adds a `/v1/models` request at startup (15s timeout), plus a models.dev fetch on first run.
- **models.dev coverage**: models not in the catalog get sensible defaults (128k context, 4096 output, text-only).
- **Capabilities**: endpoint-reported capabilities are merged with models.dev data; neither is complete for every proxy.

## Development

```bash
git clone git@github.com:jakobhviid/opencode-provider-manager.git
cd opencode-provider-manager
npm install
npm run build
npm test
```

See [AGENTS.md](AGENTS.md) for repository conventions.

## Credits

Originally created by [b3nw](https://github.com/b3nw) as [opencode-dynamic-custom-providers](https://github.com/b3nw/opencode-dynamic-custom-providers). This fork, maintained by Jakob Hviid, adds provider persistence to the global config, provider/key-management commands, and clearer prompts. The original MIT copyright is retained in [LICENSE](LICENSE).

## AI disclosure

Parts of this codebase were written with the assistance of AI coding agents (Claude Code, opencode, and others). All changes were reviewed by the maintainer.

## License

MIT — see [LICENSE](LICENSE). Copyright © b3nw (original) and Jakob Hviid (fork).
