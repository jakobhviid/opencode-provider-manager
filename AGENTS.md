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
