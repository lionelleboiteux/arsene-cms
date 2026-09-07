/** No generated Supabase `Database` types are wired up for this small app, so
 *  an embedded relation's inferred shape isn't reliable — PostgREST returns
 *  it as a single object for a to-one foreign key either way. */
export function embeddedName(value: unknown): string {
  const row = Array.isArray(value) ? value[0] : value;
  const name = (row as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : '';
}
