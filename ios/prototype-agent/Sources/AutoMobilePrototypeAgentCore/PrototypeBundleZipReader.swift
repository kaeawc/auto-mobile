import Foundation
#if canImport(Compression)
    import Compression
#endif

enum PrototypeBundleZipReader {
    static func read(_ data: Data) throws -> [(String, Data)] {
        try bundleRequire(data.count <= PrototypeBundle.maxCompressedBytes, .archiveTooLarge)
        let directory = PrototypeBundleZipDirectory(bytes: Array(data))
        let entries = try directory.read()
        let compressedTotal = entries.reduce(0) { $0 + $1.compressed }
        var expanded = 0
        return try entries.map { entry in
            let cap = PrototypeBundle.cap(entry.name)
            try bundleRequire(entry.expanded <= cap, .entryTooLarge, entry.name)
            let budgets: [(Int, PrototypeBundleCode)] = [
                (cap, .entryTooLarge), (PrototypeBundle.maxExpandedBytes - expanded, .expandedTooLarge),
                (compressedTotal * PrototypeBundle.maxRatio - expanded, .ratioExceeded),
            ]
            let budget = budgets.dropFirst().reduce(budgets[0]) { $1.0 < $0.0 ? $1 : $0 }
            let input = Data(directory.bytes[entry.start ..< entry.end])
            let output: Data
            if entry.method == 0 {
                try bundleRequire(input.count <= budget.0, budget.1, entry.name)
                output = input
            } else {
                output = try inflate(input, limit: budget.0, code: budget.1, path: entry.name)
            }
            expanded += output.count
            try bundleRequire(output.count == entry.expanded, .sizeMismatch, entry.name)
            try bundleRequire(crc32(output) == entry.crc, .crcMismatch, entry.name)
            return (entry.name, output)
        }
    }

    /// Incremental raw DEFLATE. Only the actual byte budget can authorize output allocation.
    private static func inflate(_ input: Data, limit: Int, code: PrototypeBundleCode, path: String) throws -> Data {
        #if canImport(Compression)
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: limit + 1)
            defer { buffer.deallocate() }
            var stream = compression_stream(
                dst_ptr: buffer,
                dst_size: 0,
                src_ptr: UnsafePointer(buffer),
                src_size: 0,
                state: nil
            )
            guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) !=
                COMPRESSION_STATUS_ERROR
            else { throw PrototypeBundleFailure(.sizeMismatch, path) }
            defer { compression_stream_destroy(&stream) }
            return try input.withUnsafeBytes { raw in
                guard let source = raw.bindMemory(to: UInt8.self).baseAddress else {
                    throw PrototypeBundleFailure(.sizeMismatch, path)
                }
                stream.src_ptr = source
                stream.src_size = 0
                var supplied = 0
                var total = 0
                while true {
                    // Compression may read ahead past the terminator within a supplied buffer.
                    // Withhold the final byte: END before that byte proves unused input, even
                    // if the decoder consumed its entire first buffer. Supply the last byte alone.
                    if stream.src_size == 0, supplied < input.count {
                        stream.src_ptr = source.advanced(by: supplied)
                        stream.src_size = max(1, input.count - supplied - 1)
                        supplied += stream.src_size
                    }
                    let size = limit + 1 - total
                    stream.dst_ptr = buffer.advanced(by: total)
                    stream.dst_size = size
                    let before = stream.src_size
                    let flags = supplied == input.count ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
                    let status = compression_stream_process(&stream, flags)
                    let written = size - stream.dst_size
                    try bundleRequire(total + written <= limit, code, path)
                    total += written
                    if status == COMPRESSION_STATUS_END {
                        try bundleRequire(stream.src_size == 0 && supplied == input.count, .sizeMismatch, path)
                        return Data(bytes: buffer, count: total)
                    }
                    try bundleRequire(
                        status == COMPRESSION_STATUS_OK && (written > 0 || stream.src_size < before),
                        .sizeMismatch,
                        path
                    )
                }
            }
        #else
            throw PrototypeBundleFailure(.methodUnsupported, path)
        #endif
    }

    private static let crcTable: [UInt32] = (0 ..< 256).map { value in
        (0 ..< 8).reduce(UInt32(value)) { crc, _ in crc & 1 == 0 ? crc >> 1 : (crc >> 1) ^ 0xEDB8_8320 }
    }

    static func crc32(_ bytes: Data) -> UInt32 {
        bytes.withUnsafeBytes { raw in
            crcTable.withUnsafeBufferPointer { table in
                var crc = UInt32.max
                for byte in raw {
                    crc = (crc >> 8) ^ table[Int((crc ^ UInt32(byte)) & 255)]
                }
                return ~crc
            }
        }
    }
}
