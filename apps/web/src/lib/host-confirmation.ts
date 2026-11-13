import { assertWalletSuccess } from "./organizer-wallet.ts";

interface ConfirmationOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/** Read-only reconciliation. Never retry a wallet transaction after an uncertain reply. */
export async function waitForHostConfirmation<T>(read: () => Promise<T | null>, { timeoutMs = 20_000, intervalMs = 1500 }: ConfirmationOptions = {}): Promise<T | null> {
  const deadline = performance.now() + timeoutMs;
  do {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The SDK itself retries RPC failures. Bound the whole check even if a read stalls.
      const result = await Promise.race([
        read(),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now())); }),
      ]);
      if (result !== null) return result;
    } catch {
      // A failed read cannot prove that the wallet transaction failed.
    } finally { clearTimeout(timer); }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (performance.now() < deadline);
  return null;
}

/** A wallet can submit successfully and then throw when its popup closes. Trust the chain. */
export async function confirmHostWalletAction<T>(
  send: () => Promise<unknown>,
  read: (outcome: unknown) => Promise<T | null>,
  checking: () => void,
  options?: ConfirmationOptions,
): Promise<T> {
  let outcome: unknown;
  let walletError: unknown;
  let walletFailed = false;
  try { outcome = await send(); assertWalletSuccess(outcome); }
  catch (error) { walletFailed = true; walletError = error; }
  checking();
  const confirmed = await waitForHostConfirmation(() => read(outcome), options);
  if (confirmed !== null) return confirmed;
  if (walletFailed) throw walletError;
  throw new Error("The chain has not confirmed this action yet. Refresh before trying again.");
}
