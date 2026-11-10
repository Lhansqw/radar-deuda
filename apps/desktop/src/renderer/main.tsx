import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageRoot } from './language.js';
import { reportErrors } from './lib/report-errors.js';
import { Root } from './Root.js';
import './styles.css';

reportErrors(window, window.radar.app);

const root = document.getElementById('root');
if (!root) throw new Error('Falta el elemento #root');
createRoot(root).render(
  <StrictMode>
    <LanguageRoot render={() => <Root />} />
  </StrictMode>,
);
