const MONDAY_API_URL = 'https://api.monday.com/v2';
const API_VERSION = '2024-10';

export class MondayApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'MondayApiError';
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Executes a GraphQL query against Monday.com.
 *
 * Handles the two failure modes that actually bite in production:
 *  - HTTP 429 / `ComplexityException`: Monday enforces a per-minute complexity
 *    budget. Both are transient, so we back off and retry.
 *  - GraphQL-level errors returned with HTTP 200, which `fetch` reports as success.
 */
export async function mondayQuery<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  attempt = 0
): Promise<T> {
  const apiKey = process.env.MONDAY_API_KEY;
  if (!apiKey) {
    throw new MondayApiError(
      'MONDAY_API_KEY is not set',
      undefined,
      'Add MONDAY_API_KEY to .env.local, or set DATA_SOURCE=mock to run without Monday.com.'
    );
  }

  const MAX_ATTEMPTS = 4;

  let response: Response;
  try {
    response = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
        'API-Version': API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
    });
  } catch (err) {
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(500 * 2 ** attempt);
      return mondayQuery<T>(query, variables, attempt + 1);
    }
    throw new MondayApiError(
      `Could not reach Monday.com: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      'Check network connectivity and that api.monday.com is reachable.'
    );
  }

  if (response.status === 429 || response.status >= 500) {
    if (attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = Number(response.headers.get('retry-after')) || 0;
      await sleep(retryAfter * 1000 || 1000 * 2 ** attempt);
      return mondayQuery<T>(query, variables, attempt + 1);
    }
  }

  const bodyText = await response.text();

  if (!response.ok) {
    throw new MondayApiError(
      `Monday.com API returned ${response.status}: ${bodyText.slice(0, 300)}`,
      response.status,
      response.status === 401 || response.status === 403
        ? 'The API token is missing, expired, or lacks read access to the board.'
        : undefined
    );
  }

  let json: {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
    error_message?: string;
    error_code?: string;
  };
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new MondayApiError(
      `Monday.com returned a non-JSON response: ${bodyText.slice(0, 200)}`
    );
  }

  // Monday sometimes reports auth/complexity failures with HTTP 200.
  const errorCode = json.error_code ?? json.errors?.[0]?.extensions?.code;
  const errorMessage = json.error_message ?? json.errors?.[0]?.message;

  if (errorCode === 'ComplexityException' && attempt < MAX_ATTEMPTS - 1) {
    // Budget resets on a rolling minute; wait it out rather than failing the query.
    await sleep(Math.min(20_000, 5_000 * 2 ** attempt));
    return mondayQuery<T>(query, variables, attempt + 1);
  }

  if (errorMessage) {
    throw new MondayApiError(
      `Monday.com GraphQL error: ${errorMessage}`,
      undefined,
      errorCode === 'ComplexityException'
        ? 'Monday.com rate limit hit. Wait a minute and retry.'
        : /not ?found|does not exist/i.test(errorMessage)
          ? 'Check that MONDAY_DEALS_BOARD_ID / MONDAY_WORK_ORDERS_BOARD_ID are correct and the token can read them.'
          : undefined
    );
  }

  if (!json.data) {
    throw new MondayApiError('Monday.com returned an empty response body.');
  }

  return json.data;
}
