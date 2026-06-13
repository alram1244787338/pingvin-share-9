import { useState } from "react";
import { Timespan } from "../../types/timespan.type";
import { NativeSelect, NumberInput } from "@mantine/core";
import useTranslate from "../../hooks/useTranslate.hook";

const VALID_UNITS: Timespan["unit"][] = [
  "minutes",
  "hours",
  "days",
  "weeks",
  "months",
  "years",
];

const TimespanInput = ({
  label,
  value,
  onChange,
  ...restProps
}: {
  label?: string;
  value: Timespan;
  onChange: (timespan: Timespan) => void;
  [key: string]: any;
}) => {
  // Sanitize incoming value: if unit is invalid, default to "days"
  const sanitizedValue: Timespan = {
    value:
      value &&
      typeof value.value === "number" &&
      !isNaN(value.value) &&
      value.value >= 0
        ? value.value
        : 0,
    unit:
      value && VALID_UNITS.includes(value.unit) ? value.unit : ("days" as const),
  };

  const [unit, setUnit] = useState(sanitizedValue.unit);
  const [inputValue, setInputValue] = useState(sanitizedValue.value);
  const t = useTranslate();

  const version = inputValue == 1 ? "singular" : "plural";
  const unitSelect = (
    <NativeSelect
      data={[
        {
          value: "minutes",
          label: t(`upload.modal.expires.minute-${version}`),
        },
        {
          value: "hours",
          label: t(`upload.modal.expires.hour-${version}`),
        },
        {
          value: "days",
          label: t(`upload.modal.expires.day-${version}`),
        },
        {
          value: "weeks",
          label: t(`upload.modal.expires.week-${version}`),
        },
        {
          value: "months",
          label: t(`upload.modal.expires.month-${version}`),
        },
        {
          value: "years",
          label: t(`upload.modal.expires.year-${version}`),
        },
      ]}
      value={unit}
      rightSectionWidth={28}
      styles={{
        input: {
          fontWeight: 500,
          borderTopLeftRadius: 0,
          borderBottomLeftRadius: 0,
          width: 120,
          marginRight: -2,
        },
      }}
      onChange={(event) => {
        const newUnit = event.currentTarget.value as Timespan["unit"];
        if (!VALID_UNITS.includes(newUnit)) return;
        setUnit(newUnit);
        onChange({ value: inputValue, unit: newUnit });
      }}
    />
  );

  return (
    <NumberInput
      label={label}
      value={inputValue}
      min={0}
      max={999999}
      precision={0}
      rightSection={unitSelect}
      rightSectionWidth={120}
      onChange={(value) => {
        const inputVal =
          typeof value === "number" && !isNaN(value) && value >= 0
            ? Math.min(value, 999999)
            : 0;
        setInputValue(inputVal);
        onChange({ value: inputVal, unit });
      }}
      {...restProps}
    />
  );
};

export default TimespanInput;
