import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createBluetoothSession } from './bluetooth-session.js';
import './style.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Missing React root element.');
const session = createBluetoothSession();
addEventListener('pagehide', session.dispose, { once: true });
createRoot(rootElement).render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
);
