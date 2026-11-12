/**
 * Shopgoodwill writes its times as ISO strings with no offset: the digits are
 * the Pacific wall-clock time the site shows (an item ending at 6:07 PM comes
 * back as "2026-11-20T18:07:00"). Read as UTC or as the server's local time
 * they are wrong by hours, and they shift with daylight saving. This module
 * turns the wall-clock digits into the real instant.
 */
export const SHOPGOODWILL_TIMEZONE = "America/Los_Angeles";

export interface WallClock {
  year: number;
  /** 1 to 12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond?: number;
}

/**
 * The instant at which `timeZone`'s clocks show `wall`. In the hour that does
 * not exist when clocks go forward, it gives the instant an hour earlier
 * (1:30 for 2:30); in the hour that happens twice, the first one.
 */
export function wallClockToDate(wall: WallClock, timeZone: string): Date {
  const millisecond = wall.millisecond ?? 0;
  const target = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second
  );
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // "h23" always counts midnight as hour 0; hour12: false can give 24
    hourCycle: "h23",
  });

  // Start from the digits read as UTC and correct by what the zone shows
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    ) as Record<string, number>;
    const shown = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!
    );
    const difference = target - shown;
    if (difference === 0) {
      break;
    }
    instant += difference;
  }
  return new Date(instant + millisecond);
}

const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

/**
 * A time as Shopgoodwill sends it, as the real instant. A value that already
 * carries an offset or "Z" is taken at its word, so this keeps working if the
 * site ever starts sending one. Returns an invalid Date for anything else.
 */
export function shopgoodwillTimeToDate(
  value: Date | string,
  timeZone: string = SHOPGOODWILL_TIMEZONE
): Date {
  if (value instanceof Date) {
    return value;
  }
  const match = WALL_CLOCK.exec(value.trim());
  if (!match) {
    return new Date(value);
  }
  const [, year, month, day, hour, minute, second, fraction] = match;
  return wallClockToDate(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second ?? 0),
      millisecond: fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0,
    },
    timeZone
  );
}
