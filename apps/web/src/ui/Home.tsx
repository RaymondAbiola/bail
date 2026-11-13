import { useRef, useState } from "react";

import { useApp } from "../context.tsx";
import { CodeStrip } from "./CodeStrip.tsx";
import { DaoArbiterDemo } from "./DaoArbiterDemo.tsx";
import { ContractLink } from "./common.tsx";
import { Icon } from "./Icon.tsx";
import { PastEvents } from "./PastEvents.tsx";

export function Home() {
  const { config } = useApp();
  const finder = useRef<HTMLElement>(null);
  const eventInput = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const id = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  const validId = id !== null && Number.isSafeInteger(id);
  const findEvent = () => {
    finder.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
    eventInput.current?.focus({ preventScroll: true });
  };

  return (
    <div className="landing">
      <section className="hero content-width" aria-labelledby="home-title">
        <div className="hero-copy">
          <p className="eyebrow">For people who show up</p>
          <h1 id="home-title">Put a little down. <br /><em>Show up.</em> <br />Get it back.</h1>
          <p className="hero-description">A refundable deposit for your RSVP. Prove you were there with live codes. Get your deposit back, plus a share of no-shows’ deposits.</p>
          <div className="hero-actions">
            <button type="button" className="btn primary" onClick={findEvent}>Find your event <Icon name="arrow" /></button>
            <a className="btn" href="#/host">Host an event</a>
            <a className="text-link hero-how-link" href="#/how-it-works">See how it works <span aria-hidden="true">↗</span></a>
          </div>
          <p className="hero-reassurance">No wallet or gas for attendees. <span>Testnet demo.</span></p>
        </div>
        <DemoTicket />
      </section>

      <section className="promise-band" aria-labelledby="promise-title">
        <div className="content-width">
          <p className="eyebrow">Attendance belongs to the attendee</p>
          <h2 id="promise-title">Nobody gets to write you off.</h2>
          <p>Your live codes prove attendance. The organizer cannot mark you absent.</p>
          <div className="proof-path" aria-label="Attendee, proof, payout"><span>Attendee</span><Icon name="arrow" /><span>Proof</span><Icon name="arrow" /><span>Payout</span></div>
        </div>
      </section>

      <section id="how-it-works" className="how-section content-width" aria-labelledby="how-title">
        <div className="section-heading"><span className="eyebrow">The short version</span><h2 id="how-title">A small commitment.<br className="mobile-break" /> A fair return.</h2></div>
        <ol className="landing-steps">
          <li><span className="step-number">01</span><div><Icon name="ticket" /><h3>Save your seat</h3><p>RSVP with a refundable deposit. Save your private ticket key.</p></div></li>
          <li><span className="step-number">02</span><div><Icon name="calendar" /><h3>Catch the live codes</h3><p>Check in at a few moments during the event. Your codes are your proof.</p></div></li>
          <li><span className="step-number">03</span><div><Icon name="coins" /><h3>Get your deposit back</h3><p>Qualify by codes and share the deposits forfeited by no-shows.</p></div></li>
        </ol>
        <p className="money-note">If you do not qualify, your deposit is forfeited to qualifying attendees. Cancel before the cutoff for a full refund.</p>
      </section>

      <section className="organizer-section content-width" aria-labelledby="organizer-title">
        <div className="section-heading"><p className="eyebrow">For organizers / In your browser</p><h2 id="organizer-title">Bring the people. <br />Bail keeps the commitment.</h2></div>
        <ol className="landing-steps">
          <li><span className="step-number">01</span><div><Icon name="ticket" /><h3>Connect and create</h3><p>Connect a NEAR testnet wallet. Set the rules, name an independent arbiter, and share your event link.</p></div></li>
          <li><span className="step-number">02</span><div><Icon name="calendar" /><h3>Run your call</h3><p>Open each code when you choose, with one wallet approval. Keep the host screen open for reveals.</p></div></li>
          <li><span className="step-number">03</span><div><Icon name="coins" /><h3>Let the keeper settle</h3><p>After the dispute period, the keeper settles the event and pays out according to its rules.</p></div></li>
        </ol>
        <a className="btn" href="#/host">Host an event <Icon name="arrow" /></a>
        <p className="organizer-note">Organizers need a NEAR wallet for storage and fees. Attendees need neither a wallet nor gas. Testnet only.</p>
      </section>

      <PastEvents />
      <DaoArbiterDemo />

      <section id="why-bail" className="trust-section content-width" aria-labelledby="trust-title">
        <div><span className="eyebrow">Built for trust</span><h2 id="trust-title">Trust you can inspect.</h2><p>See the rules, the arbiter and the evidence before you RSVP. Your host runs the event. Your proof records your attendance.</p><ContractLink account={config.contractId} label="Explore the public contract ↗" /></div>
        <div>
          <ul className="trust-list">
            <li><span className="check-seal"><Icon name="check" /></span><div><h3>Fixed event rules</h3><p>The schedule and deposit are set before you join.</p></div></li>
            <li><span className="check-seal"><Icon name="check" /></span><div><h3>Public attendance evidence</h3><p>Codes are committed, revealed and verified onchain.</p></div></li>
            <li><span className="check-seal"><Icon name="check" /></span><div><h3>An arbiter who can refund everyone</h3><p>A separate named account can void the event.</p></div></li>
          </ul>
          <p className="trust-note">Missing or unrevealed codes lower the requirement. Two vouches return your deposit without a bonus. Cancelled or voided events, and events where nobody attends, refund everyone.</p>
        </div>
      </section>

      <section className="event-finder content-width" ref={finder} aria-labelledby="finder-title" id="find-event">
        <div><span className="eyebrow">Your next commitment</span><h2 id="finder-title">See you there.</h2><p>Have an invitation? Enter the event number your host shared.</p></div>
        <form onSubmit={(e) => { e.preventDefault(); if (validId) window.location.hash = `#/event/${id}`; }}>
          <label htmlFor="event">Event number</label>
          <div className="finder-controls"><input ref={eventInput} id="event" className="input" inputMode="numeric" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 42" /><button type="submit" className="btn primary" disabled={!validId}>Open event <Icon name="arrow" /></button></div>
          {config.defaultEventId !== null && <a className="small" href={`#/event/${config.defaultEventId}`}>Open the featured event #{config.defaultEventId} ↗</a>}
        </form>
      </section>
    </div>
  );
}

function DemoTicket() {
  const [sent, setSent] = useState(false);
  return (
    <div className="hero-ticket-wrap">
      <div className="demo-caption"><span className="caption-line" />A little preview of showing up<span className="caption-line" /></div>
      <div className="demo-ticket" aria-label="Illustrative live ticket preview. This is not a real event.">
        <div className="ticket-topline"><span>Your live ticket</span><span>Event #42</span></div>
        <p className="demo-label">Illustrative demo</p>
        <h2>An evening <br />of building.</h2>
        <div className="live-banner"><span className="live-dot" /><span>Code 2 of 3 is live</span><span className="demo-time">01:34 left</span></div>
        <div className="demo-entry"><p>tiger maple seven ocean lamp</p><button type="button" className="btn primary" onClick={() => setSent(!sent)} aria-pressed={sent}>{sent ? "Try again" : "Send code"}{!sent && <Icon name="arrow" />}</button></div>
        <p className="demo-feedback" role="status">{sent ? "Demo sent. A real catch is confirmed after reveal." : "Five words. One moment. Your proof."}</p>
        <div className="ticket-tear" aria-hidden="true" />
        <CodeStrip steps={[{ label: "Confirmed", tone: "confirmed" }, { label: sent ? "Demo sent" : "Live", tone: "live" }, { label: "Upcoming", tone: "upcoming" }]} />
        <div className="demo-deposit"><Icon name="coins" /><span>1 test USDC deposit</span><span className="small muted">Test tokens only</span></div>
      </div>
      <div className="proof-receipt"><Icon name="check" /><span>Your attendance is your proof.</span></div>
    </div>
  );
}
