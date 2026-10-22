import Foundation

struct PrototypeBundleZipEntry {
    let name: String
    let flags: Int
    let method: Int
    let crc: UInt32
    let compressed: Int
    let expanded: Int
    let offset: Int
    var start = 0
    var end = 0
}

/// Bounds are checked before every record read. No unaligned loads or host endian assumptions.
struct PrototypeBundleZipDirectory {
    let bytes: [UInt8]
    func u16(_ position: Int) -> Int { Int(bytes[position]) | Int(bytes[position + 1]) << 8 }
    func u32(_ position: Int) -> Int { u16(position) | u16(position + 2) << 16 }

    func read() throws -> [PrototypeBundleZipEntry] {
        let end = try endOfDirectory()
        let directory = u32(end + 16)
        try bundleRequire(directory + u32(end + 12) == end, .headerMismatch)
        var entries: [PrototypeBundleZipEntry] = []
        var names = Set<String>()
        var position = directory
        for _ in 0 ..< u16(end + 10) {
            let (entry, next) = try central(position, end)
            try bundleRequire(names.insert(entry.name.lowercased()).inserted, .duplicateEntry, entry.name)
            entries.append(entry)
            position = next
        }
        try bundleRequire(position == end, .headerMismatch)
        for index in entries.indices {
            let path = entries[index].name
            try bundleRequire(
                path.range(
                    of: #"^(bundle\.json|spec\.json|assets/[0-9a-f]{64}\.(png|jpg|webp)|fonts/[0-9a-f]{64}\.(ttf|otf))$"#,
                    options: .regularExpression
                ) != nil,
                .entryNotAllowed,
                path
            )
            try local(&entries[index], directory)
        }
        var previousEnd = 0
        for entry in entries.sorted(by: { $0.offset < $1.offset }) {
            try bundleRequire(entry.offset == previousEnd, .headerMismatch, entry.name)
            previousEnd = entry.end
        }
        try bundleRequire(previousEnd == directory, .headerMismatch)
        return entries
    }

    private func endOfDirectory() throws -> Int {
        var positions: [Int] = []
        if bytes.count >= 4 {
            for position in max(0, bytes.count - 65557) ... bytes.count - 4 where u32(position) == 0x0605_4B50 {
                positions.append(position)
            }
        }
        try bundleRequire(positions.count == 1, .notAZip)
        guard let end = positions.first else { throw PrototypeBundleFailure(.notAZip) }
        try bundleRequire(end + 22 <= bytes.count, .notAZip)
        try bundleRequire(end < 20 || u32(end - 20) != 0x0706_4B50, .zip64Unsupported)
        let comment = u16(end + 20)
        try bundleRequire(end + 22 + comment == bytes.count, .trailingBytes)
        try bundleRequire(comment == 0, .extraFieldForbidden)
        try bundleRequire(u16(end + 4) == 0 && u16(end + 6) == 0, .multiDisk)
        try bundleRequire(u16(end + 8) == u16(end + 10), .multiDisk)
        try bundleRequire(
            u16(end + 10) != 0xFFFF && u32(end + 12) != 0xFFFF_FFFF &&
                u32(end + 16) != 0xFFFF_FFFF,
            .zip64Unsupported
        )
        try bundleRequire(u16(end + 10) <= PrototypeBundle.maxEntries, .tooManyEntries)
        return end
    }

    private func safeName(_ raw: ArraySlice<UInt8>) throws -> String {
        let name = String(decoding: raw, as: UTF8.self)
        try bundleRequire(
            !raw.contains(where: { $0 == 0 || $0 > 127 }) && !name.contains("\\"),
            .entryNameForbidden,
            name
        )
        try bundleRequire(
            !name.hasPrefix("/") && !name.split(separator: "/").contains("..") &&
                !name.contains("__MACOSX"),
            .entryNameForbidden,
            name
        )
        try bundleRequire(!name.hasSuffix("/"), .entryNameForbidden, name)
        return name
    }

    private func central(_ position: Int, _ end: Int) throws -> (PrototypeBundleZipEntry, Int) {
        try bundleRequire(position + 46 <= end && u32(position) == 0x0201_4B50, .headerMismatch)
        let next = position + 46 + u16(position + 28) + u16(position + 30) + u16(position + 32)
        try bundleRequire(next <= end, .headerMismatch)
        let name = try safeName(bytes[position + 46 ..< position + 46 + u16(position + 28)])
        let entry = PrototypeBundleZipEntry(
            name: name,
            flags: u16(position + 8),
            method: u16(position + 10),
            crc: UInt32(u32(position + 16)),
            compressed: u32(position + 20),
            expanded: u32(position + 24),
            offset: u32(position + 42)
        )
        let type = (u32(position + 38) >> 16) & 0xF000
        try bundleRequire((type == 0 || type == 0x8000) && u32(position + 38) & 0x10 == 0, .linkEntry, name)
        try bundleRequire(entry.flags & 0x41 == 0, .encryptedEntry, name)
        try bundleRequire(entry.method == 0 || entry.method == 8, .methodUnsupported, name)
        try bundleRequire(u16(position + 34) == 0, .multiDisk, name)
        try bundleRequire(
            entry.compressed != 0xFFFF_FFFF && entry.expanded != 0xFFFF_FFFF &&
                entry.offset != 0xFFFF_FFFF && u16(position + 6) < 45,
            .zip64Unsupported,
            name
        )
        try bundleRequire(u16(position + 30) == 0 && u16(position + 32) == 0, .extraFieldForbidden, name)
        try bundleRequire(entry.flags & ~0x0806 == 0, .headerMismatch, name)
        return (entry, next)
    }

    private func local(_ entry: inout PrototypeBundleZipEntry, _ directory: Int) throws {
        let position = entry.offset
        let path = entry.name
        try bundleRequire(position + 30 <= directory && u32(position) == 0x0403_4B50, .headerMismatch, path)
        let nameEnd = position + 30 + u16(position + 26)
        try bundleRequire(nameEnd <= directory, .headerMismatch, path)
        try bundleRequire(u16(position + 28) == 0, .extraFieldForbidden, path)
        try bundleRequire(bytes[position + 30 ..< nameEnd].elementsEqual(path.utf8), .headerMismatch, path)
        try bundleRequire(
            u16(position + 6) == entry.flags && u16(position + 8) == entry.method &&
                u32(position + 14) == Int(entry.crc) && u32(position + 18) == entry.compressed &&
                u32(position + 22) == entry.expanded,
            .headerMismatch,
            path
        )
        try bundleRequire(u16(position + 4) < 45, .zip64Unsupported, path)
        entry.start = nameEnd
        entry.end = nameEnd + entry.compressed
        try bundleRequire(entry.end <= directory, .headerMismatch, path)
    }
}
