import Groq from 'groq-sdk';

/**
 * A pool of Groq API keys with automatic failover.
 *
 * Groq's free tier enforces separate per-minute and per-day limits, and hitting
 * the daily one mid-demo would otherwise take the whole app down. Supplying
 * several keys lets a request that fails for a key-specific reason be retried
 * immediately on the next key, with the exhausted one benched for a cooldown
 * proportional to what it actually hit.
 *
 * Failures that are NOT the key's fault (a bad request, an unknown model, a
 * context overflow) deliberately do not rotate — burning through every key on
 * an error that will repeat identically helps nobody.
 */

export type KeyFailureKind =
  | 'rate_limit_minute'
  | 'rate_limit_day'
  | 'invalid_key'
  | 'server_error'
  | 'not_key_related';

interface KeyState {
  key: string;
  /** `gsk_…RslRxh` — safe to log. */
  label: string;
  index: number;
  disabledUntil: number;
  permanentlyDisabled: boolean;
  failures: number;
}

/**
 * How long a request may block waiting for a benched key to recover. Kept well
 * under the 60s serverless function limit so a wait can never cause a timeout.
 */
const MAX_INLINE_WAIT_MS = 20_000;

const COOLDOWN_MS: Record<Exclude<KeyFailureKind, 'not_key_related'>, number> = {
  rate_limit_minute: 65_000,
  rate_limit_day: 60 * 60_000,
  invalid_key: 0, // handled via permanentlyDisabled
  server_error: 15_000,
};

function maskKey(key: string): string {
  return key.length <= 12 ? 'gsk_…' : `${key.slice(0, 8)}…${key.slice(-6)}`;
}

/**
 * Reads keys from GROQ_API_KEYS (comma or newline separated) falling back to
 * GROQ_API_KEY. Duplicates are dropped so a copy-paste slip cannot make the
 * pool look larger than it is.
 */
