/**
 * Formats a float array as the PostgreSQL vector literal required by pgvector:
 *   [0.1,0.2,0.3]
 * Used everywhere we bind a generated embedding to a SQL parameter.
 */
export function toVectorSQL(v: number[]): string {
  return '[' + v.join(',') + ']';
}
