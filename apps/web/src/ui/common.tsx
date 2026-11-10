import { useCallback, useRef, useState, type ReactNode } from "react";

import { useApp } from "../context.tsx";
import { type Described, describeError } from "../lib/errors.ts";

export function Notice({ tone, title, children }: { tone: "good" | "wait" | "bad" | "info"; title?: string; children?: ReactNode }) {
  const label = { good: "Good news", wait: "Please note", bad: "Problem", info: "" }[tone];
  return (
    <div className={`notice ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {(title || label) && <strong>{title ?? label}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

export function Skeleton({ block = false, label = "Loading" }: { block?: boolean; label?: string }) {
  return (
    <div role="status" aria-label={label}>
      <div className={`skeleton${block ? " block" : ""}`} />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

const whenFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });

/** A full, unambiguous local date and time with the timezone name. */
export function formatWhen(ms: number): string {
  return whenFormat.format(ms);
}

export function formatClock(ms: number): string {
  return timeFormat.format(ms);
}

/** m:ss, or h:mm:ss for longer waits. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** "in 2 hours", for the wait before check-in opens. */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} seconds`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} min` : ""}`;
  return `${Math.round(hours / 24)} days`;
}

export function TxLink({ tx, label = "View transaction" }: { tx?: string | null; label?: string }) {
  const { config } = useApp();
  if (!tx || !config.explorerUrl) return null;
  return (
    <a href={`${config.explorerUrl}/txns/${encodeURIComponent(tx)}`} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

export function ContractLink({ account, label }: { account: string; label?: string }) {
  const { config } = useApp();
  if (!config.explorerUrl) return <span>{label ?? account}</span>;
  return (
    <a href={`${config.explorerUrl}/address/${encodeURIComponent(account)}`} target="_blank" rel="noreferrer">
      {label ?? account}
    </a>
  );
}

/** Copies with the clipboard API, falling back to selecting a hidden field for older phones. */
export function CopyButton({ text, label = "Copy", done = "Copied", className = "btn" }: { text: string; label?: string; done?: string; className?: string }) {
  const [copied, setCopied] = useState<"idle" | "yes" | "no">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      setCopied(ok ? "yes" : "no");
    }
    setTimeout(() => setCopied("idle"), 2500);
  };
  return (
    <button type="button" className={className} onClick={copy}>
      {copied === "yes" ? done : copied === "no" ? "Copy failed, select it by hand" : label}
    </button>
  );
}

export interface ActionState {
  pending: boolean;
  error: Described | null;
  done: boolean;
}

/** Runs one user action at a time, so a double tap can't send twice. */
export function useAction<A extends unknown[], R>(action: (...args: A) => Promise<R>) {
  const [state, setState] = useState<ActionState>({ pending: false, error: null, done: false });
  const busy = useRef(false);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      if (busy.current) return undefined;
      busy.current = true;
      setState({ pending: true, error: null, done: false });
      try {
        const result = await action(...args);
        setState({ pending: false, error: null, done: true });
        return result;
      } catch (error) {
        setState({ pending: false, error: describeError(error), done: false });
        return undefined;
      } finally {
        busy.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [action],
  );
  return { ...state, run, reset: () => setState({ pending: false, error: null, done: false }) };
}
