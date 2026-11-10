import { TESTNET } from "@bail/sdk";

export interface EventMeta {
  title?: string;
  description?: string;
  callUrl?: string;
}

export interface AppConfig {
  relayerUrl: string;
  contractId: string;
  rpcUrl: string;
  fallbackUrls: string[];
  token: string;
  /** Block explorer base, such as https://testnet.nearblocks.io. Links appear only if set. */
  explorerUrl: string | null;
  defaultEventId: number | null;
  /** Titles, descriptions and call links the deployer vouches for. The contract stores none. */
  events: Record<string, EventMeta>;
}

export class ConfigError extends Error {}

function httpUrl(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ConfigError(`${name} is not set`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a web address: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError(`${name} must be http or https`);
  return value.replace(/\/+$/, "");
}

/** Validates a parsed config.json, filling anything left out from the testnet defaults. */
export function parseConfig(raw: unknown): AppConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const event = c.defaultEventId;
  const events = (c.events ?? {}) as Record<string, EventMeta>;
  const explorer = c.explorerUrl;
  return {
    relayerUrl: httpUrl(c.relayerUrl, "relayerUrl"),
    contractId: typeof c.contractId === "string" ? c.contractId : TESTNET.contractId,
    rpcUrl: c.rpcUrl === undefined ? TESTNET.rpcUrl : httpUrl(c.rpcUrl, "rpcUrl"),
    fallbackUrls: Array.isArray(c.fallbackUrls)
      ? c.fallbackUrls.map((u) => httpUrl(u, "fallbackUrls"))
      : c.rpcUrl === undefined
        ? [...TESTNET.fallbackUrls]
        : [],
    token: typeof c.token === "string" ? c.token : TESTNET.token,
    explorerUrl: typeof explorer === "string" && explorer ? httpUrl(explorer, "explorerUrl") : null,
    defaultEventId: typeof event === "number" && Number.isInteger(event) && event >= 0 ? event : null,
    events,
  };
}

export async function loadConfig(url = "./config.json"): Promise<AppConfig> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new ConfigError("config.json could not be loaded");
  }
  if (!response.ok) throw new ConfigError(`config.json answered ${response.status}`);
  try {
    return parseConfig(await response.json());
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("config.json is not valid JSON");
  }
}
