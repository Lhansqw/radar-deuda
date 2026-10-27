import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Falta el elemento #root');
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
