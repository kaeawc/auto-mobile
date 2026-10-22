import Foundation

/// Only app-owned Inbox copies may be removed; provider and caller-owned documents are retained.
struct PrototypeLibraryInbox {
    let root: URL
    var files: any PrototypeLibraryFileSystem = PrototypeLibraryDiskFileSystem()

    func cleanup(_ url: URL) throws {
        guard url.isFileURL, root.isFileURL else { return }
        let parent = root.standardizedFileURL.resolvingSymlinksInPath().pathComponents
        let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
        let path = resolved.pathComponents
        guard path.count > parent.count, Array(path.prefix(parent.count)) == parent else { return }
        // Remove the checked, resolved path so an alias outside Inbox cannot remove an external file.
        if files.exists(resolved) { try files.remove(resolved) }
    }

    func purgeStaleFiles() throws {
        guard files.exists(root) else { return }
        for child in try files.children(root) {
            try cleanup(root.appendingPathComponent(child))
        }
    }
}
