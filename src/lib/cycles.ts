/** Two-year election cycles are named for the even year they end in. */
export function currentCycle(now = new Date()) {
  const year = now.getFullYear();
  return year % 2 ? year + 1 : year;
}

/** The last `count` cycles, oldest first. */
export function recentCycles(count: number) {
  const latest = currentCycle();
  return Array.from({ length: count }, (_, i) => latest - 2 * (count - 1 - i));
}

/**
 * Data for a finished cycle barely changes, so once it was fetched after the
 * year-end reports came in (due Jan 31) keep it forever. Anything else is
 * refreshed once it's older than `maxAgeDays`.
 */
export function isFresh(fetchedAt: Date, cycle: number, maxAgeDays: number) {
  if (fetchedAt >= new Date(cycle + 1, 2, 1)) return true;
  return Date.now() - fetchedAt.getTime() < maxAgeDays * 24 * 60 * 60 * 1000;
}
