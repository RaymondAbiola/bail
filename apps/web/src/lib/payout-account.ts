import { type BailView, isPayoutAddress } from "@bail/sdk";

export type PayoutAccountCheck =
  | { ok: true }
  | { ok: false; kind: "invalid" | "missing" | "unavailable"; message: string; suggestion?: string };

async function accountExists(view: Pick<BailView, "rpc">, accountId: string): Promise<boolean> {
  try {
    await view.rpc("query", { request_type: "view_account", account_id: accountId, finality: "final" });
    return true;
  } catch (error) {
    if (error instanceof Error && /\bUNKNOWN_ACCOUNT\b/.test(error.message)) return false;
    throw error;
  }
}

export async function checkPayoutAccount(view: Pick<BailView, "rpc">, payoutTo: string): Promise<PayoutAccountCheck> {
  if (!payoutTo.startsWith("near:") || !isPayoutAddress(payoutTo, { intents: false })) {
    return { ok: false, kind: "invalid", message: "Enter a valid NEAR testnet account name." };
  }
  const account = payoutTo.slice(5);
  if (/^[0-9a-f]{64}$/.test(account)) return { ok: true };
  try {
    if (await accountExists(view, account)) return { ok: true };
  } catch {
    return { ok: false, kind: "unavailable", message: "Could not check this NEAR account. Try again before continuing." };
  }

  const candidate = `${account}.testnet`;
  let suggestion: string | undefined;
  if (!account.includes(".") && isPayoutAddress(`near:${candidate}`, { intents: false })) {
    try {
      if (await accountExists(view, candidate)) suggestion = candidate;
    } catch {
      // The original account is missing; an unverified suggestion must not be offered.
    }
  }
  return {
    ok: false,
    kind: "missing",
    message: `There is no NEAR account called ${account}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
    ...(suggestion ? { suggestion } : {}),
  };
}
