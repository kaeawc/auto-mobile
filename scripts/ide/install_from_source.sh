#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IDE_PLUGIN_DIR="${ANDROID_STUDIO_PLUGINS_DIR:-${IDEA_PLUGINS_DIR:-}}"

if [[ -z "$IDE_PLUGIN_DIR" ]]; then
  echo "Set ANDROID_STUDIO_PLUGINS_DIR or IDEA_PLUGINS_DIR to your IDE plugins directory."
  echo "Example (macOS):"
  echo "  export ANDROID_STUDIO_PLUGINS_DIR=\"$HOME/Library/Application Support/Google/AndroidStudio2025.2/plugins\""
  exit 1
fi

if [[ ! -d "$IDE_PLUGIN_DIR" ]]; then
  echo "Plugins directory not found: $IDE_PLUGIN_DIR"
  exit 1
fi

(
  cd "$ROOT_DIR/android"
  ./gradlew -p ide-plugin buildPlugin
)

PLUGIN_ZIP=$(find "$ROOT_DIR/android/ide-plugin/build/distributions" -maxdepth 1 -name '*.zip' -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -n 1 || true)
if [[ -z "$PLUGIN_ZIP" ]]; then
  echo "No plugin zip found in android/ide-plugin/build/distributions"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

unzip -q "$PLUGIN_ZIP" -d "$TMP_DIR"
PLUGIN_DIR=$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1 || true)
if [[ -z "$PLUGIN_DIR" ]]; then
  echo "Failed to unpack plugin zip"
  exit 1
fi

PLUGIN_NAME="$(basename "$PLUGIN_DIR")"
DEST_DIR="$IDE_PLUGIN_DIR/$PLUGIN_NAME"

rm -rf "$DEST_DIR"
mkdir -p "$IDE_PLUGIN_DIR"
cp -R "$PLUGIN_DIR" "$DEST_DIR"

echo "Installed $PLUGIN_NAME to $DEST_DIR"

OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"

select_from_list() {
  local prompt="$1"
  shift
  local options=("$@")
  local count="${#options[@]}"

  if [[ "$count" -eq 0 ]]; then
    return 1
  fi

  echo "$prompt"
  local i=1
  for option in "${options[@]}"; do
    echo "  [$i] $option"
    i=$((i + 1))
  done
  read -r -p "Choose an option (1-$count): " selection
  if [[ -z "$selection" ]] || ! [[ "$selection" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if (( selection < 1 || selection > count )); then
    return 1
  fi
  echo "${options[$((selection - 1))]}"
}

restart_ide_macos() {
  local app_name="$1"
  if [[ -z "$app_name" ]]; then
    local known_apps=("Android Studio" "Android Studio Preview" "IntelliJ IDEA" "IntelliJ IDEA Ultimate" "IntelliJ IDEA Community")
    local running
    running="$(osascript -e 'tell application "System Events" to get name of (processes whose background only is false)' 2>/dev/null || true)"
    local matches=()
    for app in "${known_apps[@]}"; do
      if echo "$running" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -Fxq "$app"; then
        matches+=("$app")
      fi
    done
    if [[ "${#matches[@]}" -eq 1 ]]; then
      app_name="${matches[0]}"
    elif [[ "${#matches[@]}" -gt 1 ]]; then
      app_name="$(select_from_list "Multiple IDEs are running. Which should be restarted?" "${matches[@]}")"
    fi
  fi

  if [[ -z "$app_name" ]]; then
    read -r -p "Enter the IDE app name to restart (e.g., Android Studio): " app_name
  fi

  if [[ -z "$app_name" ]]; then
    echo "Skipping restart: no IDE app name provided."
    return 0
  fi

  echo "Restarting $app_name..."
  osascript -e "tell application \"$app_name\" to quit" || true
  sleep 2
  pkill -f "$app_name" || true
  open -a "$app_name"
}

restart_ide_linux() {
  local ide_cmd="${IDE_CMD:-}"
  if [[ -z "$ide_cmd" ]]; then
    echo "Set IDE_CMD to the launch command for your IDE (e.g., studio.sh or idea.sh)."
    read -r -p "Enter IDE command to launch (leave empty to skip): " ide_cmd
  fi
  if [[ -z "$ide_cmd" ]]; then
    echo "Skipping restart: no IDE command provided."
    return 0
  fi

  echo "Restarting IDE via: $ide_cmd"
  pkill -f "studio|idea|intellij|android-studio" || true
  nohup "$ide_cmd" >/dev/null 2>&1 &
}

restart_ide_windows() {
  local ide_cmd="${IDE_CMD:-}"
  if [[ -z "$ide_cmd" ]]; then
    echo "Set IDE_CMD to the launch command for your IDE (e.g., idea64.exe or studio64.exe)."
    read -r -p "Enter IDE command to launch (leave empty to skip): " ide_cmd
  fi
  if [[ -z "$ide_cmd" ]]; then
    echo "Skipping restart: no IDE command provided."
    return 0
  fi

  echo "Restarting IDE via: $ide_cmd"
  taskkill //F //IM idea64.exe 2>/dev/null || true
  taskkill //F //IM studio64.exe 2>/dev/null || true
  cmd.exe /C start "" "$ide_cmd"
}

if [[ "$OS_NAME" == "darwin" ]]; then
  restart_ide_macos "${IDE_APP_NAME:-}"
elif [[ "$OS_NAME" == "linux" ]]; then
  restart_ide_linux
else
  restart_ide_windows
fi
