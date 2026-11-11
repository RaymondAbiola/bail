const BOLD = "\x1b[1m";
const GREEN = "\x1b[92m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The live code for screen share and for copying. The code sits alone on its own line,
 * with no indent, no letter spacing and nothing after it, so selecting that line copies
 * exactly the words and nothing else. Zoom the terminal to make it as large as needed.
 * The last line is the countdown, so a terminal can update just that line in place.
 */
export function renderCode(code: string, slot: number, slots: number, msLeft: number, color = true, note?: string): string {
  const style = (on: string, text: string) => (color ? `${on}${text}${RESET}` : text);
  return [
    "",
    style(BOLD, `CODE ${slot + 1} OF ${slots} IS LIVE`),
    "",
    style(BOLD + GREEN, code),
    "",
    style(DIM, note ?? "Attendees type this into Bail. Capitals and spacing do not matter."),
    `Closes in ${clock(msLeft)}`,
  ].join("\n");
}

export function renderWaiting(slot: number, slots: number): string {
  return `\n  Waiting for code ${slot + 1} of ${slots}. It will open at a random moment.`;
}
