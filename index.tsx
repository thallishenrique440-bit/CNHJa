import React from 'react';
import ReactDOM from 'react-dom/client';
import './lib/googleMaps';
import App from './App';

console.log('[App] Iniciando montagem do React...');

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error('[App] Erro Fatal: Elemento #root não encontrado no DOM.');
  throw new Error("Could not find root element to mount to");
}

try {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  console.log('[App] React montado com sucesso.');
} catch (error) {
  console.error('[App] Erro durante a renderização:', error);
}