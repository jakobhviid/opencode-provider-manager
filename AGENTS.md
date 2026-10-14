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
- Targets the opencode 2 plugin API. `@opencode/plugin` is a dev dependency for
  types only; the plugin imports nothing from it at runtime, and opencode
  supplies the context. Read the API from the opencode source at the matching
  tag (`packages/plugin/src`, and `packages/core/src/plugin/provider/local.ts`
  for the discovery pattern this plugin follows).
- opencode resolves a local plugin directory to `<dir>/server.js` and
  `<dir>/tui.js` (not `package.json` exports); the root files re-export `dist/`.
- Discovery is a **model** transform, not a provider transform: external
  provider transforms run before opencode's config-provider transform and
  can't see configured providers. Transforms are synchronous, so fetching
  happens outside them and `ctx.model.reload()` applies the result.
- The TUI half only shows dialogs; it calls the server half over plugin RPC
  (`src/rpc.ts`). RPC outputs must be strict JSON (no `undefined` values).
- TUI commands register in the `"global"` keymap mode; the default mode isn't
  active while the prompt has focus, so slash completion wouldn't list them.
- Config writes target opencode's GLOBAL config file (`src/opencode-config.ts`),
  comment-preserving; opencode watches it and reloads on change.

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

- Pushing to `main` runs `.github/workflows/release.yml`: reads the version from
  `package.json` (the single source of truth — bump it there to cut a release),
  builds the CLI for 4 targets, stages the plugin, publishes a GitHub release
  (tarballs + bottles), and pushes the rendered formula to the
  `auto/formula-opencode-provider-manager` branch of `jakobhviid/homebrew-tap`
  (via the `TAP_DEPLOY_KEY` deploy-key secret); the tap's gate installs and
  tests it there and lands it on `main` only if it passes.
- **Plugin packaging** (verified against real opencode): ship `server.js`,
  `tui.js`, tsc `dist/`, `package.json`, and a `node_modules` pruned to the
  runtime closure (`jsonc-parser`). Do NOT ship the full `npm install` (~200 MB
  of type-only dev deps). `ci/stage-plugin.sh` derives the closure via an
  esbuild metafile and smoke-imports both entrypoints.

computes and stamps it.

## "Documenting the diff" — the doc failure mode, named

Updating a doc or a comment is not the same as narrating the update. The reflex is
to *edit around* the stale sentence so it describes the transition: "this **is** now
checked", "it **no longer** needs root", "skipped **instead of** re-run". Every word
can be true and the doc still be wrong, because it describes your commit rather than
the software.

It costs twice. A reader can't tell a live constraint from a dead one, so the old
state keeps steering them and they route around a problem that is already gone. And
it ages into trivia — one release on, "used to do X" is a fact about a version
nobody runs.

The tells are greppable, so grep **your own diff** before committing: `now`,
`now that`, `no longer`, `used to`, `actually`, `really`, `instead of <the old
behaviour>`, emphatic italics (`*is*` checked — arguing with a claim the reader
never saw), `(fixed in 1.2.3)`, `DONE`.

The fix, in order:

1. **Rewrite as if the new behaviour were the only one that ever existed** — present
   tense, no memory. Keep the *why* only where it is non-obvious and durable.
2. **Then ask whether the line still earns its place.** One that only made sense as
   a contrast with the old state should be *deleted*, not reworded.
3. **Put the before/after in the commit message** — the artefact built for it, kept
   by git with a date and a diff.
