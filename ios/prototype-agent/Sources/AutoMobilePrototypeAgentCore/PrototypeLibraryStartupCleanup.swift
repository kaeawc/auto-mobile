/// Temporary-file maintenance must never prevent opening the durable library. Attempt both
/// roots even when one is unavailable, and report failures without discarding the store.
struct PrototypeLibraryStartupCleanup {
    let exporter: PrototypeLibraryExporter
    let inbox: PrototypeLibraryInbox

    func run(warning: (String) -> Void) {
        do { try exporter.purgeStaleExports() }
        catch { warning("Export cleanup failed: \(error.localizedDescription)") }
        do { try inbox.purgeStaleFiles() }
        catch { warning("Inbox cleanup failed: \(error.localizedDescription)") }
    }
}
