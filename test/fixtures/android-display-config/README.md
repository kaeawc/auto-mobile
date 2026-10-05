# Android display configuration captures

Raw command-output lines extracted from batch-30 manual testing of
`emulator-5600` (API 36), SHA `791b6b1df790d77a322c4fc153daa12dfc64cb5a`.
Source directory:
`../gh-issues-iteration-bc319f/scratch/mt30/` relative to this lane worktree.
The report's two-space presentation prefix on a command's first output line is
excluded; output bytes and captured trailing LF are retained.

| Fixture                      | Command                          | Capture step              |
| ---------------------------- | -------------------------------- | ------------------------- |
| `font-scale-1.15.txt`        | `settings get system font_scale` | `a5.out` #17              |
| `font-scale-after-reset.txt` | `settings get system font_scale` | `a5.out` #19, first line  |
| `density-physical-420.txt`   | `wm density`                     | `a5.out` #19, second line |
| `night-mode-no.txt`          | `cmd uimode night`               | `a5.out` #19, third line  |
| `night-mode-yes.txt`         | `cmd uimode night`               | `a8.out` #49              |

The false-failure MCP payload is in `out/a5-18-displayConfig.json`; the independent
reproduction is `a8.out` #45–#49 (`out/a8-45-displayConfig.json`,
`out/a8-46-displayConfig.json`, `out/a8-48-displayConfig.json`).
`a6.out` #1–#6 also records reset forcing dark mode to light.
No fixture is synthesized, and no device commands run in these tests.
