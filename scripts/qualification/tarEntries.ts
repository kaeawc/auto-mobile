import { gunzipSync } from "node:zlib";

/** Reads regular files from npm's gzip-compressed ustar archives. */
export function readTarGzEntries(bytes: Uint8Array): Array<{ path: string; data: Uint8Array }> {
  try {
    const archive = gunzipSync(bytes);
    const entries: Array<{ path: string; data: Uint8Array }> = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = (bytes: Uint8Array) => decoder.decode(bytes).split("\0", 1)[0];
    const octal = (bytes: Uint8Array, field: string): number => {
      const value = text(bytes).trim();
      if (!/^[0-7]+$/.test(value)) {
        throw new Error(`Invalid tar ${field}: ${value}`);
      }
      const number = Number.parseInt(value, 8);
      if (!Number.isSafeInteger(number)) {
        throw new Error(`Tar ${field} exceeds safe integer range`);
      }
      return number;
    };
    let nextPath: string | undefined;
    for (let offset = 0; offset < archive.length;) {
      if (offset + 512 > archive.length) {
        throw new Error(`Truncated tar header at byte ${offset}`);
      }
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) {
        if (nextPath !== undefined) {
          throw new Error("Tar long path has no following entry");
        }
        if (
          offset + 1024 > archive.length ||
          !archive.subarray(offset).every((byte) => byte === 0)
        ) {
          throw new Error(`Truncated or corrupt tar end marker at byte ${offset}`);
        }
        return entries;
      }
      const checksum = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      );
      if (checksum !== octal(header.subarray(148, 156), "checksum")) {
        throw new Error(`Corrupt tar header checksum at byte ${offset}`);
      }
      const size = octal(header.subarray(124, 136), "size");
      const end = offset + 512 + Math.ceil(size / 512) * 512;
      if (end > archive.length) {
        throw new Error(`Truncated tar entry at byte ${offset} (${size} bytes)`);
      }
      const data = archive.subarray(offset + 512, offset + 512 + size);
      const type = header[156];
      if (type === 120) {
        // PAX lengths count bytes, including the length prefix and final newline.
        for (let pos = 0; pos < data.length;) {
          const space = data.indexOf(32, pos);
          const lengthText = space < 0 ? "" : decoder.decode(data.subarray(pos, space));
          const length = Number(lengthText);
          if (
            !/^\d+$/.test(lengthText) ||
            !Number.isSafeInteger(length) ||
            length <= space - pos + 1 ||
            pos + length > data.length ||
            data[pos + length - 1] !== 10
          ) {
            throw new Error(`Corrupt PAX record at tar byte ${offset}, payload byte ${pos}`);
          }
          const value = decoder.decode(data.subarray(space + 1, pos + length - 1));
          if (value.startsWith("path=")) {
            nextPath = value.slice(5);
          }
          pos += length;
        }
      } else if (type === 76) {
        nextPath = text(data);
      } else {
        const prefix = text(header.subarray(345, 500));
        const name = text(header.subarray(0, 100));
        const path = nextPath ?? (prefix ? `${prefix}/${name}` : name);
        nextPath = undefined;
        if (type === 48 || type === 0) {
          entries.push({ path, data });
        }
      }
      offset = end;
    }
    throw new Error("Truncated tar archive: missing end marker");
  } catch (error) {
    throw new Error(
      `Unable to read gzip tar archive: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
