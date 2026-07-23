#!/usr/bin/env bash
set -euo pipefail

exec bun scripts/check-simulator-tcc-sqlite-boundary.ts
