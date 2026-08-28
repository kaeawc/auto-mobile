# App File Service

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

`putAppFile` and the app-file resources share one internal service so tools and
resources do not call `adb`, `run-as`, `simctl`, or the host filesystem directly.
The public write contract is a non-empty `files` batch plus a discriminated
`target`: `app_containers`, `user_files`, or `media_library`. The legacy
single-file app-container arguments are accepted only as a compatibility input
path; generated tool definitions advertise the canonical target-based shape.

## Service Boundary

- Public MCP handlers call `AppFileService` in `src/server/appFileService.ts`.
- `DefaultAppFileService` owns target/path normalization, whole-batch conflict
  preflight, source preparation and cleanup, device resolution for resources,
  provider selection, and typed result metadata.
- The provider registry keys write providers by platform plus logical storage
  domain. List and read provider seams are separate, so a write-only target
  never promises resource operations it cannot implement.
- Providers receive normalized targets, safe relative paths, and prepared local
  source file paths. They should not accept raw MCP arguments.
- Android `user_files` delegates to the bounded Downloads staging service and
  resolves the active Android profile before every write. `media_library` uses
  the AutoMobile-owned `automobile-media` Downloads namespace and reports
  success only after MediaStore discovery is verified.
- iOS Simulator `media_library` imports supported image and video filenames
  through `simctl addmedia`. Its result confirms import, not picker visibility;
  iOS physical devices and media list/read operations remain unsupported.

## Shared Validation

Keep validation that is common to all platforms in the service or contract layer:

- `src/server/appFileContract.ts` validates MCP schema shape and resource URI
  parsing.
- `normalizeAppFileRelativePath` rejects absolute paths, empty paths, repeated
  separators, `.`, and `..` traversal.
- `AppFileService` validates app IDs, user-file namespaces, paths, duplicate
  destinations, and directory-prefix conflicts before provider mutation begins.

Provider-specific checks should only cover platform capability differences. For
example, Android rejects `library`, and iOS rejects `externalFiles`.

## Adding Containers

1. Add the logical domain or app container to `src/server/appFileContract.ts`.
2. Register a write provider for every supported platform/domain pair.
3. Add list/read providers only where those operations are actually supported.
4. Add fake-backed tests in `test/server/appFileService.test.ts` for shared
   validation, provider routing, cleanup, result mapping, and platform limits.

## Adding Providers

1. Implement `AppFileProvider` in `src/server/appFileService.ts` or a nearby
   module if the provider grows large.
2. Register the provider in `createDefaultProviders`.
3. Keep command-line details inside the provider. Return `AppFileListResult`,
   `AppFileReadResult`, and `PutAppFileResult` metadata through the service
   contract rather than leaking raw command output into MCP responses.
4. Unit-test with fakes. Storage providers also need a focused device smoke test
   when their contract promises system-picker visibility.
