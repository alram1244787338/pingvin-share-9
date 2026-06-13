import * as moment from "moment";

export const VALID_TIMESPAN_UNITS = [
  "minutes",
  "hours",
  "days",
  "weeks",
  "months",
  "years",
] as const;

export type TimespanUnit = (typeof VALID_TIMESPAN_UNITS)[number];

export type Timespan = {
  value: number;
  unit: TimespanUnit;
};

/**
 * Maximum allowed numeric value for a timespan.
 * 999999 years is well beyond any realistic use and prevents moment overflow.
 */
export const TIMESPAN_MAX_VALUE = 999999;

/**
 * Validate whether a given string conforms to a valid timespan format.
 * Valid format: "<non-negative integer> <unit>" where unit is one of
 * minutes, hours, days, weeks, months, years.
 *
 * "0 days" (or any unit with value 0) is treated as "never" by business logic.
 */
export function isValidTimespan(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d+) ([a-z]+)$/);
  if (!match) return false;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (isNaN(num) || num < 0 || num > TIMESPAN_MAX_VALUE) return false;
  if (!VALID_TIMESPAN_UNITS.includes(unit as TimespanUnit)) return false;
  return true;
}

/**
 * Parse a relative date string like "7-days" or "never" into an absolute Date.
 * Returns epoch (1970-01-01) for "never", representing no expiration.
 * Throws BadRequestException-style error for invalid input.
 */
export function parseRelativeDateToAbsolute(relativeDate: string): Date {
  if (!relativeDate || typeof relativeDate !== "string") {
    throw new Error("Invalid relative date: empty or non-string value");
  }

  if (relativeDate === "never") return moment(0).toDate();

  const parts = relativeDate.split("-");
  if (parts.length < 2) {
    throw new Error(`Invalid relative date format: "${relativeDate}"`);
  }

  const amount = parseInt(parts[0], 10);
  const unit = parts.slice(1).join("-") as moment.unitOfTime.DurationConstructor;

  if (isNaN(amount) || amount < 0) {
    throw new Error(`Invalid relative date amount: "${parts[0]}"`);
  }

  const validUnits: moment.unitOfTime.DurationConstructor[] = [
    "minutes",
    "hours",
    "days",
    "weeks",
    "months",
    "years",
  ];
  if (!validUnits.includes(unit)) {
    throw new Error(`Invalid relative date unit: "${unit}"`);
  }

  return moment().add(amount, unit).toDate();
}

/**
 * Parse a timespan string like "7 days" into a Timespan object.
 * For dirty/malformed data, falls back to { value: 0, unit: "days" } (never).
 */
export function stringToTimespan(value: string): Timespan {
  const fallback: Timespan = { value: 0, unit: "days" };

  if (!value || typeof value !== "string") return fallback;

  const parts = value.trim().split(" ");
  if (parts.length !== 2) return fallback;

  const num = parseInt(parts[0], 10);
  const unit = parts[1] as TimespanUnit;

  if (isNaN(num) || num < 0 || num > TIMESPAN_MAX_VALUE) return fallback;
  if (!VALID_TIMESPAN_UNITS.includes(unit)) return fallback;

  return { value: num, unit };
}

/**
 * Convert a Timespan object back to its string representation.
 */
export function timespanToString(timespan: Timespan): string {
  return `${timespan.value} ${timespan.unit}`;
}
