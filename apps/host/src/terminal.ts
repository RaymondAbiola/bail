export interface Writer {
  write(chunk: string): unknown;
}

/**
 * Paints frames on a terminal. On a real terminal it uses the alternate screen, so the
 * once-a-second countdown never fills the scrollback with copies of the code, and it
 * redraws only the last line when nothing else changed, so text selected in the window
 * isn't cleared while the host copies the code.
 */
export interface KeyInput {
  isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  on(event: "data", listener: (data: Buffer | string) => void): unknown;
  off(event: "data", listener: (data: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Enter presses, one at a time. A press only counts once someone is waiting for it, so
 * pressing Enter twice by accident can't open two codes. Raw mode keeps the key from
 * echoing onto the screen; Ctrl+C still stops the console.
 */
export class EnterKey {
  readonly #input: KeyInput;
  readonly #listener: (data: Buffer | string) => void;
  #waiting: (() => void) | null = null;

  constructor(input: KeyInput = process.stdin, onInterrupt: () => void = () => process.kill(process.pid, "SIGINT")) {
    this.#input = input;
    this.#listener = (data) => {
      const text = data.toString();
      if (text.includes("\x03")) return onInterrupt();
      if ((text.includes("\r") || text.includes("\n")) && this.#waiting) {
        const resolve = this.#waiting;
        this.#waiting = null;
        resolve();
      }
    };
    if (input.isTTY) input.setRawMode?.(true);
    input.on("data", this.#listener);
    input.resume();
  }

  /** Resolves on the next Enter. */
  next(): Promise<void> {
    return new Promise((resolve) => (this.#waiting = resolve));
  }

  close(): void {
    this.#input.off("data", this.#listener);
    if (this.#input.isTTY) this.#input.setRawMode?.(false);
    this.#input.pause();
  }
}

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
