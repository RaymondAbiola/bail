export interface Writer {
  write(chunk: string): unknown;
}

/**
 * Paints frames on a terminal. On a real terminal it uses the alternate screen, so the
 * once-a-second countdown never fills the scrollback with copies of the code, and it
 * redraws only the last line when nothing else changed, so text selected in the window
 * isn't cleared while the host copies the code.
 */
export class TerminalScreen {
  readonly #out: Writer;
  readonly #tty: boolean;
  #last: string[] = [];
  #open = false;

  constructor(out: Writer = process.stdout, tty = !!process.stdout.isTTY) {
    this.#out = out;
    this.#tty = tty;
  }

  show(frame: string): void {
    const lines = frame.split("\n");
    const sameBody =
      lines.length === this.#last.length && lines.slice(0, -1).every((line, i) => line === this.#last[i]);
    if (!this.#tty) {
      // Piped output: print a frame only when something other than the countdown changed.
      if (!sameBody) this.#out.write(`${frame}\n`);
      this.#last = lines;
      return;
    }
    if (!this.#open) {
      this.#out.write("\x1b[?1049h");
      this.#open = true;
    }
    if (sameBody) this.#out.write(`\r\x1b[2K${lines[lines.length - 1]}`);
    else this.#out.write(`\x1b[2J\x1b[H${frame}`);
    this.#last = lines;
  }

  /** Back to the normal screen, then a plain summary that stays in the scrollback. */
  close(summary?: string): void {
    if (this.#open) this.#out.write("\x1b[?1049l");
    this.#open = false;
    if (summary) this.#out.write(`${summary}\n`);
  }
}
