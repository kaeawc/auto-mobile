#!/usr/bin/env bash
set -euo pipefail

# MkDocs navigation is YAML, so keep the shell entry point but delegate its
# structural parsing to the existing js-yaml dependency. Resolve the root from
# this script, not the caller's directory, like the prior implementation.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."
exec bun "$script_dir/validate-mkdocs-nav.ts"
