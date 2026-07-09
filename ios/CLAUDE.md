# AutoMobile iOS

Quick reference for AI agents working in `ios/`. Run all commands from the repo root unless noted.

## Project Layout
- `ios/` - Swift packages and Xcode projects
- `scripts/ios/` - iOS build and test scripts

## Common Commands (from repo root)
- `./scripts/ios/swift-build.sh`
- `./scripts/ios/swift-test.sh`
- `./scripts/ios/xcodegen-generate.sh`
- `./scripts/ios/xcode-build.sh`

## Notes
- Use the scripts in `scripts/ios/` instead of invoking Xcode directly.
- If you need XcodeGen, install it with `brew install xcodegen`.
- When adding, removing, or renaming files under `ios/control-proxy`, run `scripts/ios/xcodegen-generate.sh` from the repository root and commit the updated `ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj`.
