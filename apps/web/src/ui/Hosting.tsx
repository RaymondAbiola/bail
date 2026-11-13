import { useState } from "react";

import { HostStore } from "../lib/host-record.ts";
import { browserStorage } from "../lib/storage.ts";
import { CreateEvent } from "./CreateEvent.tsx";
import { HostScreen } from "./HostScreen.tsx";
import { useHostWallet } from "./HostCommon.tsx";

export default function Hosting({ eventId }: { eventId?: number }) {
  const wallet = useHostWallet();
  const [store] = useState(() => new HostStore(browserStorage()));
  return eventId === undefined ? <CreateEvent walletState={wallet} store={store} /> : <HostScreen key={eventId} id={eventId} walletState={wallet} store={store} />;
}
