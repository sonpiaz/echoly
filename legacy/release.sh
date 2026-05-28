#!/usr/bin/env bash
# release.sh — bump version, pack zip, commit, tag, push, create GitHub release.
#
# Usage:
#   ./release.sh patch       # 0.2.1 → 0.2.2 (bug fix)
#   ./release.sh minor       # 0.2.1 → 0.3.0 (new feature)
#   ./release.sh major       # 0.2.1 → 1.0.0 (breaking change)
#   ./release.sh 0.2.5       # explicit version
#
# Then upload the resulting zip to:
#   https://chrome.google.com/webstore/devconsole
# (manual step — browser-based, can't automate without OAuth setup)

set -euo pipefail

cd "$(dirname "$0")"

if [ $# -lt 1 ]; then
  echo "usage: $0 <patch|minor|major|x.y.z>" >&2
  exit 64
fi

CUR=$(node -p "require('./manifest.json').version")
case "$1" in
  patch) NEW=$(node -e "const [a,b,c]='$CUR'.split('.').map(Number); console.log([a,b,c+1].join('.'))") ;;
  minor) NEW=$(node -e "const [a,b]='$CUR'.split('.').map(Number); console.log([a,b+1,0].join('.'))") ;;
  major) NEW=$(node -e "const [a]='$CUR'.split('.').map(Number); console.log([a+1,0,0].join('.'))") ;;
  *)     NEW="$1" ;;
esac

echo "Bumping $CUR → $NEW"

# Update both manifest.json and content.js ECHOLY_VERSION in lock-step
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
m.version = '$NEW';
fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
let c = fs.readFileSync('content.js', 'utf8');
c = c.replace(/const ECHOLY_VERSION = \"[^\"]+\";/, 'const ECHOLY_VERSION = \"$NEW\";');
fs.writeFileSync('content.js', c);
"

# Pack the zip
./pack.sh

# Show the diff and ask for confirmation before pushing
echo
git diff --stat manifest.json content.js
echo
read -r -p "Looks right? Commit + tag + push + create GitHub release? [y/N] " ans
[ "$ans" = "y" ] || { echo "aborted; manifest + content.js were updated locally but not committed"; exit 1; }

git add manifest.json content.js
git commit -m "chore: release v$NEW"
git tag -a "v$NEW" -m "v$NEW"
git push
git push --tags

# Optional release notes — paste from CHANGELOG.md or write inline
ZIP="$HOME/echoly-v${NEW}.zip"
gh release create "v$NEW" "$ZIP" \
  --title "v$NEW" \
  --notes "Install via developer mode: download \`echoly-v${NEW}.zip\`, unzip, drag into chrome://extensions with Developer mode on. Web Store update propagates automatically once Chrome approves."

echo
echo "✓ Released v$NEW"
echo "  Zip:    $ZIP"
echo "  GitHub: https://github.com/sonpiaz/echoly/releases/tag/v$NEW"
echo
echo "Next manual step (Web Store auto-update):"
echo "  1. https://chrome.google.com/webstore/devconsole"
echo "  2. Pick the Echoly item"
echo "  3. Drag $ZIP into the package upload area"
echo "  4. Add a one-line changelog and Submit for review"
echo "  5. Auto-rolls out to users 1-3 days after Chrome approves"
