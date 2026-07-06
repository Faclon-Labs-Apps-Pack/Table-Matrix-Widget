#!/usr/bin/env bash
# Run inside any widget repo to pull latest architecture context from the template.
# Usage: ./sync-context.sh [branch]   (default: main)
set -e

TEMPLATE_REPO="krutik89/iolens-widget-template"
BRANCH="${1:-main}"
BASE="https://raw.githubusercontent.com/$TEMPLATE_REPO/$BRANCH"

CURL_ARGS=(-fsSL)
if [ -n "${GITHUB_TOKEN:-}" ]; then
  CURL_ARGS+=(-H "Authorization: token $GITHUB_TOKEN")
fi

FILES=(
  "CLAUDE.md"
  ".claude/skills/Envelope.md"
  ".claude/skills/Bindable.md"
  ".claude/skills/MiniEngine.md"
  ".claude/skills/DevHarness.md"
  ".claude/skills/SKILLS.md"
  "tsconfig.json"
  "src/iosense-sdk/useUNSTree.ts"
  "src/iosense-sdk/api.ts"
  "src/design-sdk-extra.d.ts"
)

for FILE in "${FILES[@]}"; do
  mkdir -p "$(dirname "$FILE")"
  curl "${CURL_ARGS[@]}" "$BASE/$FILE" -o "$FILE"
  echo "synced: $FILE"
done

echo ""
echo "Done. Commit the updated files:"
echo "  git add CLAUDE.md .claude/skills/ tsconfig.json src/iosense-sdk/useUNSTree.ts src/iosense-sdk/api.ts src/design-sdk-extra.d.ts"
echo "  git commit -m 'sync: update context + SDK from iolens-widget-template'"
