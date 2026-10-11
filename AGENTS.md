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

- Pushing to `main` runs `.github/workflows/release.yml`: reads the version from
  `package.json` (the single source of truth — bump it there to cut a release),
  builds the CLI for 4 targets, stages the plugin, publishes a GitHub release
  (tarballs + bottles), and pushes the rendered formula to the
  `auto/formula-opencode-provider-manager` branch of `jakobhviid/homebrew-tap`
  (via the `TAP_DEPLOY_KEY` deploy-key secret); the tap's gate installs and
  tests it there and lands it on `main` only if it passes.
- **Plugin packaging** (verified against real opencode): ship tsc `dist/` +
  `package.json` + a `node_modules` pruned to the runtime closure
  (`@opencode-ai/plugin` + `zod` + `jsonc-parser`, ~6 MB). Do NOT bundle (esbuild
  ESM breaks on a dynamic `require` in the deps) and do NOT ship the full
  `npm install` (~124 MB of SDK deps the plugin never imports). `ci/stage-plugin.sh`
  derives the closure via an esbuild metafile and smoke-imports both entrypoints.
- opencode loads a path plugin from the `plugin` array using the plugin's own
  `node_modules`; it does not inject `@opencode-ai/plugin` into resolution.

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
