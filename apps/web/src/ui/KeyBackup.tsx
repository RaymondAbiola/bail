import { useState } from "react";

import { CopyButton } from "./common.tsx";

/** The secret ticket key, hidden until asked for, with copy and download. It is never sent anywhere. */
export function KeyBackup({ backup, eventId }: { backup: string; eventId: number }) {
  const [shown, setShown] = useState(false);

  const download = () => {
    const blob = new Blob(
      [`Bail ticket key for event ${eventId}\nKeep this private. Anyone who has it can act as your ticket.\n\n${backup}\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `bail-ticket-event-${eventId}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="actions">
      {shown ? (
        <div className="key-box" data-testid="ticket-key">{backup}</div>
      ) : (
        <div className="key-box" aria-hidden="true">ed25519:••••••••••••••••••••••••••••••••</div>
      )}
      <div className="actions row">
        <button type="button" className="btn" onClick={() => setShown((v) => !v)} aria-pressed={shown}>
          {shown ? "Hide key" : "Show key"}
        </button>
        <CopyButton text={backup} label="Copy key" done="Key copied" />
        <button type="button" className="btn" onClick={download}>Download key</button>
      </div>
    </div>
  );
}
