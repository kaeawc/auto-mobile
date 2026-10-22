import Foundation

enum PrototypeBundleZipWriter {
    static func write(_ entries: [(String, Data)]) -> Data {
        var locals = Data()
        var directory = Data()
        for (path, bytes) in entries {
            let name = Data(path.utf8)
            let crc = Int(PrototypeBundleZipReader.crc32(bytes))
            var local = [UInt8](repeating: 0, count: 30)
            put(&local, 0, 0x0403_4B50, 4)
            put(&local, 4, 20, 2)
            put(&local, 12, 0x21, 2)
            put(&local, 14, crc, 4)
            put(&local, 18, bytes.count, 4)
            put(&local, 22, bytes.count, 4)
            put(&local, 26, name.count, 2)
            var central = [UInt8](repeating: 0, count: 46)
            put(&central, 0, 0x0201_4B50, 4)
            put(&central, 4, 20, 2)
            put(&central, 6, 20, 2)
            put(&central, 14, 0x21, 2)
            put(&central, 16, crc, 4)
            put(&central, 20, bytes.count, 4)
            put(&central, 24, bytes.count, 4)
            put(&central, 28, name.count, 2)
            put(&central, 42, locals.count, 4)
            locals.append(contentsOf: local)
            locals.append(name)
            locals.append(bytes)
            directory.append(contentsOf: central)
            directory.append(name)
        }
        var end = [UInt8](repeating: 0, count: 22)
        put(&end, 0, 0x0605_4B50, 4)
        put(&end, 8, entries.count, 2)
        put(&end, 10, entries.count, 2)
        put(&end, 12, directory.count, 4)
        put(&end, 16, locals.count, 4)
        locals.append(directory)
        locals.append(contentsOf: end)
        return locals
    }

    private static func put(_ bytes: inout [UInt8], _ position: Int, _ value: Int, _ width: Int) {
        for index in 0 ..< width {
            bytes[position + index] = UInt8(truncatingIfNeeded: value >> (8 * index))
        }
    }
}
