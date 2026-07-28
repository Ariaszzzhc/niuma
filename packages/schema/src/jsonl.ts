import { Schema } from "effect";
import { RecordedEvent } from "./event.ts";

type RecordedEventT = Schema.Schema.Type<typeof RecordedEvent>;

export const decode = Schema.decodeUnknownSync;
export const encode = Schema.encodeUnknownSync;

// Parse a single Session Journal line into a fully-validated
// RecordedEvent. Throws a Schema ParseError on malformed lines.
export function parseEventLine(line: string): RecordedEventT {
  return Schema.decodeUnknownSync(RecordedEvent)(JSON.parse(line));
}

// Serialize a RecordedEvent to a JSONL line (no trailing newline).
export function stringifyEventLine(event: RecordedEventT): string {
  return JSON.stringify(Schema.encodeUnknownSync(RecordedEvent)(event));
}

// Generic JSON-line helpers for any schema (archives, config, ...).
export function parseJsonLine<S extends Schema.Codec<unknown>>(
  schema: S,
  line: string,
): S["Type"] {
  return Schema.decodeUnknownSync(schema)(JSON.parse(line));
}

export function stringifyJsonLine<S extends Schema.Codec<unknown>>(
  schema: S,
  value: S["Type"],
): string {
  return JSON.stringify(Schema.encodeUnknownSync(schema)(value));
}
