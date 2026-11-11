export function requiredCodes(required: number, slots: number): string {
  if (required === slots) return slots === 1 ? "the only code" : `all ${slots} codes`;
  return `${required} of ${slots} codes`;
}

export const STAY_UNTIL_END = "Stay until the end of the call. The host decides when each code appears, and the last one may come right at the end.";
