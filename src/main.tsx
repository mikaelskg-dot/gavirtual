import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const el = document.getElementById('root');
if (!el) throw new Error('Falta #root');
const root = createRoot(el);

const env = import.meta.env;
if (!env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_PROJECT_ID) {
  root.render(
    <div className="login-wrap">
      <div className="login card">
        <h1>Falta configurar Firebase</h1>
        <p>
          Copia <code className="kbd">.env.example</code> como <code className="kbd">.env</code>, rellena los datos de tu app web de Firebase y reinicia{' '}
          <code className="kbd">npm run dev</code>. Los pasos completos están en el README.
        </p>
      </div>
    </div>,
  );
} else {
  void import('./App').then(({ App }) => root.render(<StrictMode><App /></StrictMode>));
}