function loadKeys(): string[] {
  const raw = [process.env.GROQ_API_KEYS, process.env.GROQ_API_KEY]
    .filter(Boolean)
    .join(',');

  const seen = new Set<string>();
  return raw
    .split(/[,\n\s]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .filter((k) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export function classifyFailure(err: unknown): KeyFailureKind {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);

  if (status === 401 || status === 403 || /invalid[_ ]api[_ ]key|unauthor/i.test(message)) {
    return 'invalid_key';
  }

  if (status === 429 || /rate.?limit|quota|too many requests/i.test(message)) {
    // Groq reports the daily token cap as TPD / "per day"; that key is done
    // for the session, whereas a per-minute trip clears in about a minute.
    return /per day|\bTPD\b|daily|tokens per day/i.test(message)
      ? 'rate_limit_day'
      : 'rate_limit_minute';
  }

  if (status !== undefined && status >= 500) return 'server_error';

  // Model decommissioned, malformed request, context overflow — rotating keys
  // cannot help, so surface it immediately.
  return 'not_key_related';
}

export class GroqKeyPool {
  private states: KeyState[];
  private clients = new Map<string, Groq>();

  constructor(keys: string[]) {
    this.states = keys.map((key, index) => ({
      key,
      label: maskKey(key),
      index,
      disabledUntil: 0,
      permanentlyDisabled: false,
      failures: 0,
    }));
  }

  get size(): number {
    return this.states.length;
  }

  private clientFor(state: KeyState): Groq {
    let client = this.clients.get(state.key);
    if (!client) {
      // Retries are handled here, not by the SDK — the SDK would keep retrying
      // the same exhausted key instead of moving to the next one.
      client = new Groq({ apiKey: state.key, timeout: 45_000, maxRetries: 0 });
      this.clients.set(state.key, client);
    }
    return client;
  }

  private available(now: number): KeyState[] {
    return this.states.filter((s) => !s.permanentlyDisabled && s.disabledUntil <= now);
  }

  private bench(state: KeyState, kind: KeyFailureKind): void {
    state.failures += 1;
    if (kind === 'invalid_key') {
      state.permanentlyDisabled = true;
      return;
    }
    if (kind === 'not_key_related') return;
    state.disabledUntil = Date.now() + COOLDOWN_MS[kind];
  }

  /**
   * Runs `task` against the first usable key, rotating on key-specific
   * failures until the pool is exhausted.
   */
  async run<T>(
    task: (client: Groq) => Promise<T>,
    onRotate?: (info: { from: string; kind: KeyFailureKind; remaining: number }) => void
  ): Promise<{ result: T; keyLabel: string; attempts: number }> {
    if (!this.states.length) {
      throw new GroqPoolError(
        'No Groq API key is configured.',
        'Set GROQ_API_KEY (or GROQ_API_KEYS for several) in your environment.',
        'no_keys'
      );
    }

    const now = Date.now();
    let candidates = this.available(now);

    if (!candidates.length) {
      const usable = this.states.filter((s) => !s.permanentlyDisabled);
      if (!usable.length) {
        throw new GroqPoolError(
          `All ${this.states.length} Groq API key(s) were rejected as invalid.`,
          'Check the keys at console.groq.com — they may have been revoked.',
          'all_invalid'
        );
      }

      // Per-minute limits clear on their own. If the soonest key frees up
      // within the request's remaining time budget, waiting beats failing.
      const soonest = usable.reduce((a, b) => (a.disabledUntil <= b.disabledUntil ? a : b));
      const waitMs = soonest.disabledUntil - now;

      if (waitMs > 0 && waitMs <= MAX_INLINE_WAIT_MS) {
        console.warn(`[groq] all keys cooling; waiting ${Math.ceil(waitMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, waitMs + 500));
        candidates = this.available(Date.now());
      }

      if (!candidates.length) {
        throw new GroqPoolError(
          `All ${this.states.length} Groq API key(s) are rate limited.`,
          `The next one frees up in about ${Math.ceil(waitMs / 1000)}s. Free-tier per-minute limits reset quickly; daily limits do not.`,
          'all_rate_limited'
        );
      }
    }

    let lastError: unknown;
    let attempts = 0;

    for (const state of candidates) {
      attempts += 1;
      try {
        const result = await task(this.clientFor(state));
        // A success clears any accumulated suspicion about this key.
        state.failures = 0;
        return { result, keyLabel: state.label, attempts };
      } catch (err) {
        lastError = err;
        const kind = classifyFailure(err);

        if (kind === 'not_key_related') throw err;

        this.bench(state, kind);
        const remaining = this.available(Date.now()).length;
        onRotate?.({ from: state.label, kind, remaining });

        console.warn(
          `[groq] key ${state.label} failed (${kind}); ${remaining} key(s) still available`
        );
      }
    }

    throw new GroqPoolError(
      `All ${attempts} available Groq API key(s) failed.`,
      lastError instanceof Error ? lastError.message : String(lastError),
      'all_failed'
    );
  }

  /** Diagnostic snapshot for /api/health. */
  status() {
    const now = Date.now();
    return this.states.map((s) => ({
      key: s.label,
      state: s.permanentlyDisabled
        ? 'invalid'
        : s.disabledUntil > now
          ? `cooling down ${Math.ceil((s.disabledUntil - now) / 1000)}s`
          : 'ready',
      failures: s.failures,
    }));
  }
}

export class GroqPoolError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly code: 'no_keys' | 'all_invalid' | 'all_rate_limited' | 'all_failed'
  ) {
    super(message);
    this.name = 'GroqPoolError';
  }
}

/**
 * Lists the models the configured key can actually reach.
 *
 * Groq retires models on its own schedule — `llama-3.1-70b-versatile` and later
 * the whole Llama family both disappeared — so a hardcoded "try this instead"
 * hint goes stale too. Asking the API keeps the error message correct.
 */
export async function listAvailableModels(pool: GroqKeyPool): Promise<string[]> {
  try {
    const { result } = await pool.run((client) => client.models.list());
    return (result.data ?? [])
      .map((m) => m.id)
      .filter((id) => !/whisper|guard|orpheus|tts/i.test(id))
      .sort();
  } catch {
    return [];
  }
}

let pool: GroqKeyPool | null = null;

export function getKeyPool(): GroqKeyPool {
  if (!pool) pool = new GroqKeyPool(loadKeys());
  return pool;
}

/** Test/dev helper — forces the pool to be rebuilt from the environment. */
export function resetKeyPool(): void {
  pool = null;
}
