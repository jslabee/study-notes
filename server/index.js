import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(serverDir, '..', 'client', 'dist');

export const app = express();

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Unknown API routes get a JSON 404 instead of the client app
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve the built client when it exists; all non-API routes return index.html
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api(\/|$)).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Unified error handling: always respond with { error } and a matching HTTP status
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status < 500 && err.message ? err.message : 'Internal server error',
  });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}
