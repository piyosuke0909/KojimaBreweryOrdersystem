type Result = { status: number; data?: any };

/** Drive the same quote/action confirmation steps as the UI in legacy workflow tests.
 * Guard-specific tests intentionally use raw requests instead of this adapter. */
export async function confirmedInput(
  method: string, path: string, input: unknown,
  send: (method: string, path: string, input?: unknown) => Promise<Result>,
): Promise<any> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const body = input as Record<string, any>;
  const create = method === 'POST' && /^(\/api\/(?:admin|customer))\/orders$/.exec(path);
  const edit = method === 'PUT' && /^(\/api\/(?:admin|customer))\/orders\/([^/]+)$/.exec(path);
  if ((create || edit) && body.quote_token === undefined) {
    const match = (create || edit) as RegExpExecArray;
    const quoted = await send('POST', match[1] + '/quote', { ...body, ...(edit ? { order_id: edit[2] } : {}) });
    if (quoted.status === 200 && quoted.data?.quote_token) return { ...body, quote_token: quoted.data.quote_token };
  }
  const invoice = method === 'POST' && /^(\/api\/admin\/invoices\/[^/]+)\/(?:pay|cancel|reissue)$/.exec(path);
  if (invoice && body.expected_version === undefined && body.expected_total === undefined && body.expected_status === undefined) {
    const result = await send('GET', invoice[1]);
    if (result.status === 200 && result.data) return { ...body,
      expected_version: result.data.latest_version, expected_total: result.data.total_incl_tax, expected_status: result.data.status };
  }
  return input;
}
