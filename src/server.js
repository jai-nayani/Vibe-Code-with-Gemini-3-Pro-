import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { WebScraper } from './scraper/scraper.js';
import { Storage } from '@google-cloud/storage';
import { AnalysisCompressor } from './utils/analysisCompressor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3500;

// Cloud Storage setup
const storage = new Storage();
const bucketName = 'vibe-scraper-output';

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

// Get next run number from CC_Output folder
async function getNextRunNumber() {
  // CC_Output is in the project root (one level up from src/)
  const ccOutputPath = path.join(__dirname, '../CC_Output');
  
  try {
    // Ensure CC_Output directory exists
    await fs.mkdir(ccOutputPath, { recursive: true });
    
    // Read all entries in CC_Output
    const entries = await fs.readdir(ccOutputPath, { withFileTypes: true });
    
    // Filter for directories that are numeric
    const numericDirs = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => /^\d+$/.test(name))
      .map(name => parseInt(name, 10))
      .filter(num => !isNaN(num));
    
    // If no numeric directories exist, start with 1
    if (numericDirs.length === 0) {
      return 1;
    }
    
    // Return the next number after the highest existing number
    return Math.max(...numericDirs) + 1;
  } catch (error) {
    // If directory doesn't exist or can't be read, start with 1
    console.error('Error reading CC_Output:', error);
    return 1;
  }
}

// Upload directory to Cloud Storage
async function uploadDirectoryToBucket(localDir, bucketName) {
  const bucket = storage.bucket(bucketName);
  
  async function uploadRecursive(dirPath, bucketPrefix = '') {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const bucketPath = path.join(bucketPrefix, entry.name).replace(/\\/g, '/');
      
      if (entry.isDirectory()) {
        await uploadRecursive(fullPath, bucketPath);
      } else {
        try {
          await bucket.upload(fullPath, {
            destination: `scrapes/${path.basename(localDir)}/${bucketPath}`,
          });
          console.log('Uploaded:', fullPath);
        } catch (error) {
          console.error(`Error uploading ${fullPath}:`, error.message);
        }
      }
    }
  }
  
  try {
    await uploadRecursive(localDir);
    console.log(`Successfully uploaded ${localDir} to ${bucketName}`);
  } catch (error) {
    console.error(`Error uploading directory ${localDir}:`, error.message);
  }
}

// Root route - serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

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

  // Get next run number and create output directory path
  const runNumber = await getNextRunNumber();
  const outputDir = path.join(__dirname, '../CC_Output', runNumber.toString());

  // Create new scraper instance
  scraper = new WebScraper({
    maxDepth: 5,
    maxConcurrent: 3,
    delayMs: 500,
    timeout: 60000, // Increased to 60 seconds for slow-loading sites
    outputDir: outputDir
  });

  // Set up callbacks
  scraper.onProgress = (progress) => {
    broadcast('progress', progress);
  };

  scraper.onLog = (logEntry) => {
    broadcast('log', logEntry);
  };

  scraper.onComplete = async (result) => {
    broadcast('complete', result);
    
    // Upload scrape output to Cloud Storage
    try {
      await uploadDirectoryToBucket(outputDir, bucketName);
    } catch (error) {
      console.error('Error uploading to Cloud Storage:', error.message);
    }
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
  if (!scraper) {
    return res.json({ outputDir: null });
  }
  const outputDir = scraper.fileManager.getOutputDir();
  res.json({ outputDir });
});

// Serve the log file
app.get('/api/log', async (req, res) => {
  try {
    if (!scraper) {
      return res.status(404).json({ error: 'No scraper instance found' });
    }
    const outputDir = scraper.fileManager.getOutputDir();
    const logPath = path.join(outputDir, 'logs', 'scrape_log.json');
    res.sendFile(logPath);
  } catch {
    res.status(404).json({ error: 'Log file not found' });
  }
});

