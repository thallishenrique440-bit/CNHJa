
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { startShadowWorker } from './lib/ShadowWorker.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware for parsing JSON
  app.use(express.json());

  // API Routes
  app.post('/api/:handler', async (req, res) => {
    const { handler } = req.params;
    const handlerPath = path.join(__dirname, 'api', `${handler}.ts`);
    
    if (fs.existsSync(handlerPath)) {
      try {
        // Dynamic import for the handler
        // Note: In a real production app, you'd pre-compile or use a more robust routing system
        const module = await import(`./api/${handler}.ts`);
        const handlerFn = module.default;
        
        // Mock Next.js req/res for the handler
        // This is a simplified shim
        await handlerFn(req, res);
      } catch (error: any) {
        console.error(`Error in API handler ${handler}:`, error);
        res.status(500).json({ error: error.message });
      }
    } else {
      res.status(404).json({ error: `Handler ${handler} not found` });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Start Shadow Worker (Bootstrap) side-by-side with the web server
    startShadowWorker().catch((err) => {
      console.error('[Server] Failed to launch Shadow Worker:', err);
    });
  });
}

startServer();
