#!/usr/bin/env bash
set -euo pipefail

exec bun scripts/check-no-local-shell-quote.ts
