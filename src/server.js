import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebScraper } from './scraper/scraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Current scraper instance
let scraper = null;
let clients = new Set();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// WebSocket connection handling
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Client connected');

  // Send current status on connection
  if (scraper) {
    ws.send(JSON.stringify({
      type: 'status',
      data: scraper.getStatus()
    }));
  }

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
});

// Broadcast to all connected clients
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  }
}

// REST API Endpoints

// Get current status
app.get('/api/status', (req, res) => {
  if (!scraper) {
    return res.json({
      status: 'idle',
      stats: {
        pagesScraped: 0,
        imagesDownloaded: 0,
        errorsEncountered: 0
      }
    });
  }

  const status = scraper.getStatus();
  res.json({
    status: status.isRunning ? 'scraping' : 'idle',
    ...status
  });
});

// Start scraping
app.post('/api/start', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Check if already running
  if (scraper && scraper.isRunning) {
    return res.status(409).json({ error: 'Scraper is already running. Stop it first.' });
  }

  // Create new scraper instance
  scraper = new WebScraper({
    maxDepth: 5,
    maxConcurrent: 3,
    delayMs: 500,
    timeout: 30000,
    outputDir: './scraped_output'
  });

  // Set up callbacks
  scraper.onProgress = (progress) => {
    broadcast('progress', progress);
  };

  scraper.onLog = (logEntry) => {
    broadcast('log', logEntry);
  };

  scraper.onComplete = (result) => {
    broadcast('complete', result);
  };

  // Start scraping in background
  scraper.start(url).catch((error) => {
    console.error('Scraper error:', error);
    broadcast('error', { message: error.message });
  });

  res.json({
    message: 'Scraping started',
    scrapeId: scraper.scrapeId
  });
});

// Stop scraping
app.post('/api/stop', async (req, res) => {
  if (!scraper || !scraper.isRunning) {
    return res.status(400).json({ error: 'No scraper is currently running' });
  }

  await scraper.stop();
  res.json({ message: 'Stop signal sent' });
});

// Get output directory path
app.get('/api/output-dir', (req, res) => {
  const outputDir = path.resolve('./scraped_output');
  res.json({ outputDir });
});

// Serve the log file
app.get('/api/log', async (req, res) => {
  try {
    const logPath = path.resolve('./scraped_output/logs/scrape_log.json');
    res.sendFile(logPath);
  } catch {
    res.status(404).json({ error: 'Log file not found' });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`\n🌐 Website Scraper is running!`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (scraper && scraper.isRunning) {
    await scraper.stop();
  }
  server.close();
  process.exit(0);
});
