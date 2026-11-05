/**
 * Fetch every row of a query, paging with .range(). PostgREST silently caps a
 * response at the server's max-rows (1000 on hosted Supabase) even when
 * .limit() asks for more, so a plain select over a long window truncates with
 * no error — a cost sum just comes out low, an export just stops at row 1000.
 *
 * The caller's query MUST have a stable total order (e.g. end with
 * `.order('id')`), or rows can repeat/skip across pages while workers write.
 * `pageSize` must not exceed the server's max-rows, or a full page would look
 * short and end the loop early.
 */
export async function fetchAllRows<T>(
  context: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1)
    if (error) throw new Error(`Failed to load ${context}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < pageSize) return rows
  }
}
