import { chromium } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { FileManager } from '../utils/fileManager.js';
import { RobotsChecker } from '../utils/robotsParser.js';
import { AssetExtractor } from './assetExtractor.js';

export class WebScraper {
  constructor(options = {}) {
    this.maxDepth = options.maxDepth || 5;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.delayMs = options.delayMs || 500;
    this.timeout = options.timeout || 30000;
    this.maxFileSize = options.maxFileSize || 50 * 1024 * 1024; // 50MB
    this.userAgent = options.userAgent || 'MyScraper/1.0';
    this.outputDir = options.outputDir || './scraped_output';

    this.browser = null;
    this.fileManager = new FileManager(this.outputDir);
    this.robotsChecker = new RobotsChecker(this.userAgent);

    // State
    this.scrapeId = null;
    this.targetUrl = null;
    this.baseDomain = null;
    this.visitedUrls = new Set();
    this.downloadedAssets = new Set();
    this.urlQueue = [];
    this.activeRequests = 0;
    this.isRunning = false;
    this.shouldStop = false;

    // Stats
    this.stats = {
      pagesScraped: 0,
      imagesDownloaded: 0,
      screenshotsCaptured: 0,
      errorsEncountered: 0,
      totalSizeBytes: 0
    };

    // Logging
    this.pageLog = [];
    this.imageLog = [];
    this.screenshotLog = [];
    this.errorLog = [];

    // Callbacks
    this.onProgress = null;
    this.onLog = null;
    this.onComplete = null;
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, message, type };

    if (this.onLog) {
      this.onLog(logEntry);
    }

    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  emitProgress() {
    if (this.onProgress) {
      this.onProgress({
        status: this.isRunning ? 'scraping' : (this.shouldStop ? 'stopped' : 'complete'),
        pagesScraped: this.stats.pagesScraped,
        imagesDownloaded: this.stats.imagesDownloaded,
        screenshotsCaptured: this.stats.screenshotsCaptured,
        errorsEncountered: this.stats.errorsEncountered,
        queueLength: this.urlQueue.length,
        activeRequests: this.activeRequests
      });
    }
  }

