# opencode-provider-manager — workflows

`opencode-provider-manager` is a small CLI that **wires the opencode-provider-manager
plugin into opencode and removes it again**. Two layers:

- **The plugin** — a JavaScript package that runs *inside* opencode (auto-discovers
  models, adds provider-management commands). Homebrew installs and upgrades it.
- **This CLI** — only manages the *wiring*: it adds/removes the plugin's package
  directory in opencode's `plugin` array and installs shell completions.

Commands: `setup` (alias `install`), `uninstall`, `completions <shell>`, `man`.
Global flags: `--json` (machine-readable output), `--llm` (this guide).

## Install the plugin (interactive / human)

### Homebrew (macOS / Linux) — recommended
```sh
brew install jakobhviid/tap/opencode-provider-manager   # also installs opencode (a dependency)
opencode-provider-manager setup                          # wire it into opencode
# restart opencode
```
`brew upgrade opencode-provider-manager` updates it later (automatic on Bazzite; enable
`brew autoupdate --upgrade` on macOS), then restart opencode. No need to re-run `setup`.

### From a clone (any platform)
```sh
git clone https://github.com/jakobhviid/opencode-provider-manager
cd opencode-provider-manager && npm install
opencode plugin "$(pwd)"     # or: opencode-provider-manager setup --path "$(pwd)"
```

## Automation / declarative installers (temper, Ansible, cloud-init, an LLM)

Everything below is a stable contract you can rely on without reading source.

**Prerequisite & ordering.** opencode must be installed first — the plugin runs inside
it. The Homebrew formula declares `depends_on "opencode"`, so `brew install
jakobhviid/tap/opencode-provider-manager` installs opencode and the plugin package
before you run `setup`. If you don't use Homebrew, install opencode yourself first.
`setup` also needs the plugin package present (the formula provides it; otherwise pass
`--path <plugin dir>`). If the plugin package can't be located, `setup` exits non-zero
with a message and changes nothing.

**What `setup` does.** Idempotent, non-interactive, user-scope:
- Adds the plugin's package directory to the top-level `plugin` array in
  **`~/.config/opencode/opencode.jsonc`** and **`~/.config/opencode/tui.json`**,
  preserving comments/formatting. `$XDG_CONFIG_HOME` relocates the config dir;
  `$OPENCODE_CONFIG` overrides the **opencode.jsonc file path** specifically (it's a
  file path, not a dir) — `tui.json` always lives at `<config dir>/tui.json`.
- Before changing a file that exists, copies it to `<file>.bak` (non-clobbering:
  `.bak`, then `.bak.1`, …). Creates the file/dir if absent.
- Installs one shell completion file (`$XDG_DATA_HOME` defaults to `~/.local/share`):
  zsh → `$XDG_DATA_HOME/zsh/site-functions/_opencode-provider-manager`;
  bash → `$XDG_DATA_HOME/bash-completion/completions/opencode-provider-manager`;
  fish → `~/.config/fish/completions/opencode-provider-manager.fish`.
  Pass `--shell zsh|bash|fish` to pick the shell explicitly; omit it and the shell
  is detected from `$SHELL`.
- Does **not** touch the plugin's own runtime settings (`~/.config/opencode-provider-manager/settings.json`).
- **Never prompts.** Runs unattended. **Never needs sudo** (writes only under `$HOME`).
- The wired value is the plugin dir at Homebrew's *stable* path:
  `"$(brew --prefix opencode-provider-manager)/libexec/plugin"` (unchanged across
  upgrades), so `brew upgrade` doesn't invalidate it.

**Idempotency & exit codes.** Re-running `setup` when already wired is a no-op that
prints "nothing to do" and exits `0`. Exit `0` = success (including already-applied);
non-zero = error (e.g. plugin package not found, malformed JSONC). Safe to run on every
convergence.

**Machine-readable output (`--json`).** `setup`/`uninstall` print:
```json
{ "plugin": "<abs path>",
  "files": [ { "file": "<path>", "changed": true|false, "backup": "<path>|null" } ],
  "completions": "<note>|null" }
```
Errors print `{ "error": "<message>" }` (and exit non-zero). **All `files[].changed == false`
⇒ already applied** — this is your idempotency probe.

**Recommended converge step:** run `opencode-provider-manager setup --json --shell zsh`
unconditionally each pass (idempotent; the `changed` flags tell you if it did anything).

**Read-only drift check (no mutation).** "Applied" means the plugin dir is present in
**both** files (setup writes both), so check both:
```sh
dir="$(brew --prefix opencode-provider-manager)/libexec/plugin"
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
grep -qF "$dir" "$cfg/opencode.jsonc" && grep -qF "$dir" "$cfg/tui.json"   # exit 0 = fully wired
```

**Uninstall (reversal).** `opencode-provider-manager uninstall` — idempotent,
non-interactive. Removes the plugin entry from `opencode.jsonc` and `tui.json` (backing
up first). Leaves Homebrew's files, the installed completions, and `settings.json` in
place. Pass `--path <dir>` if the brew package is already gone. Then `brew uninstall
opencode-provider-manager` removes the package.

**Upgrades.** One formula ships both the plugin JS (`libexec/plugin`) and this CLI;
`brew upgrade` updates both in place at the stable path. No `setup` re-run needed —
just restart opencode to load the new version.

**Switching install methods.** `setup` won't duplicate an identical entry, but a
*different* path (e.g. a clone dir vs the brew path) is a separate entry. To switch,
`opencode-provider-manager uninstall --path <old dir>` first.

**The one manual tail.** `setup` edits config; opencode loads plugins at startup, so a
**restart is required to load the plugin** (or `kill -USR2 $(pgrep -x opencode)` if a
TUI with a reload handler is running). A converger reaches "installed + wired"; the
restart is not something this CLI can do for a running opencode session.
