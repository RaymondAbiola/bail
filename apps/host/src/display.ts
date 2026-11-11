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

export function at(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export interface ReadyView {
  slot: number;
  slots: number;
  windowMs: number;
  now: number;
  /** When the previous code's window has closed, so this one may open. */
  earliest: number;
  /** Open by then and every later code still fits. */
  roomBy: number;
  /** After this the code can't open at all. */
  lastChance: number;
}

const later = (slot: number, slots: number) =>
  slots - slot === 2 ? `code ${slots}` : slots - slot === 3 ? `codes ${slot + 2} and ${slots}` : `codes ${slot + 2} to ${slots}`;

/**
 * Between codes, while the host decides. Nothing opens until the host presses Enter, so a
 * code never goes live while nobody is watching. Waiting too long only voids later codes,
 * which lowers what everyone needs and never costs an attendee.
 */
export function renderReady(v: ReadyView, color = true): string {
  const style = (on: string, text: string) => (color ? `${on}${text}${RESET}` : text);
  const minutes = Math.round(v.windowMs / 60_000);
  const last = v.slot === v.slots - 1;
  const lines = ["", style(BOLD, `NEXT: CODE ${v.slot + 1} OF ${v.slots}`), "", `Press Enter when you want it. Attendees then have ${minutes} minutes to enter it.`];
  if (v.earliest > v.now) {
    lines.push(
      v.slot === 0
        ? `Check-in opens at ${at(v.earliest)}. If you press Enter before then, it opens at that moment.`
        : `Code ${v.slot}'s window closes at ${at(v.earliest)}. If you press Enter before then, it opens at that moment.`,
    );
  }
  if (last) lines.push(`Open it by ${at(v.lastChance)}, or it can't open and is void.`);
  else if (v.now < v.roomBy) lines.push(`Open it by ${at(v.roomBy)} to leave room for ${later(v.slot, v.slots)}.`);
  else lines.push(`It's past ${at(v.roomBy)}, so ${later(v.slot, v.slots)} may not fit. A code that can't open is void, which only lowers what everyone needs.`);
  lines.push("");
  const deadline = !last && v.now < v.roomBy ? v.roomBy : v.lastChance;
  lines.push(`Time left: ${clock(deadline - v.now)}`);
  return lines.join("\n");
}

/** The host pressed Enter while the previous code's window was still open. */
export function renderOpeningSoon(slot: number, slots: number, msLeft: number, color = true): string {
  const style = (on: string, text: string) => (color ? `${on}${text}${RESET}` : text);
  return [
    "",
    style(BOLD, `CODE ${slot + 1} OF ${slots} OPENS AS SOON AS IT CAN`),
    "",
    slot === 0 ? "Check-in hasn't opened yet." : `Code ${slot}'s window is still open, and codes can't overlap.`,
    "",
    `Opens in ${clock(msLeft)}`,
  ].join("\n");
}

export function renderWaiting(slot: number, slots: number): string {
  return `\n  Waiting for code ${slot + 1} of ${slots}. It will open at a random moment.`;
}
