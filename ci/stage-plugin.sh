#!/usr/bin/env bash
# Stage the plugin package for release into <out>/plugin:
#   package.json + the server.js/tui.js entrypoints + dist/ (tsc output) +
#   node_modules pruned to the plugin's actual runtime import closure.
#
# opencode resolves a local plugin directory to <dir>/server.js and <dir>/tui.js,
# so the root entrypoints must ship alongside dist/.
#
# Why not bundle? esbuild ESM-bundling breaks on dynamic require() inside deps.
# Shipping whole package dirs avoids that entirely.
#
# Why not a full `npm install`? The dev tree carries @opencode/plugin (types
# only — the plugin imports nothing from it at runtime) and its ~200 MB of
# dependencies. The runtime closure is just jsonc-parser.
set -euo pipefail

out="${1:?usage: stage-plugin.sh <output-dir>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

npm ci
npm run build

# Derive the set of node_modules packages the entrypoints actually import
# (esbuild resolves the static graph; we only read its metafile, not its output).
meta="$(mktemp)"; junk="$(mktemp -d)"
npx --yes esbuild@0.25.0 server.js tui.js \
  --bundle --platform=node --format=esm --metafile="$meta" --outdir="$junk" >/dev/null 2>&1 || true
pkgs="$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const s = new Set();
  for (const f in m.inputs) {
    const x = f.match(/node_modules\/((?:@[^/]+\/[^/]+)|(?:[^/]+))/);
    if (x) s.add(x[1]);
  }
  console.log([...s].sort().join("\n"));
' "$meta")"

mkdir -p "$out"
out="$(cd "$out" && pwd)"   # absolutize, so the smoke-import file:// URLs are valid
dest="$out/plugin"
rm -rf "$dest"; mkdir -p "$dest"
cp package.json server.js tui.js "$dest/"
cp -R dist "$dest/dist"
while IFS= read -r p; do
  [ -z "$p" ] && continue
  mkdir -p "$dest/node_modules/$(dirname "$p")"
  cp -R "node_modules/$p" "$dest/node_modules/$p"
done <<< "$pkgs"

# Safety net: the staged entrypoints must import cleanly on their own. This
# catches closure drift (a new runtime dep that wasn't copied) at build time.
node --input-type=module -e 'await import("file://" + process.argv[1])' "$dest/server.js"
node --input-type=module -e 'await import("file://" + process.argv[1])' "$dest/tui.js"

echo "staged plugin package → $dest ($(du -sh "$dest" | cut -f1))"
echo "  runtime deps: $(echo "$pkgs" | tr '\n' ' ')"
