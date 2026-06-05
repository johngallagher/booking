export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: number;
    status?: number;
    response?: {
      status?: number;
      data?: { error?: { errors?: Array<{ reason?: string }> } };
    };
  };
  const status = e.code ?? e.status ?? e.response?.status;
  if (status === 429) return true;
  if (status === 403) {
    const reasons = e.response?.data?.error?.errors?.map((x) => x.reason) ?? [];
    return reasons.some((r) => r === "rateLimitExceeded" || r === "userRateLimitExceeded" || r === "calendarUsageLimitsExceeded");
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt === maxAttempts - 1) throw err;
      const delay = Math.min(Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000), 32_000);
      console.warn(`Rate limited — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxAttempts - 1})`);
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}
