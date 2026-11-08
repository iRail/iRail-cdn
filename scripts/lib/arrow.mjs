import { RecordBatch, Struct, Table, makeData, tableToIPC, vectorFromArray } from 'apache-arrow';
import { schemaFor } from '../../specs/schemas.mjs';

/** Encodes rows as one independently readable little-endian Arrow IPC file with the pinned schema. */
export function encodeRows(name, rows, metadata) {
  if (!metadata?.releaseId) throw new Error('releaseId metadata is required');
  const schema = schemaFor(name, metadata);
  const children = schema.fields.map((field) => vectorFromArray(rows.map((row) => {
    const value = row[field.name] ?? null;
    if (value === null && !field.nullable) throw new Error(`${name}.${field.name} cannot be null`);
    return value;
  }), field.type).data[0]);
  const batch = new RecordBatch(schema, makeData({ type: new Struct(schema.fields), length: rows.length, children }));
  return tableToIPC(new Table(batch), 'file');
}
