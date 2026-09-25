#!/bin/bash
# Builds what a Pro Host downloads from a GitHub release: the SplycedBoard/ folder, as
# committed, in two wrappings.
#
#   dist/SplycedBoard.tar.gz   fetched by the one-line Terminal install in the README
#   dist/SplycedBoard.zip      for downloading with a browser
#
# git archive packs only committed files (never node_modules, data/, logs/ or .DS_Store)
# and keeps the executable bits in both formats.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain -- SplycedBoard)" ]; then
  echo "! SplycedBoard/ has changes that aren't committed. The package leaves them out." >&2
fi

rm -rf dist
mkdir dist
git -c tar.umask=0022 archive --format=tar.gz -o dist/SplycedBoard.tar.gz HEAD SplycedBoard
git archive --format=zip -o dist/SplycedBoard.zip HEAD SplycedBoard

version="$(git show HEAD:SplycedBoard/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
echo "SplycedBoard v$version (commit $(git rev-parse --short HEAD))"
ls -lh dist/SplycedBoard.* | awk '{ print "  " $NF "  " $5 }'
