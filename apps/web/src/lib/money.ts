const DECIMALS = 6;

/** Integer base units to a decimal string with no floating point: 1500000 -> "1.5". */
export function formatUnits(units: bigint | string, decimals = DECIMALS): string {
  const value = BigInt(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString();
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function formatUsdc(units: bigint | string): string {
  return `${formatUnits(units)} test USDC`;
}

/** The deposit plus the bonus per attendee, as an attendee would be paid. */
export function sumUnits(...parts: (bigint | string)[]): bigint {
  return parts.reduce<bigint>((total, part) => total + BigInt(part), 0n);
}
