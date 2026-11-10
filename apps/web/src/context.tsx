import { createContext, useContext } from "react";

import type { BailView, RelayerClient } from "@bail/sdk";

import type { ChainClock } from "./lib/clock.ts";
import type { AppConfig } from "./lib/config.ts";
import type { TicketStore } from "./lib/storage.ts";

export interface App {
  config: AppConfig;
  view: BailView;
  relayer: RelayerClient;
  clock: ChainClock;
  store: TicketStore;
}

export const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("the app context is missing");
  return app;
}
