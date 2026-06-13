import moment from "moment";
import { TimeUnit, Timespan } from "../types/timespan.type";

export const getExpirationPreview = (
  messages: {
    neverExpires: string;
    expiresOn: string;
  },
  form: {
    values: {
      never_expires?: boolean;
      expiration_num: number;
      expiration_unit: string;
    };
  },
) => {
  const value = form.values.never_expires
    ? "never"
    : form.values.expiration_num + form.values.expiration_unit;
  if (value === "never") return messages.neverExpires;

  const expirationDate = moment()
    .add(
      value.split("-")[0],
      value.split("-")[1] as moment.unitOfTime.DurationConstructor,
    )
    .toDate();

  return messages.expiresOn.replace(
    "{expiration}",
    moment(expirationDate).format("LLL"),
  );
};

/**
 * Units a timespan may use. Kept in sync with the backend `TIMESPAN_UNITS`
 * and the `TimeUnit` type.
 */
export const TIMESPAN_UNITS: TimeUnit[] = [
  "minutes",
  "hours",
  "days",
  "weeks",
  "months",
  "years",
];

/**
 * Upper bound for a timespan amount, matching the backend `MAX_TIMESPAN_VALUE`
 * and used as the `max` of `TimespanInput` so the picker can never produce a
 * value the backend would reject.
 */
export const MAX_TIMESPAN_VALUE = 100000;

export const timespanToString = (timespan: Timespan) => {
  return `${timespan.value} ${timespan.unit}`;
};

/**
 * Strictly parses a timespan string (e.g. `"7 days"`), returning `null` for
 * anything that isn't a non-negative whole number followed by a known unit.
 */
export const parseTimespan = (value: unknown): Timespan | null => {
  if (typeof value !== "string") return null;

  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) return null;

  const [time, unit] = parts;
  if (!/^\d+$/.test(time)) return null;

  const num = parseInt(time, 10);
  if (!Number.isInteger(num) || num < 0 || num > MAX_TIMESPAN_VALUE)
    return null;

  if (!TIMESPAN_UNITS.includes(unit as TimeUnit)) return null;

  return { value: num, unit: unit as TimeUnit };
};

export const stringToTimespan = (value: string): Timespan => {
  // Fall back to a safe default instead of `{ value: NaN, unit: undefined }`
  // so historical / dirty config values can't crash the config page or the
  // upload flow that reads `share.maxExpiration`.
  return parseTimespan(value) ?? { value: 0, unit: "days" };
};
