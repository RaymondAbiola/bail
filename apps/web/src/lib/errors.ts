export type ErrorKind = "network" | "rate-limit" | "refused" | "missing" | "unknown";

export interface Described {
  kind: ErrorKind;
  /** Plain words, safe to show as text. */
  message: string;
}

/**
 * The relayer and contract speak in short plain sentences, so they are shown as they come.
 * Only the failures that never reached the relayer, or carry no sentence, get our own words.
 */
export function describeError(error: unknown): Described {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return { kind: "network", message: "Bail's relayer isn't running right now, so this can't be sent. Results and public records still work." };
  }
  if (/too many|429|rate limit/i.test(message)) {
    return { kind: "rate-limit", message: `${cleanSentence(message)} Wait a moment before trying again.` };
  }
  if (/no such ticket|no such event/i.test(message)) return { kind: "missing", message: cleanSentence(message) };
  if (message) return { kind: "refused", message: cleanSentence(message) };
  return { kind: "unknown", message: "Something went wrong. Try again." };
}

function cleanSentence(message: string): string {
  const text = message.trim().replace(/^Smart contract panicked: /, "");
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
