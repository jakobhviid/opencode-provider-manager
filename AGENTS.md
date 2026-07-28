# AGENTS.md

Guidance for AI coding agents working in this repository.

## Commits (read this first)

- **NEVER add AI attribution to commits — ever.** Do not add `Co-Authored-By: Claude`
  (or any AI/agent), `Generated with …`, `🤖`, or any similar trailer or line to
  commit messages or pull-request descriptions.
- Write commit messages as the maintainer would: plain, descriptive, no tool branding.

## Build & test

- `npm run build` (tsc), then `npm test`.
- Keep the plugin dependency-light — it loads inside the opencode process.

## Project notes

- Fork of [b3nw/opencode-dynamic-custom-providers](https://github.com/b3nw/opencode-dynamic-custom-providers) (MIT).
- **Provider persistence must target opencode's GLOBAL config file** — see
  `src/opencode-config.ts`. Do NOT use `client.config.update` for durable
  persistence: it writes `<cwd>/config.json`, which opencode never loads.
- Credentials are removed directly from the auth store (`src/opencode-config.ts`
  `removeCredential`) because the SDK exposes no generic credential-delete.

## Repository layout

- **Root**: the opencode plugin (TypeScript). `src/` → `dist/` via tsc. This is
  what opencode loads.
- **`installer/`**: a Rust Cargo workspace — the `opencode-provider-manager` CLI
  that wires the plugin into opencode's config (`setup`/`uninstall`), plus
  `completions`/`man`/`--llm`. `crates/opencode-provider-manager` (bin) and
  `crates/opencode-provider-manager-core` (lib: comment-preserving JSONC edit +
  opencode path resolution). Test with `cargo test --manifest-path installer/Cargo.toml`.
- **`ci/`**: `stage-plugin.sh` (builds the shipped plugin package) and the Homebrew
  formula template `opencode-provider-manager.rb.tmpl`.

## Releases / Homebrew

- Pushing to `main` runs `.github/workflows/release.yml`: derives a
  Conventional-Commit version, builds the CLI for 4 targets, stages the plugin,
  publishes a GitHub release (tarballs + bottles), and pushes the rendered formula
  to `jakobhviid/homebrew-tap` (via the `TAP_DEPLOY_KEY` deploy-key secret).
- **Plugin packaging** (verified against real opencode): ship tsc `dist/` +
  `package.json` + a `node_modules` pruned to the runtime closure
  (`@opencode-ai/plugin` + `zod` + `jsonc-parser`, ~6 MB). Do NOT bundle (esbuild
  ESM breaks on a dynamic `require` in the deps) and do NOT ship the full
  `npm install` (~124 MB of SDK deps the plugin never imports). `ci/stage-plugin.sh`
  derives the closure via an esbuild metafile and smoke-imports both entrypoints.
- opencode loads a path plugin from the `plugin` array using the plugin's own
  `node_modules`; it does not inject `@opencode-ai/plugin` into resolution.
