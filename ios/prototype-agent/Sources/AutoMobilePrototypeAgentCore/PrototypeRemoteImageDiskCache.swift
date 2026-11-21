import Foundation

/// Actor-confined, app-private URL-keyed LRU. Cache I/O failure only causes a network miss.
struct PrototypeRemoteImageDiskCache {
    let directory: URL?
    var now: @Sendable () -> Date = { Date() }
    var maxBytes = PrototypeRemoteImages.maxDiskBytes
    private let files = FileManager.default

    init(directory: URL?, now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.now = now
    }

    private func file(_ url: String) -> URL? {
        directory?.appendingPathComponent(PrototypeBundle.sha256(Data(url.utf8)))
    }

    func touch(_ url: String) {
        guard let file = file(url) else { return }
        try? files.setAttributes([.modificationDate: now()], ofItemAtPath: file.path)
    }

    func read(_ url: String) -> Data? {
        guard let file = file(url),
              let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= PrototypeRemoteImages.maxDownloadBytes,
              let bytes = try? Data(contentsOf: file) else { return nil }
        touch(url)
        return bytes
    }

    func write(_ bytes: Data, url: String) {
        guard bytes.count <= maxBytes, let directory, let file = file(url) else { return }
        do {
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
            try bytes.write(to: file, options: .atomic)
            try files.setAttributes([.modificationDate: now()], ofItemAtPath: file.path)
            evict()
        } catch {
            // Best-effort cache: decoded pixels are already available in memory.
        }
    }

    private func evict() {
        guard let directory, let entries = try? files.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]
        ) else { return }
        let records = entries.compactMap { file -> (URL, Int, Date)? in
            guard let values = try? file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
                  let size = values.fileSize, let date = values.contentModificationDate else { return nil }
            return (file, size, date)
        }.sorted { $0.2 < $1.2 }
        var total = records.reduce(0) { $0 + $1.1 }
        for (file, size, _) in records where total > maxBytes {
            do {
                try files.removeItem(at: file)
                total -= size
            } catch {
                // Another process may have already removed this cache entry.
            }
        }
    }
}
