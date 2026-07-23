#!/usr/bin/env bash

# Cross-platform millisecond timestamp
if [[ "$OSTYPE" == "darwin"* ]]; then
  if command -v gdate &>/dev/null; then
    gdate +%s%3N
  else
    python3 -c 'import time; print(int(time.time() * 1000))'
  fi
else
  date +%s%3N
fi
