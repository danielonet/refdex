/**
 * A Cypher literal. Strings use double quotes and JSON's escapes, which Cypher shares, so a value
 * never spans lines. Null and undefined map entries are left out: Neo4j doesn't store null.
 */
export function cypherLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(cypherLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined);
    return `{${entries.map(([k, v]) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `\`${k.replace(/`/g, '``')}\``}: ${cypherLiteral(v)}`).join(', ')}}`;
  }
  throw new Error(`no Cypher literal for ${typeof value}`);
}
