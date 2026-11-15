// fetch() with per-host pacing and retries, for APIs with rate limits.

// Next free request slot per host, so concurrent callers queue up instead of
// all firing at once.
const nextSlot = new Map<string, number>();

async function waitForSlot(host: string, interval: number) {
  const slot = Math.max(Date.now(), nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + interval);
  const wait = slot - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

interface Options {
  /** Minimum gap between requests to the same host. */
  intervalMs?: number;
  /** Give up instead of honoring a Retry-After longer than this. */
  maxWaitMs?: number;
  headers?: Record<string, string>;
}

export async function getJson<T>(url: string, options: Options = {}): Promise<T | null> {
  const host = new URL(url).host;
  const interval = options.intervalMs ?? 0;

  for (let attempt = 0; attempt < 6; attempt++) {
    await waitForSlot(host, interval);

    const res = await fetch(url, { headers: options.headers }).catch(() => null);
    if (res?.ok) return (await res.json()) as T;
    if (res?.status === 404) return null;

    if (res && res.status !== 429 && res.status < 500) {
      throw new Error(`${res.status} from ${url.replace(/api_key=[^&]+/, "api_key=…")}`);
    }
    const retryAfter = Number(res?.headers.get("retry-after")) || 2 ** attempt * 2;
    if (options.maxWaitMs !== undefined && retryAfter * 1000 > options.maxWaitMs) {
      throw new Error(`Rate limited for ${retryAfter}s by ${host}`);
    }
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
  }

  throw new Error(`Gave up on ${url.replace(/api_key=[^&]+/, "api_key=…")}`);
}
