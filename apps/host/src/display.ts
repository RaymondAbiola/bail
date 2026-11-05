const BOLD = "\x1b[1m";
const INVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The code as large as a terminal allows, for screen share or reading aloud. */
export function renderCode(code: string, slot: number, slots: number, msLeft: number, color = true): string {
  const words = code.toUpperCase().split(" ").map((w) => ` ${w.split("").join(" ")} `);
  const width = Math.max(...words.map((w) => w.length), 24) + 4;
  const line = (text: string) => `  ${text.padEnd(width)}`;
  const highlight = (text: string) => (color ? `${BOLD}${INVERSE}${line(text)}${RESET}` : line(text));
  return [
    "",
    line(`CODE ${slot + 1} OF ${slots}`),
    highlight(""),
    ...words.map(highlight),
    highlight(""),
    line(`Type it into Bail now. Closes in ${clock(msLeft)}`),
    "",
  ].join("\n");
}

export function renderWaiting(slot: number, slots: number): string {
  return `\n  Waiting for code ${slot + 1} of ${slots}. Stay on the call: it can appear at any moment.\n`;
}

export { clock };
