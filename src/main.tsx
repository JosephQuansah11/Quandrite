/** The client entry: mount the app, and load the one stylesheet Vite bundles with it. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('no #root to mount into');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
