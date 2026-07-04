/**
 * TOON (Token-Oriented Object Notation) writer/reader util for the MCP
 * output-context reduction effort (issue #2760).
 *
 * TOON encodes a uniform array of objects as a single header row plus one data
 * row per element, using indentation and a shared column list instead of
 * repeating braces and keys on every element:
 *
 *   name[3]{col1,col2,col3}:
 *     v1,v2,v3
 *     v4,v5,v6
 *
 * On near-uniform tabular data (e.g. `observe` element arrays) this drops the
 * per-element `{"key":...}` overhead JSON pays, for 30-60% fewer tokens. It is
 * deliberately NOT used for ragged/variable-depth trees, where the header
 * amortization never kicks in and the escaping risk is highest.
 *
 * Escaping (the acceptance-critical part): a cell is CSV-style quoted when it
 * contains a comma, double quote, CR/LF, or edge whitespace, or when it is the
 * empty string (so it can be told apart from an absent/`null` cell). Inside a
 * quoted cell, a literal `"` is doubled. `null` / `undefined` / absent keys
 * encode as an empty *unquoted* cell and decode back to `null`.
 */

/** Scalar cell inputs the encoder accepts. Objects/arrays must be pre-stringified. */
export type ToonScalar = string | number | boolean | null | undefined;

/** A decoded TOON block. `rows` cells are strings, or `null` for absent cells. */
export interface ToonTable {
  name: string;
  columns: string[];
  rows: (string | null)[][];
}

/** Table/array names must be bare identifiers so the header parses unambiguously. */
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * A token (cell or column name) must be quoted when it would otherwise be
 * ambiguous: it holds a delimiter/quote/newline, has edge whitespace that a
 * decoder would trim, or is the empty string (which must be distinguishable
 * from an absent cell).
 */
function needsQuoting(value: string): boolean {
  return value === "" || /[",\n\r]/.test(value) || /^\s|\s$/.test(value);
}

/** Escape a single token for a TOON header or row, quoting only when required. */
function escapeToken(value: string): string {
  if (!needsQuoting(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/** Encode one cell: `null`/`undefined` -> empty unquoted cell; else escaped string. */
function encodeCell(value: ToonScalar): string {
  if (value === null || value === undefined) {
    return "";
  }
  return escapeToken(String(value));
}

/**
 * Split `input` on `sep` at the top level, honoring `"..."` quoting (with `""`
 * as an escaped quote). Newlines inside quotes do not terminate a field, so the
 * same routine splits both rows (sep = "\n") and cells (sep = ",").
 */
function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          current += '""';
          i++;
        } else {
          current += '"';
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      current += '"';
      inQuotes = true;
    } else if (ch === sep) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Interpret a raw cell token: quoted -> unescaped string; empty -> null; else raw. */
function decodeCell(raw: string): string | null {
  if (raw.length === 0) {
    return null;
  }
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw;
}

/** Like `decodeCell` but for column names, which are always strings (never null). */
function decodeColumn(raw: string): string {
  return decodeCell(raw) ?? "";
}

/**
 * Encode a uniform array of records as a TOON block. Columns are the union of
 * all record keys in first-seen order, so ragged records still align to one
 * grid. `name` must be a bare identifier (see {@link NAME_PATTERN}).
 */
export function encodeToonTable(name: string, records: Array<Record<string, ToonScalar>>): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`TOON table name must be a bare identifier, got: ${JSON.stringify(name)}`);
  }

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  const header = `${name}[${records.length}]{${columns.map(escapeToken).join(",")}}:`;
  if (records.length === 0) {
    return header;
  }

  const rows = records.map(record => "  " + columns.map(col => encodeCell(record[col])).join(","));
  return [header, ...rows].join("\n");
}

/**
 * Parse a TOON block back into `{ name, columns, rows }`. The inverse of
 * {@link encodeToonTable}: cell strings round-trip byte-for-byte and absent
 * cells come back as `null`.
 */
export function decodeToonTable(block: string): ToonTable {
  const open = block.indexOf("[");
  const name = block.slice(0, open);

  const close = block.indexOf("]", open);
  // Column list lives between the first `{` after `]` and the `}:` that ends the
  // header line. Locate `}:` via the first top-level newline (or EOF) so a
  // quoted `}` inside a column name cannot be mistaken for the terminator.
  const braceOpen = block.indexOf("{", close);
  const headerEnd = block.indexOf("\n");
  const headerLine = headerEnd === -1 ? block : block.slice(0, headerEnd);
  const braceClose = headerLine.lastIndexOf("}");
  const colsRaw = block.slice(braceOpen + 1, braceClose);

  const columns = colsRaw.length === 0 ? [] : splitTopLevel(colsRaw, ",").map(decodeColumn);

  const rows: (string | null)[][] = [];
  if (headerEnd !== -1) {
    const region = block.slice(headerEnd + 1);
    for (const rowStr of splitTopLevel(region, "\n")) {
      // Strip the two-space structural indent, then split into cells.
      const body = rowStr.startsWith("  ") ? rowStr.slice(2) : rowStr;
      rows.push(splitTopLevel(body, ",").map(decodeCell));
    }
  }

  return { name, columns, rows };
}
