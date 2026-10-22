import Foundation
#if canImport(Darwin)
    import Darwin

    /// Same-volume app-private staging; callers serialize commits in the owned parent.
    struct PrototypeBundleFileSystem: PrototypeBundleCommitFileSystem {
        private func failure() -> POSIXError { POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }

        func assertRealDirectory(_ path: URL) throws {
            var info = stat()
            guard lstat(path.path, &info) == 0 else { throw failure() }
            guard info.st_mode & S_IFMT == S_IFDIR else { throw POSIXError(.ENOTDIR) }
            let fd = open(path.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard fd >= 0 else { throw failure() }
            defer { close(fd) }
            var opened = stat()
            guard fstat(fd, &opened) == 0 else { throw failure() }
            guard info.st_dev == opened.st_dev, info.st_ino == opened.st_ino else { throw POSIXError(.ESTALE) }
        }

        func assertAbsent(_ path: URL) throws {
            var info = stat()
            if lstat(path.path, &info) == 0 { throw POSIXError(.EEXIST) }
            guard errno == ENOENT else { throw failure() }
        }

        func makeStagingDirectory(parent: URL, mode: UInt16) throws -> URL {
            guard mode == 0o700 else { throw POSIXError(.EINVAL) }
            var template = Array(parent.appendingPathComponent(".bundle-XXXXXX").path.utf8CString)
            let path = try template.withUnsafeMutableBufferPointer { buffer -> String in
                guard let address = buffer.baseAddress, let created = mkdtemp(address) else { throw failure() }
                return String(cString: created)
            }
            return URL(fileURLWithPath: path, isDirectory: true)
        }

        func mkdir(_ path: URL, mode: UInt16) throws {
            guard Darwin.mkdir(path.path, mode_t(mode)) == 0 else { throw failure() }
        }

        func writeExclusiveNoFollow(_ path: URL, bytes: Data) throws {
            let fd = open(path.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
            guard fd >= 0 else { throw failure() }
            defer { close(fd) }
            try bytes.withUnsafeBytes { raw in
                guard let address = raw.baseAddress else { return }
                var offset = 0
                while offset < raw.count {
                    let written = Darwin.write(fd, address.advanced(by: offset), raw.count - offset)
                    if written < 0, errno == EINTR { continue }
                    guard written > 0 else { throw failure() }
                    offset += written
                }
            }
        }

        func rename(from: URL, to destination: URL) throws {
            // Unlike a replacing rename, this also refuses a destination raced into existence.
            guard renameatx_np(AT_FDCWD, from.path, AT_FDCWD, destination.path, UInt32(RENAME_EXCL)) == 0
            else { throw failure() }
        }

        func remove(_ path: URL) throws { try FileManager.default.removeItem(at: path) }
    }
#endif