  async start(url) {
    if (this.isRunning) {
      throw new Error('Scraper is already running');
    }

    this.scrapeId = uuidv4();
    this.targetUrl = url;
    this.startedAt = new Date().toISOString();
    this.isRunning = true;
    this.shouldStop = false;

    try {
      // Parse base domain
      const parsedUrl = new URL(url);
      this.baseDomain = parsedUrl.hostname;

      this.log(`Starting scrape of ${url}`);
      this.log(`Scrape ID: ${this.scrapeId}`);

      // Initialize
      await this.fileManager.ensureDirectories();
      await this.robotsChecker.load(url);

      // Update delay from robots.txt if needed
      const robotsDelay = this.robotsChecker.getCrawlDelay();
      if (robotsDelay > this.delayMs) {
        this.delayMs = robotsDelay;
        this.log(`Using crawl delay from robots.txt: ${this.delayMs}ms`);
      }

      // Launch browser
      this.log('Launching browser...');
      this.browser = await chromium.launch({
        headless: true
      });

      // Add starting URL to queue
      this.urlQueue.push({ url, depth: 0 });

      // Process queue
      await this.processQueue();

      // Complete
      this.completedAt = new Date().toISOString();
      await this.saveLog();

      this.log(`Scrape complete. Pages: ${this.stats.pagesScraped}, Images: ${this.stats.imagesDownloaded}, Screenshots: ${this.stats.screenshotsCaptured}, Errors: ${this.stats.errorsEncountered}`);

      if (this.onComplete) {
        this.onComplete({
          success: true,
          stats: this.stats,
          outputDir: this.fileManager.getOutputDir()
        });
      }

    } catch (error) {
      this.log(`Fatal error: ${error.message}`, 'error');
      this.errorLog.push({
        url: url,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      if (this.onComplete) {
        this.onComplete({
          success: false,
          error: error.message,
          stats: this.stats
        });
      }
    } finally {
      this.isRunning = false;
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      this.emitProgress();
    }
  }

  async stop() {
    this.log('Stopping scraper...');
    this.shouldStop = true;
  }

  async processQueue() {
    const workers = [];

    for (let i = 0; i < this.maxConcurrent; i++) {
      workers.push(this.worker());
    }

    await Promise.all(workers);
  }

  async worker() {
    while (!this.shouldStop) {
      // Get next URL from queue
      const item = this.urlQueue.shift();

      if (!item) {
        // Queue is empty, check if other workers are still processing
        if (this.activeRequests === 0) {
          break;
        }
        // Wait a bit and try again
        await this.delay(100);
        continue;
      }

      const { url, depth } = item;

      // Skip if already visited
      if (this.visitedUrls.has(url)) {
        continue;
      }

      // Check depth limit
      if (depth > this.maxDepth) {
        continue;
      }

      // Check robots.txt
      if (!this.robotsChecker.isAllowed(url)) {
        this.log(`Skipping (robots.txt): ${url}`);
        continue;
      }

      this.visitedUrls.add(url);
      this.activeRequests++;

      try {
        await this.scrapePage(url, depth);
      } catch (error) {
        this.handleError(url, error);
      } finally {
        this.activeRequests--;
        this.emitProgress();
      }

      // Rate limiting
      await this.delay(this.delayMs);
    }
  }

  async scrapePage(url, depth) {
    this.log(`Scraping: ${url} (depth: ${depth})`);

    const context = await this.browser.newContext({
      userAgent: this.userAgent
    });

    const page = await context.newPage();

    try {
      // Navigate with timeout
      // Try multiple strategies in order of strictness
      let response;
      const strategies = [
        { waitUntil: 'domcontentloaded', timeout: this.timeout },
        { waitUntil: 'load', timeout: this.timeout * 2 },
        { waitUntil: 'networkidle', timeout: this.timeout * 2 }
      ];
      
      let lastError = null;
      for (const strategy of strategies) {
        try {
          this.log(`Trying navigation with '${strategy.waitUntil}' strategy (timeout: ${strategy.timeout}ms)...`);
          response = await page.goto(url, {
            waitUntil: strategy.waitUntil,
            timeout: strategy.timeout
          });
          this.log(`Successfully loaded page with '${strategy.waitUntil}' strategy`);
          break; // Success, exit the loop
        } catch (error) {
          lastError = error;
          // If it's not a timeout error, re-throw it
          if (!error.message.includes('Timeout') && !error.message.includes('timeout')) {
            throw error;
          }
          this.log(`'${strategy.waitUntil}' strategy timed out, trying next strategy...`);
          // Continue to next strategy
        }
      }
      
      // If all strategies failed, throw the last error
      if (!response) {
        throw lastError || new Error('All navigation strategies failed');
      }

      const status = response.status();

      if (status >= 400) {
        throw new Error(`HTTP ${status}`);
      }

      // Get page content
      const html = await page.content();

      // Capture full-page screenshot
      await this.capturePageScreenshot(page, url);

      // Save page
      const localPath = await this.fileManager.savePage(url, html);
      this.stats.pagesScraped++;
      this.stats.totalSizeBytes += Buffer.byteLength(html, 'utf8');

      this.pageLog.push({
        url,
        local_path: localPath,
        status: 'success'
      });

      this.log(`Saved page: ${localPath}`);

      // Extract assets
      const extractor = new AssetExtractor(this.targetUrl);
      const assets = extractor.extractAllAssets(html, url);

      // Download images
      for (const image of assets.images) {
        if (!this.downloadedAssets.has(image.url) && !this.shouldStop) {
          await this.downloadAsset(image.url, image.type);
        }
      }

      // Save inline SVGs
      for (const svg of assets.inlineSvgs) {
        if (!this.shouldStop) {
          await this.saveInlineSvg(svg);
        }
      }

      // Download and parse CSS files for background images
      for (const cssLink of assets.cssLinks) {
        if (!this.downloadedAssets.has(cssLink.url) && !this.shouldStop) {
          await this.downloadAndParseCss(cssLink.url);
        }
      }

      // Download JS files (optional)
      for (const jsLink of assets.jsLinks) {
        if (!this.downloadedAssets.has(jsLink.url) && !this.shouldStop) {
          await this.downloadJs(jsLink.url);
        }
      }

      // Add page links to queue
      if (depth < this.maxDepth) {
        for (const link of assets.pageLinks) {
          if (!this.visitedUrls.has(link) && !this.urlQueue.find(item => item.url === link)) {
            this.urlQueue.push({ url: link, depth: depth + 1 });
          }
        }
      }

    } finally {
      await page.close();
      await context.close();
    }
  }

  async capturePageScreenshot(page, url) {
    try {
      this.log(`Capturing screenshot: ${url}`);

      // Capture full-page screenshot (initial state)
      const screenshotBuffer = await page.screenshot({
        fullPage: true,
        type: 'png'
      });

      // Save screenshot
      const localPath = await this.fileManager.saveScreenshot(url, screenshotBuffer, 'initial');
      this.stats.screenshotsCaptured++;
      this.stats.totalSizeBytes += screenshotBuffer.length;

      // Extract page metadata for the screenshot log
      const metadata = await page.evaluate(() => ({
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content || null,
        ogImage: document.querySelector('meta[property="og:image"]')?.content || null,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        scrollHeight: document.documentElement.scrollHeight
      }));

      this.screenshotLog.push({
        url,
        local_path: localPath,
        type: 'initial',
        metadata,
        size_bytes: screenshotBuffer.length,
        status: 'success',
        timestamp: new Date().toISOString()
      });

      this.log(`Saved screenshot: ${localPath} (${Math.round(screenshotBuffer.length / 1024)}KB)`);
      this.emitProgress();

      // Now capture interactive states (clicks on buttons, tabs, nav items)
      await this.captureInteractiveScreenshots(page, url);

    } catch (error) {
      this.log(`Screenshot error for ${url}: ${error.message}`, 'error');
      this.screenshotLog.push({
        url,
        local_path: null,
        type: 'initial',
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Intelligent click detection using visual heuristics
   * Catches React/Vue/Next.js elements that selector-based detection misses
   */
  async detectClickableElements(page) {
    return await page.evaluate(() => {
      const clickable = [];
      const seen = new Set();
      
      // Get ALL elements on page
      const allElements = document.querySelectorAll('*');
      
      allElements.forEach((el, index) => {
        // Skip invisible/tiny elements
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return;
        if (rect.top < 0 || rect.left < 0) return;
        if (rect.top > window.innerHeight) return; // Below fold
        
        const style = window.getComputedStyle(el);
        
        // Skip hidden elements
        if (style.display === 'none' || style.visibility === 'hidden') return;
        if (style.opacity === '0') return;
        
        // DETECTION HEURISTICS
        const isClickable = (
          // 1. Cursor indicates clickable
          style.cursor === 'pointer' ||
          
          // 2. Has click-related attributes
          el.onclick !== null ||
          el.hasAttribute('onclick') ||
          el.hasAttribute('tabindex') ||
          el.hasAttribute('role') ||
          
          // 3. Is a semantic interactive element
          ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ||
          
          // 4. Has interactive ARIA role
          ['button', 'link', 'tab', 'menuitem', 'option'].includes(el.getAttribute('role')) ||
          
          // 5. Has data attributes suggesting interactivity
          Array.from(el.attributes).some(attr => 
            attr.name.startsWith('data-') && 
            (attr.name.includes('click') || attr.name.includes('toggle') || 
             attr.name.includes('open') || attr.name.includes('modal') ||
             attr.name.includes('action') || attr.name.includes('trigger'))
          )
        );
        
        if (!isClickable) return;
        
        // Get meaningful text
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '')
          .trim()
          .slice(0, 50)
          .replace(/\s+/g, ' ');
        
        // Skip if no text or duplicate text
        if (!text || text.length < 2) return;
        if (seen.has(text.toLowerCase())) return;
        seen.add(text.toLowerCase());
        
        // Skip common non-interactive text
        const skipTexts = ['loading', 'copyright', '©', 'all rights reserved'];
        if (skipTexts.some(skip => text.toLowerCase().includes(skip))) return;
        
        // Generate a unique selector for this element
        let selector = '';
        if (el.id) {
          selector = `#${el.id}`;
        } else if (el.className && typeof el.className === 'string') {
          const classes = el.className.split(' ').filter(c => c && !c.includes('--')).slice(0, 2);
          if (classes.length) {
            selector = `${el.tagName.toLowerCase()}.${classes.join('.')}`;
          }
        }
        if (!selector) {
          selector = `${el.tagName.toLowerCase()}:nth-child(${index})`;
        }
        
        clickable.push({
          selector,
          text,
          tag: el.tagName,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          hasCursorPointer: style.cursor === 'pointer',
          hasOnClick: el.onclick !== null || el.hasAttribute('onclick'),
          index: clickable.length
        });
      });
      
      // Sort by position (top-left first) and limit
      return clickable
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .slice(0, 25); // Max 25 clickable elements
    });
  }

  async captureInteractiveScreenshots(page, url) {
    try {
      this.log(`Finding interactive elements on: ${url}`);

      // Find all clickable elements that might reveal new content (selector-based)
      const selectorBasedElements = await page.evaluate(() => {
        const elements = [];
        const seen = new Set();

        // Selectors for interactive elements
        const selectors = [
          'nav a',
          'nav button',
          'header a',
          'header button',
          '[role="tab"]',
          '[role="button"]',
          '.nav-link',
          '.tab',
          '.tabs button',
          '.tabs a',
          '.menu-item',
          '.menu a',
          '.navbar a',
          '.navbar button',
          'button:not([type="submit"])',
          '[data-toggle]',
          '[data-bs-toggle]',
          '.accordion-button',
          '.collapse-toggle',
          '[onclick]',
          'a[href^="#"]',
          'a[href=""]',
          'a[href="javascript"]',
          '.card[onclick]',
          '.clickable'
        ];

        for (const selector of selectors) {
          try {
            const els = document.querySelectorAll(selector);
            for (const el of els) {
              // Skip if not visible
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;

              // Skip if already processed (by text content)
              const text = (el.textContent || '').trim().substring(0, 50);
              const identifier = `${el.tagName}-${text}-${Math.round(rect.x)}-${Math.round(rect.y)}`;
              if (seen.has(identifier)) continue;
              seen.add(identifier);

              // Skip external links
              if (el.tagName === 'A') {
                const href = el.getAttribute('href') || '';
                if (href.startsWith('http') && !href.includes(window.location.hostname)) continue;
                if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;
              }

              // Skip form submit buttons
              if (el.type === 'submit') continue;

              // Get element info
              elements.push({
                tag: el.tagName,
                text: text || el.getAttribute('aria-label') || el.getAttribute('title') || 'element',
                selector: selector,
                href: el.getAttribute('href') || null,
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                index: elements.length,
                source: 'selector'
              });
            }
          } catch (e) {
            // Ignore selector errors
          }
        }

        return elements.slice(0, 20); // Limit to 20 interactive elements
      });

      this.log(`Selector-based detection found ${selectorBasedElements.length} elements`);

      // Smart detection: Find elements with cursor:pointer or click handlers
      // This catches React/Vue components that don't use standard selectors
      const smartClickables = await this.detectClickableElements(page);
      this.log(`Smart detection found ${smartClickables.length} additional clickable elements`);

      // Merge with existing, avoiding duplicates
      const existingTexts = new Set(selectorBasedElements.map(el => el.text?.toLowerCase()));
      const clickableElements = [...selectorBasedElements];
      
      for (const smart of smartClickables) {
        if (!existingTexts.has(smart.text.toLowerCase())) {
          clickableElements.push({
            tag: smart.tag,
            text: smart.text,
            selector: smart.selector,
            x: smart.x,
            y: smart.y,
            index: clickableElements.length,
            source: 'smart-detection'
          });
          existingTexts.add(smart.text.toLowerCase());
        }
      }

      this.log(`Total interactive elements after merge: ${clickableElements.length}`);

      // Track which states we've already captured
      const capturedStates = new Set();

      for (const element of clickableElements) {
        if (this.shouldStop) break;

        try {
          // Create a clean name for this state
          const stateName = this.sanitizeStateName(element.text || `element_${element.index}`);

          // Skip if we've already captured a similar state
          if (capturedStates.has(stateName)) continue;
          capturedStates.add(stateName);

          this.log(`Clicking: "${element.text}" (${element.tag})`);

          // Store current scroll position and URL
          const beforeUrl = page.url();
          const beforeScroll = await page.evaluate(() => window.scrollY);

          // Click the element
          await page.mouse.click(element.x, element.y);

          // Wait for potential content changes
          await this.delay(800); // Wait for animations

          // Check if URL changed (navigation happened)
          const afterUrl = page.url();
          if (afterUrl !== beforeUrl && !afterUrl.includes('#')) {
            // Page navigated - go back
            this.log(`Navigation detected, going back...`);
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
            await this.delay(500);
            continue;
          }

          // Wait for any animations to complete
          await page.evaluate(() => {
            return new Promise(resolve => {
              requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
              });
            });
          });

          // Check if content actually changed
          const hasNewContent = await page.evaluate(() => {
            // Look for newly visible elements
            const visibleModals = document.querySelectorAll('.modal.show, .modal[style*="display: block"], [role="dialog"]:not([hidden])');
            const visibleDropdowns = document.querySelectorAll('.dropdown-menu.show, .dropdown.open, [aria-expanded="true"]');
            const activeTabs = document.querySelectorAll('.tab-pane.active, .tab-content.active, [role="tabpanel"]:not([hidden])');
            const expandedAccordions = document.querySelectorAll('.accordion-collapse.show, .collapse.show');

            return visibleModals.length > 0 ||
                   visibleDropdowns.length > 0 ||
                   activeTabs.length > 0 ||
                   expandedAccordions.length > 0 ||
                   document.querySelector('.active, .selected, .open, .expanded, .show');
          });

          // Capture screenshot of this state
          const screenshotBuffer = await page.screenshot({
            fullPage: true,
            type: 'png'
          });

          // Save with state name
          const localPath = await this.fileManager.saveScreenshot(url, screenshotBuffer, stateName);
          this.stats.screenshotsCaptured++;
          this.stats.totalSizeBytes += screenshotBuffer.length;

          this.screenshotLog.push({
            url,
            local_path: localPath,
            type: 'interactive',
            trigger: {
              element: element.tag,
              text: element.text,
              action: 'click'
            },
            size_bytes: screenshotBuffer.length,
            status: 'success',
            timestamp: new Date().toISOString()
          });

          this.log(`Saved interactive screenshot: ${localPath} (${Math.round(screenshotBuffer.length / 1024)}KB)`);
          this.emitProgress();

          // Try to reset the state (close modals, reset tabs, etc.)
          await page.evaluate(() => {
            // Press Escape to close any modals/dropdowns
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

            // Click outside to close dropdowns
            document.body.click();
          });

          await this.delay(300);

          // Restore scroll position
          await page.evaluate((scrollY) => window.scrollTo(0, scrollY), beforeScroll);

        } catch (error) {
          this.log(`Interactive screenshot error for "${element.text}": ${error.message}`, 'error');
        }
      }

      this.log(`Captured ${capturedStates.size} interactive states`);

    } catch (error) {
      this.log(`Error capturing interactive screenshots: ${error.message}`, 'error');
    }
  }

  sanitizeStateName(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 30) || 'state';
  }

  async downloadAsset(url, type, retries = 1) {
    if (this.downloadedAssets.has(url)) {
      return;
    }

    this.downloadedAssets.add(url);

    try {
      this.log(`Downloading: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Check content length
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > this.maxFileSize) {
        throw new Error(`File too large: ${contentLength} bytes`);
      }

      const buffer = await response.arrayBuffer();

      if (buffer.byteLength > this.maxFileSize) {
        throw new Error(`File too large: ${buffer.byteLength} bytes`);
      }

      const localPath = await this.fileManager.saveImage(url, Buffer.from(buffer), type);
      this.stats.imagesDownloaded++;
      this.stats.totalSizeBytes += buffer.byteLength;

      this.imageLog.push({
        url,
        local_path: localPath,
        type,
        status: 'success'
      });

      this.log(`Downloaded: ${localPath}`);
      this.emitProgress();

    } catch (error) {
      if (retries > 0 && error.message.includes('5')) {
        // Retry on 5xx errors
        await this.delay(1000);
        return this.downloadAsset(url, type, retries - 1);
      }

      this.handleError(url, error);
    }
  }

  async saveInlineSvg(svg) {
    try {
      const filename = `${svg.id}.svg`;
      const localPath = await this.fileManager.saveImage('inline', svg.content, 'svg_inline', filename);
      this.stats.imagesDownloaded++;
      this.stats.totalSizeBytes += Buffer.byteLength(svg.content, 'utf8');

      this.imageLog.push({
        url: `inline:${svg.id}`,
        local_path: localPath,
        type: 'svg_inline',
        status: 'success'
      });

      this.log(`Saved inline SVG: ${filename}`);
      this.emitProgress();

    } catch (error) {
      this.handleError(`inline:${svg.id}`, error);
    }
  }

  async downloadAndParseCss(url) {
    if (this.downloadedAssets.has(url)) {
      return;
    }

    this.downloadedAssets.add(url);

    try {
      this.log(`Downloading CSS: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const cssContent = await response.text();

      // Save CSS file
      const localPath = await this.fileManager.saveCss(url, cssContent);
      this.stats.totalSizeBytes += Buffer.byteLength(cssContent, 'utf8');

      this.log(`Saved CSS: ${localPath}`);

      // Extract background images from CSS
      const extractor = new AssetExtractor(this.targetUrl);
      const backgroundImages = extractor.extractCssBackgroundImages(cssContent, url);

      for (const image of backgroundImages) {
        if (!this.downloadedAssets.has(image.url) && !this.shouldStop) {
          await this.downloadAsset(image.url, 'css_background');
        }
      }

    } catch (error) {
      this.handleError(url, error);
    }
  }

  async downloadJs(url) {
    if (this.downloadedAssets.has(url)) {
      return;
    }

    this.downloadedAssets.add(url);

    try {
      this.log(`Downloading JS: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const jsContent = await response.text();

      // Check size
      if (Buffer.byteLength(jsContent, 'utf8') > this.maxFileSize) {
        throw new Error('File too large');
      }

      const localPath = await this.fileManager.saveJs(url, jsContent);
      this.stats.totalSizeBytes += Buffer.byteLength(jsContent, 'utf8');

      this.log(`Saved JS: ${localPath}`);

    } catch (error) {
      this.handleError(url, error);
    }
  }

  handleError(url, error) {
    this.stats.errorsEncountered++;
    const errorMessage = error.message || 'Unknown error';

    this.errorLog.push({
      url,
      error: errorMessage,
      timestamp: new Date().toISOString()
    });

    this.log(`Error: ${url} - ${errorMessage}`, 'error');
    this.emitProgress();
  }

  async saveLog() {
    const logData = {
      scrape_id: this.scrapeId,
      started_at: this.startedAt,
      completed_at: this.completedAt,
      target_url: this.targetUrl,
      config: {
        max_depth: this.maxDepth,
        respect_robots_txt: true
      },
      stats: {
        pages_scraped: this.stats.pagesScraped,
        images_downloaded: this.stats.imagesDownloaded,
        screenshots_captured: this.stats.screenshotsCaptured,
        errors_encountered: this.stats.errorsEncountered,
        total_size_bytes: this.stats.totalSizeBytes
      },
      pages: this.pageLog,
      images: this.imageLog,
      screenshots: this.screenshotLog,
      errors: this.errorLog
    };

    await this.fileManager.saveLog(logData);
    this.log('Saved scrape log to logs/scrape_log.json');
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      scrapeId: this.scrapeId,
      targetUrl: this.targetUrl,
      stats: this.stats,
      queueLength: this.urlQueue.length,
      visitedCount: this.visitedUrls.size
    };
  }
}
