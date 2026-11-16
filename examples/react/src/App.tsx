import { useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { BluetoothSession } from './bluetooth-session.js';

export function App({
  session,
}: {
  readonly session: BluetoothSession;
}): ReactElement {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return (
    <main>
      <h1>React Bluetooth sample</h1>
      <p>
        Choose a peripheral, read its IO value, and write a response-backed
        payload.
      </p>
      <div className="actions">
        <button
          id="connect"
          disabled={snapshot.busy}
          onClick={() => {
            void session.connect();
          }}
        >
          Connect, read, and write
        </button>
        <button
          id="cancel"
          disabled={snapshot.busy}
          onClick={() => {
            void session.chooseOnly();
          }}
        >
          Open chooser for cancellation
        </button>
      </div>
      <dl>
        <dt>Status</dt>
        <dd data-testid="status">{snapshot.status}</dd>
        <dt>Battery</dt>
        <dd data-testid="battery">{snapshot.battery}</dd>
        <dt>Written bytes</dt>
        <dd data-testid="written">{snapshot.written}</dd>
        <dt>Error category</dt>
        <dd data-testid="error-category">{snapshot.errorCategory}</dd>
        <dt>Error name</dt>
        <dd data-testid="error-name">{snapshot.errorName}</dd>
        <dt>Error message</dt>
        <dd data-testid="error-message">{snapshot.errorMessage}</dd>
        <dt>Disconnect events</dt>
        <dd data-testid="disconnect-events">{snapshot.disconnectEvents}</dd>
      </dl>
    </main>
  );
}
