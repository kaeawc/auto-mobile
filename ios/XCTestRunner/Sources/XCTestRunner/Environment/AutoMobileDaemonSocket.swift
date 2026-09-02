import Darwin

/// The default per-uid daemon socket path. Frozen wire contract shared with the TypeScript daemon
/// (`src/daemon/constants.ts`): `/tmp/auto-mobile-daemon-<uid>.sock`.
enum AutoMobileDaemonSocket {
    static var defaultPath: String {
        let uid = String(getuid())
        return "/tmp/auto-mobile-daemon-\(uid).sock"
    }
}
