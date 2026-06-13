import * as moment from "moment";

export function parseRelativeDateToAbsolute(relativeDate: string) {
  if (relativeDate == "never") return moment(0).toDate();

  return moment()
    .add(
      relativeDate.split("-")[0],
      relativeDate.split("-")[1] as moment.unitOfTime.DurationConstructor,
    )
    .toDate();
}

type Timespan = {
  value: number;
  unit: "minutes" | "hours" | "days" | "weeks" | "months" | "years";
};

/**
 * The only units a timespan config value may use. Kept in sync with the
 * frontend `TimespanInput` and the `Timespan` type below.
 */
export const TIMESPAN_UNITS: Timespan["unit"][] = [
  "minutes",
  "hours",
  "days",
  "weeks",
  "months",
  "years",
];

/**
 * Upper bound for the numeric part of a timespan. Chosen so that
 * `moment().add(value, unit)` stays a valid date for *every* unit — notably
 * `years`, where values near a million overflow JavaScript's Date range and
 * produce an "Invalid Date". 100000 of any unit is far beyond any realistic
 * use while leaving a large safety margin. Kept in sync with the frontend.
 */
export const MAX_TIMESPAN_VALUE = 100000;

/**
 * Strictly parses a timespan config string (e.g. `"7 days"`).
 *
 * Returns `null` for anything that isn't a non-negative whole number followed
 * by a single allowed unit. This is intentionally defensive: negative values,
 * empty strings, missing/unknown units, decimals, `NaN` and out-of-range
 * numbers all yield `null` so callers can fall back instead of feeding garbage
 * into `moment().add()`.
 */
export function parseTimespan(value: unknown): Timespan | null {
  if (typeof value !== "string") return null;

  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) return null;

  const [time, unit] = parts;

  // Only non-negative integers — rejects "-5", "1.5", "+7", "abc", "" …
  if (!/^\d+$/.test(time)) return null;

  const num = parseInt(time, 10);
  if (!Number.isInteger(num) || num < 0 || num > MAX_TIMESPAN_VALUE)
    return null;

  if (!TIMESPAN_UNITS.includes(unit as Timespan["unit"])) return null;

  return { value: num, unit: unit as Timespan["unit"] };
}

/**
 * Validates a timespan config string and returns a human readable error
 * message, or `null` when the value is acceptable.
 *
 * @param options.allowZero whether `0` is a valid amount. `0` is meaningful for
 *   `share.maxExpiration` (it means "no maximum"), but disastrous for durations
 *   like `general.sessionDuration` where it would expire tokens immediately.
 */
export function validateTimespanString(
  value: unknown,
  options: { allowZero?: boolean } = {},
): string | null {
  const { allowZero = true } = options;

  const parsed = parseTimespan(value);
  if (!parsed) {
    return `must be a non-negative whole number (0–${MAX_TIMESPAN_VALUE}) followed by one of: ${TIMESPAN_UNITS.join(
      ", ",
    )} (e.g. "7 days")`;
  }

  if (!allowZero && parsed.value === 0) {
    return "must be greater than 0";
  }

  return null;
}

export function stringToTimespan(value: string): Timespan {
  // Fall back to a safe default instead of returning `{ value: NaN, unit:
  // undefined }` so historical/dirty values can never crash a caller.
  return parseTimespan(value) ?? { value: 0, unit: "days" };
}

export function timespanToString(timespan: Timespan) {
  return `${timespan.value} ${timespan.unit}`;
}
