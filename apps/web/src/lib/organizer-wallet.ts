import type { NearConnector } from "@hot-labs/near-connect";

export interface HostTransaction {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }[];
}

export interface OrganizerWallet {
  accountId: string;
  signAndSendTransaction(transaction: HostTransaction): Promise<unknown>;
}

declare global { interface Window { __BAIL_TEST_WALLET__?: OrganizerWallet } }

let connectorPromise: Promise<NearConnector> | undefined;
export function organizerConnector(): Promise<NearConnector> {
  connectorPromise ??= import("@hot-labs/near-connect").then(async ({ NearConnector }) => {
    const connector = new NearConnector({ network: "testnet" });
    await connector.whenManifestLoaded;
    return connector;
  }).catch((error) => { connectorPromise = undefined; throw error; });
  return connectorPromise;
}

export async function connectedOrganizer(connector: NearConnector): Promise<OrganizerWallet | null> {
  try {
    const { wallet, accounts } = await connector.getConnectedWallet();
    const accountId = accounts[0]?.accountId;
    return accountId ? { accountId, signAndSendTransaction: (transaction) => wallet.signAndSendTransaction({ ...transaction, network: "testnet", signerId: accountId }) } : null;
  } catch { return null; }
}

export function testOrganizerWallet(enabled: boolean, hostname: string): OrganizerWallet | null {
  if (!enabled || !["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return null;
  return window.__BAIL_TEST_WALLET__ ?? null;
}

export function hostTransaction(receiverId: string, methodName: string, args: Record<string, unknown>, tgas: number, deposit = "0"): HostTransaction {
  return { receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, gas: String(BigInt(tgas) * 10n ** 12n), deposit } }] };
}

export function assertWalletSuccess(outcome: unknown): void {
  const status = (outcome as { status?: unknown } | null)?.status;
  if (status && typeof status === "object" && "Failure" in status) throw new Error("The wallet transaction failed. Check its activity before trying again.");
}
