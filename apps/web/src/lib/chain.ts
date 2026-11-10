import type { BailView } from "@bail/sdk";

/** A fungible token balance in base units. Read through the SDK's RPC so it fails over too. */
export async function tokenBalance(view: BailView, token: string, accountId: string): Promise<bigint> {
  const reply = await view.rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: token,
    method_name: "ft_balance_of",
    args_base64: btoa(JSON.stringify({ account_id: accountId })),
  });
  return BigInt(JSON.parse(new TextDecoder().decode(Uint8Array.from(reply.result))) as string);
}
