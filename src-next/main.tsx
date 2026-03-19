import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { CacheProvider } from './cache';
import { AppProviders, ThemeProvider } from './context';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <CacheProvider>
        <AppProviders>
          <App />
        </AppProviders>
      </CacheProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
