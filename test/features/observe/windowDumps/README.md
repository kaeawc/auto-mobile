# WindowManager captures

## API 36 default-display rotation with and without mirroring

- `dumpsys-window-displays-mirror-landscape.txt` (25,568 bytes)
- `dumpsys-window-displays-mirror-portrait.txt` (26,165 bytes)
- `dumpsys-window-displays-nomirror-landscape.txt` (21,263 bytes)
- `dumpsys-window-displays-nomirror-portrait.txt` (21,860 bytes)

Source command: `adb shell dumpsys window displays`.
Captured on 2026-10-03 from API 36 emulator AVD `am-api36-ga-arm64`
(`emulator-5600`), running main commit `1db0d5733`.

The mirror was created by holding one video-stream subscription open. Rotation
was driven with `settings put system user_rotation`. The mirror display is id 3
in the landscape capture and id 4 in the portrait capture; it reports rotation 0
in both. The default display (id 0) reports rotation 1 in landscape and 0 in
portrait, with or without mirroring.

These four files are verbatim captures and must not be edited, reformatted, or
regenerated.
