
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

  // Middleware for parsing JSON with Raw Body preservation for cryptographic hashing
  app.use(express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    }
  }));

  // API Routes (Handles /api/handler and subpaths like /api/handler/summary)
  app.use('/api', async (req, res) => {
    const parts = req.path.split('/').filter(Boolean);
    if (parts.length === 0) {
      return res.status(400).json({ error: 'Missing API handler' });
    }
    const handler = parts[0];
    const handlerPath = path.join(__dirname, 'api', `${handler}.ts`);
    
    if (fs.existsSync(handlerPath)) {
      try {
        const module = await import(`./api/${handler}.ts`);
        const handlerFn = module.default;
        await handlerFn(req, res);
      } catch (error: any) {
        console.error(`Error in API handler ${handler}:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message });
        }
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
