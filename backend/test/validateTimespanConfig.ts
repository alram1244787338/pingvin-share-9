/**
 * Executable validation for the timespan config rules.
 *
 * There is no jest setup in this project (only newman system tests), so this is
 * a self-contained, runnable check:
 *
 *     npm run test:config
 *
 * It exercises the real `ConfigService.validateConfigVariable`, the strict
 * `parseTimespan`/`validateTimespanString` helpers, and the invariant that
 * every value these helpers accept can actually be fed into
 * `moment().add(value, unit)` (the call every consumer makes — share creation,
 * reverse shares, session renewal).
 *
 * When a new `timespan` config variable is added, run this to confirm the old
 * rules still hold. Exits non-zero on the first set of failures.
 */
import * as moment from "moment";
import { ConfigService } from "src/config/config.service";
import {
  MAX_TIMESPAN_VALUE,
  TIMESPAN_UNITS,
  parseTimespan,
  validateTimespanString,
} from "src/utils/date.util";

let passed = 0;
const failures: string[] = [];

function check(description: string, condition: boolean) {
  if (condition) {
    passed++;
  } else {
    failures.push(description);
  }
}

function expectThrows(description: string, fn: () => void) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(`${description} (should be rejected)`, threw);
}

function expectOk(description: string, fn: () => void) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
  }
  check(`${description} (should be accepted)`, !threw);
}

// `validateConfigVariable` is a pure method — it never touches the injected
// dependencies, so a stub instance is enough.
const config = new ConfigService([] as any, null as any);

// ---------------------------------------------------------------------------
// 1. parseTimespan: strict format parsing
// ---------------------------------------------------------------------------
const validParses: Array<[string, number, string]> = [
  ["7 days", 7, "days"],
  ["0 days", 0, "days"],
  ["1 minutes", 1, "minutes"],
  ["3 months", 3, "months"],
  [`${MAX_TIMESPAN_VALUE} years`, MAX_TIMESPAN_VALUE, "years"],
  ["  5   weeks  ", 5, "weeks"], // tolerant of surrounding/extra whitespace
];
for (const [input, value, unit] of validParses) {
  const parsed = parseTimespan(input);
  check(
    `parseTimespan("${input}") -> { ${value}, ${unit} }`,
    !!parsed && parsed.value === value && parsed.unit === (unit as any),
  );
}

const invalidParses = [
  "",
  " ",
  "-5 days", // negative
  "1.5 days", // decimal
  "+7 days", // sign
  "abc days", // not a number
  "7", // missing unit
  "days", // missing number
  "7 days extra", // trailing garbage
  "7 fortnights", // unknown unit
  "7 Days", // wrong case
  "7days", // missing separator
  `${MAX_TIMESPAN_VALUE + 1} days`, // over the maximum
  "99999999999 days", // way over the maximum
  null,
  undefined,
  42,
];
for (const input of invalidParses) {
  check(
    `parseTimespan(${JSON.stringify(input)}) -> null`,
    parseTimespan(input as any) === null,
  );
}

// ---------------------------------------------------------------------------
// 2. validateTimespanString: zero policy
// ---------------------------------------------------------------------------
check(
  'validateTimespanString("0 days", { allowZero: true }) accepts',
  validateTimespanString("0 days", { allowZero: true }) === null,
);
check(
  'validateTimespanString("0 days", { allowZero: false }) rejects',
  validateTimespanString("0 days", { allowZero: false }) !== null,
);
check(
  'validateTimespanString("1 minutes", { allowZero: false }) accepts',
  validateTimespanString("1 minutes", { allowZero: false }) === null,
);
check(
  'validateTimespanString("garbage") rejects with a message',
  typeof validateTimespanString("garbage") === "string",
);

// ---------------------------------------------------------------------------
// 3. ConfigService.validateConfigVariable: real config policy
// ---------------------------------------------------------------------------

// share.maxExpiration — 0 means "no maximum", so 0 is valid here.
expectOk('maxExpiration "0 days" (never)', () =>
  config.validateConfigVariable("share.maxExpiration", "0 days", "timespan"),
);
expectOk('maxExpiration "7 days"', () =>
  config.validateConfigVariable("share.maxExpiration", "7 days", "timespan"),
);
expectOk("maxExpiration null (reset to default)", () =>
  config.validateConfigVariable("share.maxExpiration", null, "timespan"),
);
for (const bad of [
  "-5 days",
  "abc days",
  "7 fortnights",
  "7",
  "1.5 days",
  `${MAX_TIMESPAN_VALUE + 1} days`,
  "",
]) {
  expectThrows(`maxExpiration "${bad}"`, () =>
    config.validateConfigVariable("share.maxExpiration", bad, "timespan"),
  );
}

// general.sessionDuration — 0 would expire every session immediately, so it
// must be strictly positive.
expectOk('sessionDuration "3 months"', () =>
  config.validateConfigVariable(
    "general.sessionDuration",
    "3 months",
    "timespan",
  ),
);
expectOk('sessionDuration "1 minutes"', () =>
  config.validateConfigVariable(
    "general.sessionDuration",
    "1 minutes",
    "timespan",
  ),
);
expectThrows('sessionDuration "0 days" (instant logout)', () =>
  config.validateConfigVariable(
    "general.sessionDuration",
    "0 days",
    "timespan",
  ),
);
expectThrows('sessionDuration "0 minutes"', () =>
  config.validateConfigVariable(
    "general.sessionDuration",
    "0 minutes",
    "timespan",
  ),
);
for (const bad of ["-1 days", "soon", "5"]) {
  expectThrows(`sessionDuration "${bad}"`, () =>
    config.validateConfigVariable("general.sessionDuration", bad, "timespan"),
  );
}

// Timespan rules must apply even when the type isn't passed (known keys).
expectThrows("sessionDuration bad value without explicit type", () =>
  config.validateConfigVariable("general.sessionDuration", "0 days"),
);

// Pre-existing non-timespan validations must still work.
expectOk("shareIdLength 8", () =>
  config.validateConfigVariable("share.shareIdLength", 8, "number"),
);
expectThrows("shareIdLength 1 (below minimum)", () =>
  config.validateConfigVariable("share.shareIdLength", 1, "number"),
);

// ---------------------------------------------------------------------------
// 4. Consumption invariant: anything accepted must be safe for moment().add()
// ---------------------------------------------------------------------------
const now = moment("2026-01-01T00:00:00.000Z");
for (const unit of TIMESPAN_UNITS) {
  for (const value of [0, 1, 7, MAX_TIMESPAN_VALUE]) {
    const parsed = parseTimespan(`${value} ${unit}`);
    const date = moment(now).add(parsed!.value, parsed!.unit);
    check(
      `moment().add(${value}, ${unit}) is a valid date`,
      date.isValid() && !date.isBefore(now),
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log(`✓ All ${passed} timespan config checks passed.`);
  process.exit(0);
} else {
  console.error(`✓ ${passed} passed, ✗ ${failures.length} failed:\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
