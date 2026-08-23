# Dead Code Cleanup

Detect and remove dead code across TypeScript, Bash, Kotlin, and iOS/Swift codebases.

## Arguments

The user may specify a target scope as arguments: `$ARGUMENTS`

Supported scopes:

- **ts** / **typescript** — TypeScript dead code (ts-prune + knip)
- **bash** / **shell** — Unused variables, functions, and files in shell scripts
- **kotlin** / **android** — Unused Kotlin code in android/ (plus a specific module like `android/control-proxy`)
- **swift** / **ios** — Unused Swift code in ios/ (plus a specific package like `ios/control-proxy`)
- **all** — Run all of the above
- No argument or empty — Default to **all**

The user may also specify a subdirectory or module (e.g., `kotlin android/ide-plugin`, `swift ios/control-proxy`).

## Instructions

### Step 1: Determine scope

Parse `$ARGUMENTS` to determine which language(s) and optional subdirectory to scan. If ambiguous, ask the user.

### Step 2: Run detection for each target

#### TypeScript

1. Run the existing detection scripts:
   ```bash
   bun run dead-code:ts:prune
   bun run dead-code:ts:knip
   ```
2. Cross-reference results against `dead-code-allowlist.json` — items already allowlisted with valid reasons are false positives.
3. For each flagged item, grep the codebase to verify it is truly unused (check `src/`, `test/`, `scripts/`, barrel `index.ts` re-exports, and namespace imports like `import * as`).
4. Classify each as **DEAD** (zero references, safe to remove) or **FALSE POSITIVE** (used in tests, public API, barrel re-export, namespace import, etc.).

#### Bash / Shell

1. Run shellcheck on all `.sh` files in the target directory (default: `scripts/`):
   ```bash
   shellcheck scripts/*.sh
   ```
2. Focus on SC2034 (unused variables) and SC2317 (unreachable code).
3. Also look for script files in `scripts/` that are never referenced from `package.json`, other scripts, CI workflows (`.github/workflows/`), or documentation.

#### Kotlin / Android

1. Identify the Gradle module(s) to scan (default: all modules under `android/`).
2. Run Android lint if available:
   ```bash
   cd android && ./gradlew :<module>:lintDebug 2>&1
   ```
3. Grep for unused imports, classes, and functions using IDE-style heuristics:
   - Find all public/internal class and function declarations
   - Search for references to each across the module and its dependents
   - Flag any with zero external references (excluding the defining file)
4. Check for unused Gradle dependencies in `build.gradle.kts` files.

#### Swift / iOS

1. Identify the Swift package(s) or Xcode project(s) to scan (default: all under `ios/`).
2. Run swiftlint if configured:
   ```bash
   swiftlint lint --path ios/<target> 2>&1
   ```
3. Grep for unused types, functions, and protocols:
   - Find all public/internal declarations (`class`, `struct`, `enum`, `protocol`, `func`)
   - Search for references across the package and its dependents
   - Flag any with zero external references
4. Check for unused imports in Swift files.

### Step 3: Triage results

For each detected item, determine the correct action:

| Verdict                               | Action                                                               |
| ------------------------------------- | -------------------------------------------------------------------- |
| **DEAD — unused file**                | Delete the file, remove from barrel exports and allowlists           |
| **DEAD — unused export**              | Remove the export (and the code if nothing else in the file uses it) |
| **DEAD — unused dependency**          | Remove from package.json / build.gradle.kts / Package.swift          |
| **FALSE POSITIVE — test usage**       | Add to allowlist with reason if not already there                    |
| **FALSE POSITIVE — public API**       | Add to allowlist with reason if not already there                    |
| **FALSE POSITIVE — barrel re-export** | Add to allowlist with reason if not already there                    |

### Step 4: Apply fixes

1. Delete dead files.
2. Remove dead exports/functions/classes/interfaces.
3. Clean up any imports that referenced deleted code.
4. Update allowlists (`dead-code-allowlist.json` for TS) to remove entries for deleted items.
5. Update allowlists to add entries for confirmed false positives that aren't already listed.

### Step 5: Validate

1. **TypeScript**: Run `turbo run lint build test` (or `npx turbo run lint build test`).
2. **Bash**: Run `shellcheck` on modified scripts.
3. **Kotlin**: Run `./gradlew :<module>:lintDebug` and `./gradlew :<module>:testDebugUnitTest` if applicable.
4. **Swift**: Run `swift build` and `swift test` in the relevant package directory.
5. Re-run the dead code detection to confirm the count decreased.

### Step 6: Report

Summarize what was done:

- How many items were flagged
- How many were truly dead (removed)
- How many were false positives (allowlisted or ignored)
- Validation results (tests pass, build clean)

## Usage Notes

- Always verify before deleting — grep thoroughly for references including tests, scripts, CI, and barrel exports.
- TypeScript: `knip` may flag barrel `index.ts` re-exports and public API types as unused — these are almost always false positives.
- Kotlin: No dedicated dead code tool is configured yet; rely on grep-based heuristics and Android lint.
- Swift: No dedicated dead code tool (like Periphery) is configured yet; rely on grep-based heuristics and swiftlint.
- When in doubt, allowlist with a reason rather than deleting.
