import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export class FileManager {
  constructor(outputDir = './scraped_output') {
    this.outputDir = outputDir;
    this.fileTracker = new Map(); // Track filenames to handle duplicates
  }

  async ensureDirectories() {
    const dirs = [
      'pages',
      'images/img_tags',
      'images/css_backgrounds',
      'images/svg_inline',
      'images/favicons',
      'images/og_meta',
      'images/web_screenshots',
      'assets/css',
      'assets/js',
      'logs'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(this.outputDir, dir), { recursive: true });
    }
  }

  sanitizeFilename(filename) {
    // Remove or replace invalid characters
    return filename
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 200); // Limit filename length
  }

  urlToPageFilename(url) {
    try {
      const parsed = new URL(url);
      let pathname = parsed.pathname;

      // Handle root path
      if (pathname === '/' || pathname === '') {
        return 'index.html';
      }

      // Remove leading/trailing slashes and convert to filename
      pathname = pathname.replace(/^\/+|\/+$/g, '');

      // Replace slashes with underscores
      let filename = pathname.replace(/\//g, '_');

      // Add .html extension if not present
      if (!filename.endsWith('.html') && !filename.endsWith('.htm')) {
        filename += '.html';
      }

      return this.sanitizeFilename(filename);
    } catch {
      return 'page_' + this.generateHash(url) + '.html';
    }
  }

  generateHash(content) {
    return crypto.createHash('md5').update(content).digest('hex').substring(0, 12);
  }

  async getUniqueFilename(dir, filename) {
    const key = `${dir}/${filename}`;

    if (!this.fileTracker.has(key)) {
      this.fileTracker.set(key, 0);
      return filename;
    }

    const count = this.fileTracker.get(key) + 1;
    this.fileTracker.set(key, count);

    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    return `${base}_${count}${ext}`;
  }

  getFilenameFromUrl(url) {
    try {
      const parsed = new URL(url);
      let filename = path.basename(parsed.pathname);

      // Handle URLs without filenames
      if (!filename || filename === '' || !filename.includes('.')) {
        const ext = this.guessExtension(url);
        filename = this.generateHash(url) + ext;
      }

      return this.sanitizeFilename(filename);
    } catch {
      return this.generateHash(url) + '.bin';
    }
  }

  guessExtension(url) {
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes('.png') || lowerUrl.includes('png')) return '.png';
    if (lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg') || lowerUrl.includes('jpeg')) return '.jpg';
    if (lowerUrl.includes('.gif') || lowerUrl.includes('gif')) return '.gif';
    if (lowerUrl.includes('.webp') || lowerUrl.includes('webp')) return '.webp';
    if (lowerUrl.includes('.svg') || lowerUrl.includes('svg')) return '.svg';
    if (lowerUrl.includes('.ico') || lowerUrl.includes('icon')) return '.ico';
    if (lowerUrl.includes('.css')) return '.css';
    if (lowerUrl.includes('.js')) return '.js';
    return '.bin';
  }

  async savePage(url, content) {
    const filename = this.urlToPageFilename(url);
    const dir = path.join(this.outputDir, 'pages');
    const uniqueFilename = await this.getUniqueFilename(dir, filename);
    const filePath = path.join(dir, uniqueFilename);

    await fs.writeFile(filePath, content, 'utf-8');
    return `pages/${uniqueFilename}`;
  }

  async saveImage(url, content, type, suggestedFilename = null) {
    const typeToDir = {
      'img_tag': 'images/img_tags',
      'css_background': 'images/css_backgrounds',
      'svg_inline': 'images/svg_inline',
      'favicon': 'images/favicons',
      'og_meta': 'images/og_meta'
    };

    const dir = typeToDir[type] || 'images/img_tags';
    const fullDir = path.join(this.outputDir, dir);

    let filename;
    if (suggestedFilename) {
      filename = this.sanitizeFilename(suggestedFilename);
    } else {
      filename = this.getFilenameFromUrl(url);
    }

    const uniqueFilename = await this.getUniqueFilename(fullDir, filename);
    const filePath = path.join(fullDir, uniqueFilename);

    if (Buffer.isBuffer(content)) {
      await fs.writeFile(filePath, content);
    } else {
      await fs.writeFile(filePath, content, 'utf-8');
    }

    return `${dir}/${uniqueFilename}`;
  }

  urlToScreenshotFilename(url, state = null) {
    try {
      const parsed = new URL(url);
      let pathname = parsed.pathname;

      // Handle root path
      if (pathname === '/' || pathname === '') {
        pathname = 'index';
      } else {
        // Remove leading/trailing slashes and convert to filename
        pathname = pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '_');
      }

      // Build filename with state
      let filename;
      if (state && state !== 'initial') {
        // Interactive state: screenshot_pagename_statename.png
        filename = `screenshot_${pathname}_${state}.png`;
      } else {
        // Initial state: screenshot_pagename_initial.png
        filename = `screenshot_${pathname}_initial.png`;
      }

      return this.sanitizeFilename(filename);
    } catch {
      const stateStr = state ? `_${state}` : '_initial';
      return 'screenshot_' + this.generateHash(url) + stateStr + '.png';
    }
  }

  async saveScreenshot(url, screenshotBuffer, state = null) {
    const dir = 'images/web_screenshots';
    const fullDir = path.join(this.outputDir, dir);
    const filename = this.urlToScreenshotFilename(url, state);
    const uniqueFilename = await this.getUniqueFilename(fullDir, filename);
    const filePath = path.join(fullDir, uniqueFilename);

    await fs.writeFile(filePath, screenshotBuffer);
    return `${dir}/${uniqueFilename}`;
  }

  async saveCss(url, content) {
    const filename = this.getFilenameFromUrl(url);
    const dir = path.join(this.outputDir, 'assets/css');
    const uniqueFilename = await this.getUniqueFilename(dir, filename);
    const filePath = path.join(dir, uniqueFilename);

    await fs.writeFile(filePath, content, 'utf-8');
    return `assets/css/${uniqueFilename}`;
  }

  async saveJs(url, content) {
    const filename = this.getFilenameFromUrl(url);
    const dir = path.join(this.outputDir, 'assets/js');
    const uniqueFilename = await this.getUniqueFilename(dir, filename);
    const filePath = path.join(dir, uniqueFilename);

    await fs.writeFile(filePath, content, 'utf-8');
    return `assets/js/${uniqueFilename}`;
  }

  async saveLog(logData) {
    const filePath = path.join(this.outputDir, 'logs', 'scrape_log.json');
    await fs.writeFile(filePath, JSON.stringify(logData, null, 2), 'utf-8');
    return 'logs/scrape_log.json';
  }

  getOutputDir() {
    return path.resolve(this.outputDir);
  }
}
