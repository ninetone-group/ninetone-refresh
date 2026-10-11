/**
 * Weekly rotation for the homepage "of the week" tiles.
 *
 * `weekSlot(now, offsetDays)` counts whole weeks since the epoch with the
 * boundary shifted so that offset 0 steps on Monday 00:00 UTC (1970-01-01 was
 * a Thursday, hence the +3). The client tile passes 3.5 so it steps on
 * Thursday 12:00 UTC instead: the two tiles then never change on the same
 * morning, and each visitor sees one familiar face and one new one midweek.
 * Pure, so it can be tested without FileMaker.
 */
export function weekSlot(now: number, offsetDays = 0): number {
  return Math.floor((now / 86_400_000 + 3 - offsetDays) / 7);
}

/** The item for this week from a pool, or undefined when the pool is empty. */
export function pickOfTheWeek<T>(pool: readonly T[], now: number, offsetDays = 0): T | undefined {
  if (pool.length === 0) return undefined;
  return pool[((weekSlot(now, offsetDays) % pool.length) + pool.length) % pool.length];
}
