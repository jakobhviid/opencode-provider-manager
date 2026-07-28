# OpenCode Provider Manager

A standalone [opencode](https://opencode.ai) plugin for OpenAI-compatible providers. It lets you **add and remove providers, manage their API keys, and automatically discover their models** — enriched with [models.dev](https://models.dev) metadata — from the TUI or via agent tools.

> **Fork notice.** This is a fork of [b3nw/opencode-dynamic-custom-providers](https://github.com/b3nw/opencode-dynamic-custom-providers) (full credit in [Credits](#credits)). It fixes provider persistence so providers added through the UI survive a restart, and adds provider- and key-management commands. **Install it from this repository — not the upstream npm package,** which does not include these changes.

## Commands

| Command (TUI) | Agent tool | What it does |
| --- | --- | --- |
| `/add-provider` | `add-provider` | Add a new OpenAI-compatible provider (validates the endpoint, discovers models) |
| `/remove-provider` | `remove-provider` | Remove a provider and delete its stored credential |
| `/add-provider-auth` | `add-provider-auth` | Set (or replace) the API key for an existing provider |
| `/remove-provider-auth` | `remove-provider-auth` | Delete a provider's stored key (keeps the provider) |
| `/reload-models` (`/refresh-models`) | `refresh-models` | Re-discover models for all dynamic providers without restarting |

## How model discovery works

- On startup, the plugin's `config` hook fetches `/v1/models` from every provider that has a `baseURL` and no explicit `models` list (or has `dynamic: true`).
- Each discovered model is cross-referenced against the [models.dev](https://models.dev) catalog for context windows, output limits, costs, and capabilities (tool calling, reasoning, modalities).
- Models are injected into the live config before opencode loads providers, so your model list stays current without hand-maintaining it.

## Installation

This fork is **not** published to npm (that package name belongs to upstream), so install it from source.

### Local clone (recommended)

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

The path is a live reference: after `npm run build`, restart opencode to pick up changes.

### From Git

If your opencode builds plugins on install, you can point it straight at the repo:

```bash
opencode plugin git+ssh://git@github.com/jakobhviid/opencode-provider-manager.git
```

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

## License

MIT — see [LICENSE](LICENSE). Copyright © b3nw (original) and Jakob Hviid (fork).
