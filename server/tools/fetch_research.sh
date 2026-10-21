#!/usr/bin/env bash
# Download research-branch files (default: v11-inputs/) into <outdir>, keeping their paths; files already there are
# skipped. Needs the GitHub CLI (gh). Usage: server/tools/fetch_research.sh <outdir> [path prefix]
#   then: node server/tools/v11_replay.js <outdir>      node server/tools/v11_ablation.js <outdir>
set -euo pipefail
out=${1:?outdir}; prefix=${2:-v11-inputs/}
repo=${REPO:-AliMallick2008/meme-sniper}
mkdir -p "$out"
gh api "repos/$repo/git/trees/research?recursive=1" --jq ".tree[] | select(.type==\"blob\") | select(.path | startswith(\"$prefix\")) | .path" |
while read -r p; do
  [ -s "$out/$p" ] && continue
  mkdir -p "$out/$(dirname "$p")"
  gh api -H "Accept: application/vnd.github.raw" "repos/$repo/contents/$p?ref=research" > "$out/$p.part" && mv "$out/$p.part" "$out/$p"
  echo "$p $(stat -c %s "$out/$p")"
done
