import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppController } from '@/lib/controller.js';
import { App } from './App';
import './index.css';

// Built once, before React renders: the session, the mic and the event stream
// live outside every component (StrictMode's double effects open nothing twice),
// and nothing stops when cc hides this keep-alive page.
const controller = createAppController();

createRoot(document.getElementById('root')!).render(<StrictMode><App controller={controller} /></StrictMode>);
