#if DEBUG && !os(watchOS)
    import Foundation
    import Network

    /// Reads a single HTTP request without changing the server's framing semantics.
    final class SdkHttpRequestReader: Sendable {
        private static let httpHeaderDelimiter = Data("\r\n\r\n".utf8)
        static let maxHeaderBytes = 16 * 1024
        private static let maxHttpBodyBytes = 1024 * 1024

        enum HttpHeaderReadResult: Sendable {
            case complete(Data)
            case tooLarge
            case failed
        }

        func readCompleteHttpHeaders(
            _ connection: NWConnection,
            initialData: Data,
            completion: @escaping @Sendable (HttpHeaderReadResult) -> Void
        ) {
            if let delimiter = initialData.range(of: Self.httpHeaderDelimiter) {
                let headerBytes = initialData.distance(from: initialData.startIndex, to: delimiter.lowerBound)
                completion(headerBytes > Self.maxHeaderBytes ? .tooLarge : .complete(initialData))
                return
            }
            guard initialData.count <= Self.maxHeaderBytes else {
                completion(.tooLarge)
                return
            }

            connection
                .receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
                    guard error == nil, let self else {
                        completion(.failed)
                        return
                    }
                    var nextData = initialData
                    if let data { nextData.append(data) }
                    // Inspect appended bytes even on EOF, so oversized headers always get 431.
                    if isComplete, nextData.range(of: Self.httpHeaderDelimiter) == nil,
                       nextData.count <= Self.maxHeaderBytes
                    {
                        completion(.failed)
                        return
                    }
                    self.readCompleteHttpHeaders(connection, initialData: nextData, completion: completion)
                }
        }

        func readCompleteHttpBody(
            _ connection: NWConnection,
            initialData: Data,
            completion: @escaping @Sendable (Data?) -> Void
        ) {
            guard let range = initialData.range(of: Self.httpHeaderDelimiter) else {
                completion(nil)
                return
            }

            let headerData = initialData[..<range.lowerBound]
            let body = Data(initialData[range.upperBound...])
            guard let contentLength = Self.contentLength(from: Data(headerData)) else {
                completion(body)
                return
            }
            guard contentLength >= 0 else {
                completion(nil)
                return
            }
            guard contentLength <= Self.maxHttpBodyBytes else {
                completion(nil)
                return
            }

            if body.count >= contentLength {
                completion(Data(body.prefix(contentLength)))
                return
            }

            receiveRemainingHttpBody(
                connection,
                accumulatedBody: body,
                expectedLength: contentLength,
                completion: completion
            )
        }

        private func receiveRemainingHttpBody(
            _ connection: NWConnection,
            accumulatedBody: Data,
            expectedLength: Int,
            completion: @escaping @Sendable (Data?) -> Void
        ) {
            let remainingLength = expectedLength - accumulatedBody.count
            guard remainingLength > 0 else {
                completion(Data(accumulatedBody.prefix(expectedLength)))
                return
            }

            connection.receive(minimumIncompleteLength: 1, maximumLength: min(
                65536,
                remainingLength
            )) { [weak self] data, _, isComplete, error in
                if error != nil {
                    completion(nil)
                    return
                }

                var nextBody = accumulatedBody
                if let data = data {
                    nextBody.append(data)
                }

                if nextBody.count >= expectedLength {
                    completion(Data(nextBody.prefix(expectedLength)))
                    return
                }
                if isComplete {
                    completion(nil)
                    return
                }

                guard let self = self else {
                    completion(nil)
                    return
                }

                self.receiveRemainingHttpBody(
                    connection,
                    accumulatedBody: nextBody,
                    expectedLength: expectedLength,
                    completion: completion
                )
            }
        }

        private static func contentLength(from headerData: Data) -> Int? {
            guard let headers = String(data: headerData, encoding: .utf8) else { return nil }
            for line in headers.components(separatedBy: "\r\n") {
                let parts = line.split(separator: ":", maxSplits: 1)
                guard parts.count == 2 else { continue }
                if parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                    return Int(parts[1].trimmingCharacters(in: .whitespaces))
                }
            }
            return nil
        }

        static func httpHeaderData(from data: Data) -> Data? {
            guard let range = data.range(of: httpHeaderDelimiter) else { return nil }
            return Data(data[..<range.lowerBound])
        }
    }
#endif
