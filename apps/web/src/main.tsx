import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { BailView, RelayerClient } from "@bail/sdk";

import { App } from "./App.tsx";
import { AppContext } from "./context.tsx";
import { ChainClock } from "./lib/clock.ts";
import { ConfigError, loadConfig } from "./lib/config.ts";
import { TicketStore, browserStorage } from "./lib/storage.ts";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

function Setup({ message }: { message: string }) {
  return (
    <div className="page">
      <section className="card" role="alert">
        <h1>This site is not set up yet</h1>
        <p>{message}</p>
        <p className="muted small">
          The site reads <code>config.json</code> next to it. It needs at least <code>relayerUrl</code>, the address of the Bail relayer. See apps/web/README.md.
        </p>
      </section>
    </div>
  );
}

loadConfig().then(
  (config) => {
    const view = new BailView({ contractId: config.contractId, rpcUrl: config.rpcUrl, fallbackUrls: config.fallbackUrls });
    const app = {
      config,
      view,
      relayer: new RelayerClient(config.relayerUrl),
      clock: new ChainClock(view),
      store: new TicketStore(browserStorage()),
    };
    root.render(
      <StrictMode>
        <AppContext.Provider value={app}>
          <App />
        </AppContext.Provider>
      </StrictMode>,
    );
  },
  (error: unknown) => {
    root.render(<Setup message={error instanceof ConfigError ? error.message : "The configuration could not be read."} />);
  },
);
