#if DEBUG && !os(watchOS)
    import Foundation
    import Network

    enum SdkHttpResponseWriter {
        private static func statusText(for statusCode: Int) -> String {
            switch statusCode {
            case 200: return "OK"
            case 204: return "No Content"
            case 400: return "Bad Request"
            case 404: return "Not Found"
            case 405: return "Method Not Allowed"
            case 409: return "Conflict"
            case 431: return "Request Header Fields Too Large"
            case 500: return "Internal Server Error"
            case 503: return "Service Unavailable"
            default: return "Unknown"
            }
        }

        static func sendResponse(
            _ connection: NWConnection, statusCode: Int, body: Data?, extraHeaders: [(String, String)] = []
        ) {
            let statusText = statusText(for: statusCode)

            let bodyData = body ?? Data()
            var header = "HTTP/1.1 \(statusCode) \(statusText)\r\n"
            header += "Content-Type: application/json\r\n"
            header += "Content-Length: \(bodyData.count)\r\n"
            header += "Connection: close\r\n"
            for (name, value) in extraHeaders {
                header += "\(name): \(value)\r\n"
            }
            header += "\r\n"

            var responseData = Data(header.utf8)
            responseData.append(bodyData)

            connection.send(content: responseData, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }
#endif
