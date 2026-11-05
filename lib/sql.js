import { z } from "zod";

export const sqlValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const sqlRecordSchema = z.record(z.string(), sqlValueSchema);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function toSafeIdentifier(identifier) {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

// Object.entries(record), rejecting an empty record.
export function requireEntries(record, label) {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    throw new Error(label === "where" ? "WHERE 條件不可為空" : `${label} 不可為空`);
  }
  return entries;
}
