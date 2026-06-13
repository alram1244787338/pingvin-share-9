import moment from "moment";
import { Timespan, TimeUnit } from "../types/timespan.type";

const VALID_TIMESPAN_UNITS: TimeUnit[] = [
  "minutes",
  "hours",
  "days",
  "weeks",
  "months",
  "years",
];

const TIMESPAN_MAX_VALUE = 999999;

/**
 * Validate whether a given string conforms to a valid timespan format.
 * Valid format: "<non-negative integer> <unit>" where unit is one of
 * minutes, hours, days, weeks, months, years.
 */
export const isValidTimespan = (value: string): boolean => {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d+) ([a-z]+)$/);
  if (!match) return false;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (isNaN(num) || num < 0 || num > TIMESPAN_MAX_VALUE) return false;
  if (!VALID_TIMESPAN_UNITS.includes(unit as TimeUnit)) return false;
  return true;
};

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

  const parts = value.split("-");
  const amount = parseInt(parts[0], 10);
  const unit = parts.slice(1).join("-") as moment.unitOfTime.DurationConstructor;

  if (isNaN(amount) || amount < 0) return messages.neverExpires;

  const expirationDate = moment().add(amount, unit).toDate();

  return messages.expiresOn.replace(
    "{expiration}",
    moment(expirationDate).format("LLL"),
  );
};

export const timespanToString = (timespan: Timespan) => {
  return `${timespan.value} ${timespan.unit}`;
};

/**
 * Parse a timespan string like "7 days" into a Timespan object.
 * For dirty/malformed data, falls back to { value: 0, unit: "days" } (never).
 */
export const stringToTimespan = (value: string): Timespan => {
  const fallback: Timespan = { value: 0, unit: "days" };

  if (!value || typeof value !== "string") return fallback;

  const parts = value.trim().split(" ");
  if (parts.length !== 2) return fallback;

  const num = parseInt(parts[0], 10);
  const unit = parts[1] as TimeUnit;

  if (isNaN(num) || num < 0 || num > TIMESPAN_MAX_VALUE) return fallback;
  if (!VALID_TIMESPAN_UNITS.includes(unit)) return fallback;

  return { value: num, unit };
};
