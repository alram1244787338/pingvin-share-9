/**
 * Standalone test script for date.util.ts
 * Run with: npx ts-node src/utils/date.util.test.ts
 */
import {
  isValidTimespan,
  stringToTimespan,
  timespanToString,
  parseRelativeDateToAbsolute,
  TIMESPAN_MAX_VALUE,
} from "./date.util";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function assertThrows(fn: () => any, message: string) {
  try {
    fn();
    failed++;
    console.error(`  ✗ FAIL (expected throw): ${message}`);
  } catch {
    passed++;
    console.log(`  ✓ ${message}`);
  }
}

console.log("\n=== isValidTimespan ===");

// Valid inputs
assert(isValidTimespan("0 days") === true, '"0 days" is valid (means never)');
assert(isValidTimespan("0 minutes") === true, '"0 minutes" is valid');
assert(isValidTimespan("7 days") === true, '"7 days" is valid');
assert(isValidTimespan("1 hours") === true, '"1 hours" is valid');
assert(isValidTimespan("30 minutes") === true, '"30 minutes" is valid');
assert(isValidTimespan("12 months") === true, '"12 months" is valid');
assert(isValidTimespan("3 weeks") === true, '"3 weeks" is valid');
assert(isValidTimespan("100 years") === true, '"100 years" is valid');
assert(
  isValidTimespan(`${TIMESPAN_MAX_VALUE} days`) === true,
  `max value ${TIMESPAN_MAX_VALUE} is valid`,
);

// Invalid inputs
assert(isValidTimespan("") === false, 'empty string is invalid');
assert(isValidTimespan("abc") === false, '"abc" is invalid');
assert(isValidTimespan("7") === false, '"7" alone is invalid');
assert(isValidTimespan("days") === false, '"days" alone is invalid');
assert(isValidTimespan("7 foos") === false, '"7 foos" has invalid unit');
assert(isValidTimespan("-1 days") === false, 'negative value is invalid');
assert(isValidTimespan("1.5 days") === false, 'float value is invalid');
assert(isValidTimespan(" 7 days") === false, 'leading space is invalid');
assert(isValidTimespan("7  days") === false, 'double space is invalid');
assert(isValidTimespan("7 days ") === false, 'trailing space is invalid');
assert(
  isValidTimespan(`${TIMESPAN_MAX_VALUE + 1} days`) === false,
  `value > ${TIMESPAN_MAX_VALUE} is invalid`,
);
assert(isValidTimespan(null as any) === false, 'null is invalid');
assert(isValidTimespan(undefined as any) === false, 'undefined is invalid');
assert(isValidTimespan(42 as any) === false, 'number is invalid');

console.log("\n=== stringToTimespan ===");

// Valid
{
  const result = stringToTimespan("7 days");
  assert(result.value === 7, '"7 days" parses to value 7');
  assert(result.unit === "days", '"7 days" parses to unit "days"');
}
{
  const result = stringToTimespan("0 minutes");
  assert(result.value === 0, '"0 minutes" parses to value 0');
  assert(result.unit === "minutes", '"0 minutes" parses to unit "minutes"');
}

// Invalid → fallback to { value: 0, unit: "days" }
{
  const result = stringToTimespan("garbage");
  assert(result.value === 0, '"garbage" falls back to value 0');
  assert(result.unit === "days", '"garbage" falls back to unit "days"');
}
{
  const result = stringToTimespan("");
  assert(result.value === 0, '"" falls back to value 0');
  assert(result.unit === "days", '"" falls back to unit "days"');
}
{
  const result = stringToTimespan(null as any);
  assert(result.value === 0, 'null falls back to value 0');
  assert(result.unit === "days", 'null falls back to unit "days"');
}
{
  const result = stringToTimespan("-5 days");
  assert(result.value === 0, '"-5 days" falls back to value 0');
  assert(result.unit === "days", '"-5 days" falls back to unit "days"');
}
{
  const result = stringToTimespan("7 foos");
  assert(result.value === 0, '"7 foos" falls back to value 0');
  assert(result.unit === "days", '"7 foos" falls back to unit "days"');
}

console.log("\n=== timespanToString ===");
assert(
  timespanToString({ value: 7, unit: "days" }) === "7 days",
  'roundtrip: { value: 7, unit: "days" } → "7 days"',
);
assert(
  timespanToString({ value: 0, unit: "minutes" }) === "0 minutes",
  'roundtrip: { value: 0, unit: "minutes" } → "0 minutes"',
);

console.log("\n=== parseRelativeDateToAbsolute ===");

// "never" should return epoch
{
  const result = parseRelativeDateToAbsolute("never");
  assert(
    result.getTime() === new Date(0).getTime(),
    '"never" returns epoch date',
  );
}

// Valid relative dates should not throw
{
  const result = parseRelativeDateToAbsolute("7-days");
  assert(result instanceof Date, '"7-days" returns a Date');
  assert(result.getTime() > Date.now(), '"7-days" is in the future');
}
{
  const result = parseRelativeDateToAbsolute("30-minutes");
  assert(result instanceof Date, '"30-minutes" returns a Date');
}

// Invalid inputs should throw
assertThrows(
  () => parseRelativeDateToAbsolute(""),
  'empty string throws',
);
assertThrows(
  () => parseRelativeDateToAbsolute("invalid"),
  '"invalid" throws (no dash separator)',
);
assertThrows(
  () => parseRelativeDateToAbsolute("abc-days"),
  '"abc-days" throws (non-numeric amount)',
);
assertThrows(
  () => parseRelativeDateToAbsolute("-1-days"),
  '"-1-days" throws (negative amount)',
);
assertThrows(
  () => parseRelativeDateToAbsolute("7-foos"),
  '"7-foos" throws (invalid unit)',
);
assertThrows(
  () => parseRelativeDateToAbsolute(null as any),
  'null throws',
);

console.log("\n=== Roundtrip: stringToTimespan ↔ timespanToString ===");
{
  const original = "3 months";
  const roundtrip = timespanToString(stringToTimespan(original));
  assert(roundtrip === original, `"${original}" roundtrips correctly`);
}
{
  const original = "0 days";
  const roundtrip = timespanToString(stringToTimespan(original));
  assert(roundtrip === original, `"${original}" roundtrips correctly`);
}
{
  const original = "59 minutes";
  const roundtrip = timespanToString(stringToTimespan(original));
  assert(roundtrip === original, `"${original}" roundtrips correctly`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
