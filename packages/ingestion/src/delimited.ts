import { IngestionError, invariant } from "./errors.js";

export interface DelimitedRow {
  readonly line: number;
  readonly values: readonly string[];
}

export interface DelimitedOptions {
  readonly delimiter?: "," | "\t";
  readonly maxColumns?: number;
  readonly maxFieldCharacters?: number;
  readonly maxRowCharacters?: number;
}

export type DelimitedChunkSource =
  | AsyncIterable<string | Uint8Array>
  | Iterable<string | Uint8Array>;

/** Streaming RFC 4180-style parser with BOM and CRLF handling. */
export async function* parseDelimitedRows(
  source: DelimitedChunkSource,
  options: DelimitedOptions = {},
): AsyncGenerator<DelimitedRow> {
  const delimiter = options.delimiter ?? ",";
  const maxColumns = options.maxColumns ?? 1_024;
  const maxFieldCharacters = options.maxFieldCharacters ?? 1_000_000;
  const maxRowCharacters = options.maxRowCharacters ?? 4_000_000;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let values: string[] = [];
  let field = "";
  let line = 1;
  let rowLine = 1;
  let rowCharacters = 0;
  let inQuotes = false;
  let afterQuote = false;
  let fieldStarted = false;
  let skipLf = false;
  let firstCharacter = true;

  const append = (character: string): void => {
    field += character;
    rowCharacters += character.length;
    invariant(
      field.length <= maxFieldCharacters,
      "INVALID_RECORD",
      `Delimited field exceeds ${maxFieldCharacters} characters`,
      { line },
    );
    invariant(
      rowCharacters <= maxRowCharacters,
      "INVALID_RECORD",
      `Delimited row exceeds ${maxRowCharacters} characters`,
      { line: rowLine },
    );
  };

  const finishField = (): void => {
    values.push(field);
    invariant(values.length <= maxColumns, "INVALID_RECORD", "Delimited row has too many columns", {
      line: rowLine,
      maxColumns,
    });
    field = "";
    fieldStarted = false;
    afterQuote = false;
  };

  const consumeText = function* (text: string): Generator<DelimitedRow> {
    for (const rawCharacter of text) {
      if (firstCharacter) {
        firstCharacter = false;
        if (rawCharacter === "\uFEFF") {
          continue;
        }
      }
      if (skipLf) {
        skipLf = false;
        if (rawCharacter === "\n") {
          continue;
        }
      }
      const character = rawCharacter === "\r" ? "\n" : rawCharacter;
      if (rawCharacter === "\r") {
        skipLf = true;
      }

      if (inQuotes) {
        if (character === '"') {
          inQuotes = false;
          afterQuote = true;
        } else {
          append(character);
          if (character === "\n") {
            line += 1;
          }
        }
        continue;
      }

      if (afterQuote) {
        if (character === '"') {
          append('"');
          inQuotes = true;
          afterQuote = false;
          continue;
        }
        invariant(
          character === delimiter || character === "\n",
          "INVALID_RECORD",
          "Unexpected character after a closing quote",
          { line, character },
        );
      }

      if (character === delimiter) {
        finishField();
      } else if (character === "\n") {
        finishField();
        yield Object.freeze({ line: rowLine, values: Object.freeze(values) });
        values = [];
        rowCharacters = 0;
        line += 1;
        rowLine = line;
      } else if (character === '"') {
        invariant(
          !fieldStarted && field.length === 0,
          "INVALID_RECORD",
          "Quote inside unquoted field",
          {
            line,
          },
        );
        inQuotes = true;
        fieldStarted = true;
      } else {
        fieldStarted = true;
        append(character);
      }
    }
  };

  try {
    for await (const chunk of source) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      yield* consumeText(text);
    }
    const remainder = decoder.decode();
    if (remainder.length > 0) {
      yield* consumeText(remainder);
    }
  } catch (error) {
    if (error instanceof IngestionError) {
      throw error;
    }
    throw new IngestionError(
      "INVALID_RECORD",
      "Delimited input is not valid UTF-8",
      {},
      { cause: error },
    );
  }

  invariant(!inQuotes, "INVALID_RECORD", "Delimited input ended inside a quoted field", { line });
  if (fieldStarted || field.length > 0 || values.length > 0 || afterQuote) {
    finishField();
    yield Object.freeze({ line: rowLine, values: Object.freeze(values) });
  }
}

export interface DelimitedObjectRow {
  readonly line: number;
  readonly record: Readonly<Record<string, string>>;
}

export async function* parseDelimitedObjects(
  source: DelimitedChunkSource,
  options: DelimitedOptions = {},
): AsyncGenerator<DelimitedObjectRow> {
  let headers: readonly string[] | null = null;
  const seenHeaders = new Set<string>();
  for await (const row of parseDelimitedRows(source, options)) {
    if (headers === null) {
      headers = row.values.map((header, index) => {
        const normalized = (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim();
        invariant(normalized.length > 0, "INVALID_RECORD", "Delimited header is empty", {
          line: row.line,
          index,
        });
        if (seenHeaders.has(normalized)) {
          throw new IngestionError("DUPLICATE_KEY", `Duplicate delimited header: ${normalized}`, {
            header: normalized,
          });
        }
        seenHeaders.add(normalized);
        return normalized;
      });
      continue;
    }
    if (row.values.length === 1 && row.values[0] === "") {
      continue;
    }
    invariant(
      row.values.length === headers.length,
      "INVALID_RECORD",
      "Delimited row column count does not match its header",
      { line: row.line, expected: headers.length, actual: row.values.length },
    );
    const record: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      invariant(header !== undefined, "INVALID_RECORD", "Missing delimited header", { index });
      record[header] = row.values[index] ?? "";
    }
    yield Object.freeze({ line: row.line, record: Object.freeze(record) });
  }
  invariant(headers !== null, "INVALID_RECORD", "Delimited input has no header row");
}
