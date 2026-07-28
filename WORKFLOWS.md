# opencode-provider-manager — workflows

The opencode plugin can be installed two ways. Pick one.

## A) Homebrew + the installer CLI (macOS / Linux)

```sh
brew install jakobhviid/tap/opencode-provider-manager
opencode-provider-manager setup      # wire the plugin into opencode's config
# restart opencode
```

- `setup` (alias `install`) adds the brew-installed plugin package to opencode's
  `plugin` array (in `opencode.jsonc` and `tui.json`), preserving your comments,
  and installs shell completions. It's idempotent — safe to re-run.
- Update: `brew upgrade opencode-provider-manager` (automatic on Bazzite via its
  systemd timers; on macOS enable `brew autoupdate --upgrade` or run it yourself),
  then restart opencode. No need to re-run `setup` — the config points at brew's
  stable path.
- Remove: `opencode-provider-manager uninstall` then `brew uninstall opencode-provider-manager`.

## B) Clone and point opencode at it (any platform)

```sh
git clone https://github.com/jakobhviid/opencode-provider-manager
cd opencode-provider-manager
npm install                          # builds dist/ via the prepare script
```

Then add the repo path to opencode's `plugin` array, or run
`opencode plugin "$(pwd)"`. Update with `git pull && npm run build`.
