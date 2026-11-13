# MCP message size

A tool call travels as one MCP message, so its arguments count toward the size
limit of the transport you connect with:

| Transport       | Largest message     | Over the limit                                  |
| --------------- | ------------------- | ----------------------------------------------- |
| Streamable HTTP | 256 MiB             | HTTP `413 Request body too large`               |
| stdio           | 256 MiB less 64 KiB | JSON-RPC error `-32600`; the session stays open |

The stdio error message names the limit, and `error.data` holds `limitBytes` and
`requestBytes`. Your client can send later requests on the same session.

## Large files with `putAppFile`

`putAppFile` takes each file as `contentText`, `contentBase64`, or `sourcePath`.
Base64 content travels inside the message and is about 4/3 of the file size, so a
25 MB video adds about 33 MB to the request.

When AutoMobile runs on the same host as your files, pass `sourcePath` instead.
AutoMobile then reads the file from disk, and the message carries only the path.
Otherwise, send several smaller files in separate `putAppFile` calls so each
request stays under the limit.

Each `putAppFile` call writes every file it names as one complete payload. There
is no append, offset, or chunk field, so a later call to the same
`destinationPath` replaces the file instead of adding to it. You cannot split one
file across calls: each file must fit under the limit on its own. For a single
file larger than that, use `sourcePath`.
