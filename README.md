# OpenCode Provider Manager

An [opencode](https://opencode.ai) plugin for OpenAI-compatible providers — self-hosted servers (llama-swap, vLLM, oMLX, LM Studio) and proxies. **Point opencode at an endpoint and its models appear**, discovered from `/v1/models`, kept current while opencode runs, and enriched with [models.dev](https://models.dev) metadata. A set of `/pm-*` commands adds, edits, filters, and removes those providers from the TUI.

Requires opencode 2.

> **Fork notice.** This is a fork of [b3nw/opencode-dynamic-custom-providers](https://github.com/b3nw/opencode-dynamic-custom-providers) (full credit in [Credits](#credits)). **Install it from this repository — not the upstream npm package.**

## Commands

Every command is prefixed `pm-`, so plugin commands are easy to tell apart from opencode's own. They are also in the command palette (ctrl+p) under *Provider Manager*.

| Command | What it does |
| --- | --- |
| `/pm-providers` | List discovered providers with model counts; pick one for its address, key source, last check, errors, filter, and overrides |
| `/pm-reload-models` | Re-discover every provider's models now (also refreshes the models.dev metadata) |
| `/pm-add-provider` | Add an OpenAI-compatible provider: checks the endpoint, then writes it to `opencode.jsonc` |
| `/pm-edit-provider` | Change a provider's base URL |
| `/pm-remove-provider` | Remove a provider from `opencode.jsonc`, with its plugin settings |
| `/pm-toggle-provider` | Turn a provider's discovery off or on without removing it |
| `/pm-set-model-filter` | Include/exclude patterns for which models a provider lists |
| `/pm-override-model` | Set a model's context window when neither the endpoint nor models.dev knows it |
| `/pm-set-default-model` | Pick opencode's default model (writes `model` in `opencode.jsonc`) |

Things opencode does itself are left to opencode: `/connect` stores an API key for any provider, `opencode auth logout` removes one, and `/reload` re-reads the configuration.

## How model discovery works

- A provider is discovered when it uses the OpenAI-compatible package, has a `baseURL`, and declares **no `models` of its own**. A provider with an explicit `models` list is left alone.
- The plugin fetches `/v1/models` from each one when opencode starts and every 60 seconds after, and adds the models to opencode's catalog as they change — a model loaded on the server shows up without a restart. The last good list is kept through outages and cached on disk, so models are there immediately at the next start.
- Only chat models are listed. Embedding, reranker, speech, transcription, and image models are skipped, judged from what the endpoint reports (Hugging Face `pipeline_tag`, `capabilities`, output modalities).
- Context window, tool calling, and vision come from the endpoint when it reports them (`context_length`/`max_model_len`, `capabilities`, `supported_parameters`, `architecture`), then from models.dev, then from defaults. An endpoint that describes its models but omits tools means *no tools*; one that describes nothing (a bare id list) gets opencode's default of tools on.

## Configuration

A provider is plain opencode config. Add a block with a `baseURL` and no `models`, and its models are discovered:

```jsonc
{
  "provider": {
    "my-proxy": {
      "name": "My Proxy",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://api.proxy.com/v1" }
    }
  }
}
```

opencode's native `providers` form (`"package": "aisdk:@ai-sdk/openai-compatible"`, `"settings": { "baseURL": … }`) works the same; `/pm-add-provider` writes whichever form the file already uses. opencode watches its config, so edits apply without a restart.

### Show only your own providers

opencode lists every provider it knows about — its own hosted models, plus any service you've logged into. To see only the providers you add, give the config an allow-list:

```jsonc
{
  "enabled_providers": ["nous", "oMLX"]
}
```

`/pm-add-provider` and `/pm-remove-provider` keep this list in step, so a provider you add appears in `/models` straight away. Without the key, every provider is shown.

### Where API keys come from
1. `options.apiKey` (or `settings.apiKey`) in config — what `/pm-add-provider` writes when given a key
2. The environment variable `OPENCODE_LOCAL_<PROVIDER_ID>_API_KEY`
3. A key stored with opencode's `/connect`

### Filtering, overrides, and disabling

Per-provider settings that don't belong in the opencode config (opencode strips unknown provider keys) live in `~/.config/opencode-provider-manager/settings.json`: the model filter, context overrides, display style (exact model IDs or friendly names), and whether discovery is disabled. Changes made through the commands apply immediately.

## Limitations
- **models.dev coverage**: models it doesn't know, on endpoints that report nothing, get defaults (128k context, text-only, tools on).
- **Capabilities**: endpoint-reported capabilities are merged with models.dev data; neither is complete for every proxy.

## Installation

Two ways to install. **Homebrew is recommended** — one line, and `brew upgrade` keeps the plugin current. If you don't use Homebrew, install from a Git clone.

### Homebrew (macOS / Linux) — recommended

```bash
brew install jakobhviid/tap/opencode-provider-manager
opencode-provider-manager setup      # wire the plugin into opencode's config
```

Homebrew installs `opencode` first (the formula depends on it), then the plugin. Restart opencode and you're done. `setup` (alias `install`) is idempotent: it adds the plugin to the `plugin` array in your `opencode.jsonc` (and `tui.json`, preserving comments), installs shell completions, and points opencode at Homebrew's stable path — so updating is just:

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

Then add the clone's absolute path to the `plugin` array in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["/absolute/path/to/opencode-provider-manager"]
}
```

opencode loads `server.js` from that directory into its server and `tui.js` into the TUI, and watches both: after `git pull && npm run build` the plugin reloads on its own.

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
