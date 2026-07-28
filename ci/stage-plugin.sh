#!/usr/bin/env bash
# Stage the plugin package for release into <out>/plugin:
#   package.json + dist/ (tsc output) + node_modules pruned to the plugin's
#   actual runtime import closure.
#
# Why not bundle? esbuild ESM-bundling breaks on dynamic require() inside deps
# ("Dynamic require of ./impl/format is not supported"). Shipping whole package
# dirs avoids that entirely.
#
# Why not a full `npm install`? @opencode-ai/plugin *declares* a ~124 MB tree
# (solid-js, @opentui, web-tree-sitter, typescript, …) that the plugin never
# imports. The real closure of server.js + tui.js is just @opencode-ai/plugin +
# zod + jsonc-parser (~6 MB), verified to load in opencode.
set -euo pipefail

out="${1:?usage: stage-plugin.sh <output-dir>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

npm ci
npm run build

# Derive the set of node_modules packages the entrypoints actually import
# (esbuild resolves the static graph; we only read its metafile, not its output).
meta="$(mktemp)"; junk="$(mktemp -d)"
npx --yes esbuild@0.25.0 dist/server.js dist/tui.js \
  --bundle --platform=node --format=esm --metafile="$meta" --outdir="$junk" >/dev/null 2>&1 || true
pkgs="$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const s = new Set();
  for (const f in m.inputs) {
    const x = f.match(/node_modules\/((?:@[^/]+\/[^/]+)|(?:[^/]+))/);
    if (x) s.add(x[1]);
  }
  // @opencode-ai/plugin tree-shakes to ~0 bytes but is still a required import.
  s.add("@opencode-ai/plugin");
  console.log([...s].sort().join("\n"));
' "$meta")"

dest="$out/plugin"
rm -rf "$dest"; mkdir -p "$dest"
cp package.json "$dest/"
cp -R dist "$dest/dist"
while IFS= read -r p; do
  [ -z "$p" ] && continue
  mkdir -p "$dest/node_modules/$(dirname "$p")"
  cp -R "node_modules/$p" "$dest/node_modules/$p"
done <<< "$pkgs"

# Safety net: the staged entrypoints must import cleanly on their own. This
# catches closure drift (a new runtime dep that wasn't copied) at build time.
node --input-type=module -e 'await import(process.argv[1])' "$dest/dist/server.js"
node --input-type=module -e 'await import(process.argv[1])' "$dest/dist/tui.js"

echo "staged plugin package → $dest ($(du -sh "$dest" | cut -f1))"
echo "  runtime deps: $(echo "$pkgs" | tr '\n' ' ')"
