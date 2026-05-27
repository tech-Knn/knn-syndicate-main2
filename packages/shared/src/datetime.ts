/**
 * Timezone helpers (DECISION D4): all instants are stored in UTC, but the
 * platform "business day" — used for channel lock/release and daily revenue
 * buckets — is computed on a configurable business timezone (default IST,
 * Asia/Kolkata), since AdSense AFS reporting and channel rollover are
 * IST-anchored.
 */

export const DEFAULT_BUSINESS_TZ = 'Asia/Kolkata';

/** Offset (ms) of `tz` from UTC at the given instant. IST is a fixed +5:30. */
export function timeZoneOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - date.getTime();
}

/** The business-day string ("YYYY-MM-DD") for an instant in the given tz. */
export function businessDay(instant: Date = new Date(), tz: string = DEFAULT_BUSINESS_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Today's business day in the given tz. */
export function currentBusinessDay(tz: string = DEFAULT_BUSINESS_TZ): string {
  return businessDay(new Date(), tz);
}

/** UTC instant at the start (00:00:00) of a business day ("YYYY-MM-DD") in tz. */
export function zonedStartOfDayUtc(day: string, tz: string = DEFAULT_BUSINESS_TZ): Date {
  const baseUtcMs = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(baseUtcMs)) throw new Error(`Invalid business day: ${day}`);
  const offset = timeZoneOffsetMs(new Date(baseUtcMs), tz);
  return new Date(baseUtcMs - offset);
}

/** UTC [start, end) bounds for a business day in tz (end = next day's start). */
export function businessDayBoundsUtc(
  day: string,
  tz: string = DEFAULT_BUSINESS_TZ,
): { start: Date; end: Date } {
  const start = zonedStartOfDayUtc(day, tz);
  const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  // Re-derive from the next calendar day to stay correct across any DST change.
  const nextDay = businessDay(new Date(start.getTime() + 24 * 60 * 60 * 1000), tz);
  const end = zonedStartOfDayUtc(nextDay, tz);
  return { start, end: end.getTime() > start.getTime() ? end : next };
}
