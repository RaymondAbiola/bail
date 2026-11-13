import { Component, type ReactNode, Suspense, lazy, useEffect } from "react";

import { useApp } from "./context.tsx";
import { useRoute } from "./hooks.ts";
import { ContractLink, Skeleton } from "./ui/common.tsx";
import { EventPage } from "./ui/EventPage.tsx";
import { Home } from "./ui/Home.tsx";

const Hosting = lazy(() => import("./ui/Hosting.tsx"));

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page">
        <section className="card" role="alert">
          <h1>Something broke</h1>
          <p>The page hit an unexpected error. Your ticket key is safe in this browser. Reload to try again.</p>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>Reload</button>
        </section>
      </div>
    );
  }
}

export function App() {
  const { config } = useApp();
  const route = useRoute();

  useEffect(() => {
    const section = window.location.hash.match(/^#\/(how-it-works|why-bail|find-event)$/)?.[1];
    if (route.page === "home" && section) document.getElementById(section)?.scrollIntoView();
  }, [route]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content" onClick={(e) => { e.preventDefault(); const main = document.getElementById("main-content"); main?.focus(); main?.scrollIntoView(); }}>Skip to content</a>
      <header className={`header ${route.page === "event" ? "event-header" : ""}`}>
        <div className="header-inner content-width">
          <div className="brand-group"><a className="brand" href="#/" aria-label="Bail home">bail</a><span className="testnet-badge" title="Test tokens only. They have no value.">Testnet</span></div>
          <nav className="main-nav" aria-label="Main navigation">
            {route.page === "home" ? <><a className="nav-detail" href="#/how-it-works">How it works</a><a className="nav-detail" href="#/why-bail">Why trust Bail</a><a className="btn nav-button" href="#/find-event">Find your event <span aria-hidden="true">↗</span></a></> : route.page === "host" ? <><a href="#/">For attendees</a><a href="#/host">Host an event</a></> : <><a href={`#/event/${route.id}`}>My ticket</a><a href={`#/event/${route.id}/organizer`}>Public activity <span aria-hidden="true">↗</span></a></>}
          </nav>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <Boundary>
          <Suspense fallback={<div className="page"><Skeleton block label="Loading the host screen" /></div>}>
            {route.page === "home" ? <Home /> : route.page === "host" ? <Hosting key="create" /> : route.view === "host" ? <Hosting key={route.id} eventId={route.id} /> : <EventPage key={`${route.id}`} id={route.id} view={route.view} />}
          </Suspense>
        </Boundary>
      </main>
      <footer className="footer">
        <div className="footer-inner content-width"><div className="footer-brand"><a className="brand" href="#/">bail</a><span>Built on NEAR testnet</span></div><div className="footer-links"><a href="#/host">Host an event</a><a href="#/how-it-works">How it works</a><ContractLink account={config.contractId} label="Public contract ↗" /></div></div>
        <p className="footer-note content-width">Test tokens only, with no monetary value. Contract: {config.contractId}. The contract is locked and cannot be changed.</p>
      </footer>
    </div>
  );
}
