export function OtherChain() {
  return (
    <div className="card flat" aria-labelledby="other-chain">
      <h3 id="other-chain">Pay from another chain</h3>
      <p className="muted small">
        Not available yet. Planned for mainnet, where deposits will come from the chain you already use. Today only the testnet route works.
      </p>
      <button type="button" className="btn" disabled aria-disabled="true">Planned for mainnet</button>
    </div>
  );
}