// ===========================================
// AI STUDIO API ENDPOINT - Returns LLM-ready data
// ===========================================
app.post('/api/scrape-for-llm', async (req, res) => {
  const { url, maxPages = 1 } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  console.log(`[AI Studio API] Scraping: ${url}`);

  const { chromium } = await import('playwright');
  let browser = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'WebsiteRebuilder/1.0'
    });
    const page = await context.newPage();

    // Navigate to page
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });

    // Wait a bit for dynamic content
    await page.waitForTimeout(2000);

    // Get page content
    const html = await page.content();
    const title = await page.title();

    // Take screenshot (viewport only, not full page - smaller size)
    const screenshotBuffer = await page.screenshot({
      type: 'png',
      fullPage: false
    });
    const screenshotBase64 = screenshotBuffer.toString('base64');

    // Extract key information using page.evaluate
    const extraction = await page.evaluate(() => {
      // Get meta description
      const metaDesc = document.querySelector('meta[name="description"]')?.content || 
                       document.querySelector('meta[property="og:description"]')?.content || '';
      
      // Get headings
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .slice(0, 20)
        .map(h => h.textContent.trim())
        .filter(t => t.length > 0 && t.length < 200);

      // Get navigation items
      const navItems = Array.from(document.querySelectorAll('nav a, header a'))
        .slice(0, 15)
        .map(a => a.textContent.trim())
        .filter(t => t.length > 0 && t.length < 50);

      // Get body text (cleaned, limited)
      const bodyText = document.body.innerText
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 5000);

      // Get contact info
      const pageText = document.body.innerText;
      const phoneMatch = pageText.match(/(\+?1?\s*[-.]?\s*)?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
      const emailMatch = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

      // Get colors from computed styles (sample)
      const colors = new Set();
      document.querySelectorAll('*').forEach(el => {
        const style = getComputedStyle(el);
        const bg = style.backgroundColor;
        const color = style.color;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') colors.add(bg);
        if (color) colors.add(color);
      });

      // Get images info
      const images = Array.from(document.querySelectorAll('img'))
        .slice(0, 10)
        .map(img => ({
          src: img.src,
          alt: img.alt,
          isLogo: img.className.toLowerCase().includes('logo') || 
                  img.src.toLowerCase().includes('logo') ||
                  img.alt.toLowerCase().includes('logo')
        }));

      return {
        metaDescription: metaDesc.substring(0, 500),
        headings: [...new Set(headings)],
        navigation: [...new Set(navItems)],
        bodyText,
        contactInfo: {
          phone: phoneMatch ? phoneMatch[0] : null,
          email: emailMatch ? emailMatch[0] : null
        },
        colors: Array.from(colors).slice(0, 10),
        images
      };
    });

    await browser.close();
    browser = null;

    // Build response
    const response = {
      success: true,
      url,
      timestamp: new Date().toISOString(),
      screenshot: {
        base64: screenshotBase64,
        mimeType: 'image/png'
      },
      content: {
        title,
        metaDescription: extraction.metaDescription,
        headings: extraction.headings,
        navigation: extraction.navigation,
        bodyText: extraction.bodyText,
        contactInfo: extraction.contactInfo
      },
      design: {
        colors: extraction.colors
      },
      images: extraction.images
    };

    console.log(`[AI Studio API] Success: ${url}`);
    res.json(response);

  } catch (error) {
    console.error(`[AI Studio API] Error: ${error.message}`);
    if (browser) await browser.close();
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check endpoint for AI Studio
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'website-scraper', timestamp: new Date().toISOString() });
});

// ===========================================
// DATA COMPRESSION ENGINE - Prepare for AI Analysis
// ===========================================
app.post('/api/prepare-for-analysis', async (req, res) => {
  const { scrapeId, useLatest } = req.body;

  console.log(`[Analysis API] Request received: scrapeId=${scrapeId}, useLatest=${useLatest}`);

  try {
    const compressor = new AnalysisCompressor(storage, bucketName);
    let targetScrapeId = scrapeId;

    // Find latest scrape if needed
    if (!targetScrapeId && useLatest) {
      targetScrapeId = await compressor.findLatestScrape();
    }

    if (!targetScrapeId) {
      return res.status(400).json({
        success: false,
        error: 'Either scrapeId or useLatest:true is required'
      });
    }

    console.log(`[Analysis API] Processing scrape: ${targetScrapeId}`);

    // Compile the analysis package
    const { analysisPackage, processingErrors } = await compressor.compileAnalysisPackage(targetScrapeId);

    // Save to GCS
    const analysisPackageUrl = await compressor.saveAnalysisPackage(targetScrapeId, analysisPackage);

    // Calculate compression ratio
    const originalSize = analysisPackage.source.pagesScraped * 500000; // Estimate ~500KB per page
    const compressedSize = JSON.stringify(analysisPackage).length;
    const compressionRatio = Math.round(originalSize / compressedSize);

    console.log(`[Analysis API] Success: ${analysisPackageUrl}`);

    res.json({
      success: true,
      analysisPackageUrl,
      screenshotsUrl: `https://storage.googleapis.com/${bucketName}/analysis/${targetScrapeId}/screenshots/`,
      metadata: {
        originalScrapeId: targetScrapeId,
        originalUrl: analysisPackage.source.originalUrl,
        pagesProcessed: analysisPackage.content.pages.length,
        screenshotsIncluded: analysisPackage.screenshots.length,
        totalSizeBytes: compressedSize,
        compressionRatio: `${compressionRatio}x`,
        timestamp: new Date().toISOString()
      },
      processingErrors: processingErrors.length > 0 ? processingErrors : undefined
    });

  } catch (error) {
    console.error(`[Analysis API] Error: ${error.message}`);

    // Return appropriate error response
    if (error.message.includes('No scrapes found')) {
      return res.status(404).json({
        success: false,
        error: 'No scrapes found in bucket'
      });
    }

    if (error.message.includes('missing') || error.message.includes('corrupt')) {
      return res.status(404).json({
        success: false,
        error: error.message,
        scrapeId: req.body.scrapeId
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to prepare analysis package',
      details: error.message
    });
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
