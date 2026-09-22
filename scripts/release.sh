#!/bin/sh
# Релиз одним коммитом: версия + описание + git-тег + push.
#   npm run release -- "что сделано"          → patch
#   npm run release:minor -- "что сделано"    → minor
LEVEL="${1:-patch}"
MSG="$2"
if [ -z "$MSG" ]; then
	echo "Укажи описание: npm run release -- \"что сделано\"" >&2
	exit 1
fi
cd "$(dirname "$0")/.." || exit 1
npx tsc --noEmit || exit 1
git add -A
# -f: рабочее дерево не чистое (изменения в индексе); коммит npm version включает всё застейдженное,
# pre-commit-хук при этом пересобирает build/
npm version "$LEVEL" -f -m "v%s: $MSG" || exit 1
git push --follow-tags origin main
