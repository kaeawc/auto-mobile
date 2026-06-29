# App File Service

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

`putAppFile` and the app-file resources share one internal service so tools and
resources do not call `adb`, `run-as`, `simctl`, or the host filesystem directly.

## Service Boundary

- Public MCP handlers call `AppFileService` in `src/server/appFileService.ts`.
- `DefaultAppFileService` owns shared validation, source preparation, device
  resolution for resources, provider selection, and typed result metadata.
- Platform-specific behavior lives behind `AppFileProvider` implementations:
  `AndroidAppFileProvider` and `IosSimulatorAppFileProvider`.
- Providers receive normalized app IDs, logical containers, safe relative paths,
  and prepared source file paths. They should not accept raw MCP arguments.

## Shared Validation

Keep validation that is common to all platforms in the service or contract layer:

- `src/server/appFileContract.ts` validates MCP schema shape and resource URI
  parsing.
- `normalizeAppFileRelativePath` rejects absolute paths, empty paths, repeated
  separators, `.`, and `..` traversal.
- `AppFileService` validates app IDs before provider selection so unsafe app IDs
  cannot reach platform path construction.

Provider-specific checks should only cover platform capability differences. For
example, Android rejects `library`, and iOS rejects `externalFiles`.

## Adding Containers

1. Add the logical name to `APP_FILE_CONTAINERS` in
   `src/server/appFileContract.ts`.
2. Map the container in each provider in `src/server/appFileService.ts`.
3. If a platform cannot support the container, throw an explicit
   `ActionableError` through the unsupported-operation helper. Include the
   operation, app ID, container, and platform in the message.
4. Add tests in `test/server/appFileService.test.ts` for shared validation,
   provider routing, and the platform-specific capability behavior.

## Adding Providers

1. Implement `AppFileProvider` in `src/server/appFileService.ts` or a nearby
   module if the provider grows large.
2. Register the provider in `createDefaultProviders`.
3. Keep command-line details inside the provider. Return `AppFileListResult`,
   `AppFileReadResult`, and `PutAppFileResult` metadata through the service
   contract rather than leaking raw command output into MCP responses.
4. Unit-test with fakes; do not require real Android devices or iOS simulators.
