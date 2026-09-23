#!/usr/bin/env bash
#
# Keep docs/ Markdown readable on github.com as well as on the MkDocs site.
#
# GitHub renders MkDocs-only syntax (admonitions, tabs, attr lists, ...) as
# literal text and strips <style>/<script>. The check renders every page with
# the site's Markdown configuration from mkdocs.yml, with and without each
# MkDocs-only extension, so code examples, blockquotes, and lists are judged
# by the same parser that builds the site rather than by line regexes. See
# scripts/github/auto_mobile_docs/check_github_markdown.py.
#
# Runs the checker's unit tests first. Needs uv (the docs Python lockfile in
# scripts/github).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required to validate docs/ Markdown (https://docs.astral.sh/uv/)" >&2
  exit 2
fi

cd "$ROOT_DIR/scripts/github"
export PYTHONDONTWRITEBYTECODE=1
uv run --quiet --locked python -m unittest discover --quiet -s tests
exec uv run --quiet --locked python -m auto_mobile_docs.check_github_markdown "$@"
