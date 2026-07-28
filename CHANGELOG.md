# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.7.0] - 2026-07-28

### Added
- Homebrew distribution via the [`jakobhviid/homebrew-tap`](https://github.com/jakobhviid/homebrew-tap) tap: `brew install jakobhviid/tap/opencode-provider-manager` installs the plugin, then `opencode-provider-manager setup` wires it into opencode. `brew upgrade` keeps it current (automatic on Bazzite; enable `brew autoupdate --upgrade` on macOS) — no re-`setup` needed, since the config points at Homebrew's stable path.
- `opencode-provider-manager` CLI (Rust): `setup` (alias `install`) and `uninstall` make a comment-preserving edit of the `plugin` array in `opencode.jsonc` and `tui.json` (backing up first, idempotent), resolving the brew-installed plugin path per machine. Also ships `completions`, `man`, and `--llm`.

## [2.6.1] - 2026-07-28

### Fixed
- `/edit-provider` no longer freezes the discovered models (and a stale `api` URL) into the config — it now edits only `options.baseURL` in place.
- `/reload-models` and the `refresh-models` tool now authenticate with a provider's key from the auth store, not just `options.apiKey`/env (fixes 401s for keys set via `/add-provider-auth`).
- The `override-model` agent tool no longer clobbers a previously-set field when given only one of context/output; omitting both clears the override.
- `/set-model-filter` and `/edit-provider` prefill the current value as editable text instead of ghost-text placeholder, so confirming without retyping no longer wipes it.
- `removeCredential` guards against a malformed (non-object) auth store instead of throwing.
- `/add-provider` overwrite preserves the existing provider's custom options (e.g. headers).
- Model reloads keep the models.dev disk cache as an offline fallback (it's no longer deleted before the re-fetch).

## [2.6.0] - 2026-07-28

### Added
- Auto-reload: after a change (add/remove/edit provider, API keys, filters, overrides, default model, reload-models), the plugin reloads opencode in place via its built-in `SIGUSR2` handler, so changes apply immediately — no restart. Guarded to only fire when a handler is registered (it can never terminate opencode); otherwise it falls back to "restart to apply".
- `/toggle-auto-reload` (TUI) to turn auto-reload off/on. Persisted in the settings file.

### Changed
- Command toasts now say whether a change was applied live or needs a restart.

## [2.5.0] - 2026-07-28

### Added
- Provider management commands (TUI + agent tools): `/providers` (`list-providers`), `/test-provider`, `/edit-provider`, and `/toggle-provider` (enable/disable discovery).
- `/set-default-model`: pick a provider + model and set opencode's default `model` field.
- Model control: `/set-model-filter` (include/exclude patterns) and `/override-model` (context-window / output overrides with best-effort auto-detect + presets). Per-provider settings are stored in `~/.config/opencode-provider-manager/settings.json`.
- Discovery now also authenticates with a provider's key from opencode's auth store, not just `options.apiKey` / env.

### Fixed
- `/reload-models` / `refresh-models` no longer write an unloaded `<cwd>/config.json`. They re-discover, clear the models.dev cache, and report; changes apply on restart.

## [2.4.0] - 2026-07-28

### Added
- `/add-provider-auth` TUI command and `add-provider-auth` agent tool: set (or replace) the API key for an existing provider, stored in opencode's auth store.
- `/remove-provider-auth` TUI command and `remove-provider-auth` agent tool: delete a provider's stored API key while keeping the provider.

### Changed
- Renamed `/delete-provider` to `/remove-provider` (and the `delete-provider` tool to `remove-provider`) so all commands use consistent `add` / `remove` verbs.

## [2.3.0] - 2026-07-28

### Fixed
- `/add-provider` and the `add-provider` agent tool now persist the new provider to opencode's **global config file** (the one opencode actually loads) instead of via `client.config.update`, which wrote an unloaded `<cwd>/config.json`. Providers added through the UI no longer disappear on restart.

### Added
- `/delete-provider` TUI slash command and `delete-provider` agent tool: remove a provider from the global config (comments preserved) and delete that provider's stored credential from the auth store.
- `src/opencode-config.ts`: comment-preserving global-config writer (via `jsonc-parser`) plus an auth-store editor for credential removal.

### Changed
- `/add-provider` now persists a minimal provider stub (no frozen `models` block), keeping the model list discovery-driven and the user's config clean.

## [2.2.0] - 2026-05-23

### Added
- `add-provider` server tool for web/desktop provider setup (no TUI required)
- `refresh-models` server tool now performs full live re-discovery and config update (previously only cleared cache)

### Changed
- Extracted shared command logic into `src/commands.ts` to deduplicate between TUI commands and server tools
- Refactored TUI `/add-provider` and `/reload-models` to use shared logic

## [2.0.0] - 2026-05-21

### Added
- Automatic model discovery from any provider with a `baseURL` at startup
- [models.dev](https://models.dev) metadata enrichment (context windows, costs, capabilities, modalities)
- `/add-provider` TUI slash command for interactive provider setup
- `/reload-models` TUI slash command for in-session model re-discovery
- `refresh-models` server tool to clear the models.dev metadata cache
- `displayStyle` option to control model display names (`slug` vs `name`)
- Security: URL validation, model ID sanitization, error message redaction
- Stale cache fallback when models.dev is unreachable
- Environment variable support for API keys (`OPENCODE_LOCAL_<ID>_API_KEY`)
