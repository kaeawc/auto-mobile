#!/usr/bin/env bash
#
# Regenerate the AutoMobile desktop app icons from source.
#
# The dock / DMG / Linux / Windows icons are the canonical hand-drawn truck from
# docs/img/logo.svg — kept in its ORIGINAL colours (red marker outline, white fill, dark
# outline tires) — overlaid on a red "crayon" background. app-icon.svg is (re)generated here
# and is the raster source of truth; edit scripts/desktop/lib/compose-icon.ts to change the
# background, or docs/img/logo.svg to change the truck.
#
# The menu-bar (system tray) mask is a trimmed, single-colour silhouette of that same truck,
# which the desktop app tints per menu-bar appearance at runtime (see SystemTray.kt).
#
# How the truck is lifted off its source: logo.svg draws its white fill (#fbfbfb) as a
# full-canvas rectangle with the truck contours punched out (even-odd). Dropping just that
# leading rectangle subpath turns the same path into the truck-body white fill, so the whole
# logo composites cleanly over the crayon background with a transparent surround.
#
# Produces, in android/desktop-app/src/main/resources/icons/:
#   - app-icon.svg    generated source (crayon background + original-colour truck)
#   - app-icon.png    512x512  (Compose Linux installer icon + dev-run macOS Dock icon)
#   - app-icon.icns   full macOS iconset (Dock + DMG installer)
#   - app-icon.ico    Windows installer icon
#   - tray-truck.png  trimmed monochrome truck mask for the menu-bar icon
#
# Requirements (macOS): rsvg-convert (brew install librsvg), iconutil (built in),
# ImageMagick (brew install imagemagick), and bun (for the SVG path surgery).
#
# Usage:
#   scripts/desktop/generate-app-icons.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
icons_dir="${repo_root}/android/desktop-app/src/main/resources/icons"
svg="${icons_dir}/app-icon.svg"
logo="${repo_root}/docs/img/logo.svg"

if [[ ! -f "${logo}" ]]; then
  echo "error: source logo not found at ${logo}" >&2
  exit 1
fi

for tool in rsvg-convert iconutil magick bun; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "error: required tool '${tool}' not found on PATH" >&2
    exit 1
  fi
done

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

echo "==> extracting truck paths from logo.svg"
# Emit two fragments into the workdir:
#   truck-color.frag  the 5 original-colour truck <path> elements (path0 rectangle stripped)
#   truck-mono.frag   the body + wheels as one solid black silhouette (for the tray mask)
LOGO_SVG="${logo}" OUT_DIR="${workdir}" bun run "${repo_root}/scripts/desktop/lib/extract-truck.ts"

truck_color_frag="$(cat "${workdir}/truck-color.frag")"
truck_mono_frag="$(cat "${workdir}/truck-mono.frag")"

# Measure the truck's content bounding box (in the logo's 400x400 space) so the icon can fit it.
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">%s</svg>' "${truck_color_frag}" \
  >"${workdir}/truck-color.svg"
rsvg-convert --width 400 --height 400 "${workdir}/truck-color.svg" -o "${workdir}/truck400.png"
bbox="$(magick "${workdir}/truck400.png" -format "%@" info:)" # WxH+X+Y

echo "==> writing app-icon.svg (crayon background + original-colour truck; bbox ${bbox})"
BBOX="${bbox}" TRUCK_FRAG="${truck_color_frag}" OUT_SVG="${svg}" bun run \
  "${repo_root}/scripts/desktop/lib/compose-icon.ts"

# render <size> <out> renders the generated app-icon.svg to a square PNG.
render() {
  local size="$1" out="$2"
  rsvg-convert --width "${size}" --height "${size}" --output "${out}" "${svg}"
}

echo "==> app-icon.png (512x512)"
render 512 "${icons_dir}/app-icon.png"

echo "==> app-icon.icns (iconset)"
iconset="${workdir}/app-icon.iconset"
mkdir -p "${iconset}"
# Apple's required iconset slots: N and N@2x for 16/32/128/256/512.
render 16   "${iconset}/icon_16x16.png"
render 32   "${iconset}/icon_16x16@2x.png"
render 32   "${iconset}/icon_32x32.png"
render 64   "${iconset}/icon_32x32@2x.png"
render 128  "${iconset}/icon_128x128.png"
render 256  "${iconset}/icon_128x128@2x.png"
render 256  "${iconset}/icon_256x256.png"
render 512  "${iconset}/icon_256x256@2x.png"
render 512  "${iconset}/icon_512x512.png"
render 1024 "${iconset}/icon_512x512@2x.png"
iconutil --convert icns --output "${icons_dir}/app-icon.icns" "${iconset}"

echo "==> app-icon.ico"
render 256 "${workdir}/ico-256.png"
# -strip drops the date/time chunks so regeneration is byte-stable (deterministic output).
magick "${workdir}/ico-256.png" -strip -define icon:auto-resize=256,128,64,48,32,16 \
  "${icons_dir}/app-icon.ico"

echo "==> tray-truck.png (menu-bar mask)"
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">%s</svg>' "${truck_mono_frag}" \
  >"${workdir}/truck-mono.svg"
rsvg-convert --width 512 --height 512 "${workdir}/truck-mono.svg" -o "${workdir}/tray-truck-full.png"
# -strip drops the date/time chunks so regeneration is byte-stable (deterministic output).
magick "${workdir}/tray-truck-full.png" -trim +repage -strip "${icons_dir}/tray-truck.png"

echo "done. Wrote app-icon.{svg,png,icns,ico} and tray-truck.png to ${icons_dir}"
