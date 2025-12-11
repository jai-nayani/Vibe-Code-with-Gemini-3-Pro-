import sharp from 'sharp';
import * as cheerio from 'cheerio';

export class AnalysisCompressor {
  constructor(storage, bucketName) {
    this.storage = storage;
    this.bucketName = bucketName;
    this.bucket = storage.bucket(bucketName);
  }

  log(message) {
    console.log(`[${new Date().toISOString()}] [AnalysisCompressor] ${message}`);
  }

  // Get signed URL for a file (valid for 7 days)
  async getSignedUrl(filePath) {
    const [url] = await this.bucket.file(filePath).getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000  // 7 days
    });
    return url;
  }

  // Find the most recent scrape folder
  async findLatestScrape() {
    this.log('Finding latest scrape...');
    const [files] = await this.bucket.getFiles({ prefix: 'scrapes/' });

    // Extract unique scrape IDs from file paths
    const scrapeIds = new Set();
    for (const file of files) {
      const match = file.name.match(/^scrapes\/([^/]+)\//);
      if (match) {
        scrapeIds.add(match[1]);
      }
    }

    if (scrapeIds.size === 0) {
      throw new Error('No scrapes found in bucket');
    }

    // Get metadata for each scrape to find the newest
    let latestScrape = null;
    let latestTime = null;

    for (const scrapeId of scrapeIds) {
      try {
        const logFile = this.bucket.file(`scrapes/${scrapeId}/logs/scrape_log.json`);
        const [metadata] = await logFile.getMetadata();
        const updated = new Date(metadata.updated || metadata.timeCreated);

        if (!latestTime || updated > latestTime) {
          latestTime = updated;
          latestScrape = scrapeId;
        }
      } catch (e) {
        // Skip scrapes without valid log files
      }
    }

    if (!latestScrape) {
      throw new Error('No valid scrapes found');
    }

    this.log(`Found latest scrape: ${latestScrape}`);
    return latestScrape;
  }

  // Load and parse scrape_log.json
  async loadScrapeLog(scrapeId) {
    this.log(`Loading scrape log for ${scrapeId}...`);
    const logFile = this.bucket.file(`scrapes/${scrapeId}/logs/scrape_log.json`);

    try {
      const [buffer] = await logFile.download();
      const scrapeLog = JSON.parse(buffer.toString());
      this.log(`Loaded scrape log: ${scrapeLog.stats?.pages_scraped || 0} pages`);
      return scrapeLog;
    } catch (error) {
      throw new Error(`Invalid scrape data: missing or corrupt scrape_log.json - ${error.message}`);
    }
  }

  // ============================================
  // FIXED: Select key screenshots (handles SPAs properly)
  // ============================================
  async selectKeyScreenshots(scrapeId, scrapeLog) {
    this.log('Selecting key screenshots...');
    const screenshots = scrapeLog.screenshots || [];
    const successScreenshots = screenshots.filter(s => s.status === 'success');
    
    this.log(`Total screenshots: ${screenshots.length}, successful: ${successScreenshots.length}`);

    // Detect if this is a single-page app (only index pages)
    const hasOnlyIndexPages = successScreenshots.every(s => 
      s.local_path?.includes('screenshot_index_') || 
      s.local_path?.includes('/index')
    );
    
    const isSinglePageApp = hasOnlyIndexPages || (scrapeLog.stats?.pages_scraped === 1);
    this.log(`Single-page app detected: ${isSinglePageApp}`);

    const selected = [];
    const maxScreenshots = 15; // Increased from 10 to capture more states

    // ============================================
    // STRATEGY FOR SINGLE-PAGE APPS (like portfolios)
    // ============================================
    if (isSinglePageApp) {
      this.log('Using SPA selection strategy - capturing ALL unique states');
      
      // For SPAs, take ALL unique screenshots (up to max)
      // Priority 1: Initial state
      const initial = successScreenshots.find(s => 
        s.local_path?.includes('_initial')
      );
      if (initial) {
        selected.push({ ...initial, priority: 'initial' });
        this.log(`Selected initial: ${initial.local_path}`);
      }

      // Priority 2: ALL interactive states (these are the modals/sections)
      const interactive = successScreenshots.filter(s => 
        !s.local_path?.includes('_initial') &&
        !selected.some(sel => sel.local_path === s.local_path)
      );

      // Deduplicate by extracting meaningful names and removing near-duplicates
      const seen = new Set();
      for (const screenshot of interactive) {
        // Extract the meaningful part of the filename
        const filename = screenshot.local_path?.split('/').pop() || '';
        const meaningfulPart = this.extractMeaningfulName(filename);
        
        // Skip if we've seen a very similar name
        if (!seen.has(meaningfulPart) && selected.length < maxScreenshots) {
          seen.add(meaningfulPart);
          selected.push({ ...screenshot, priority: 'interactive', name: meaningfulPart });
          this.log(`Selected interactive: ${filename} (${meaningfulPart})`);
        }
      }
    } 
    // ============================================
    // STRATEGY FOR MULTI-PAGE SITES
    // ============================================
    else {
      this.log('Using multi-page selection strategy');
      
      // Priority 1: Homepage initial state
      const homeInitial = successScreenshots.find(s =>
        s.local_path?.includes('screenshot_index_initial')
      );
      if (homeInitial) {
        selected.push({ ...homeInitial, priority: 'home-initial' });
      }

      // Priority 2: Homepage interactive states (max 5 for multi-page)
      const homeInteractive = successScreenshots.filter(s =>
        s.local_path?.includes('screenshot_index_') &&
        !s.local_path?.includes('_initial')
      ).slice(0, 5);
      selected.push(...homeInteractive.map(s => ({ ...s, priority: 'home-interactive' })));

      // Priority 3: Other page initial states (max 5)
      const otherInitials = successScreenshots.filter(s =>
        !s.local_path?.includes('screenshot_index_') &&
        s.local_path?.includes('_initial')
      ).slice(0, 5);
      selected.push(...otherInitials.map(s => ({ ...s, priority: 'page-initial' })));

      // Priority 4: Other interactive states (fill remaining slots)
      const remaining = maxScreenshots - selected.length;
      if (remaining > 0) {
        const otherInteractive = successScreenshots.filter(s =>
          !s.local_path?.includes('screenshot_index_') &&
          !s.local_path?.includes('_initial') &&
          !selected.some(sel => sel.local_path === s.local_path)
        ).slice(0, remaining);
        selected.push(...otherInteractive.map(s => ({ ...s, priority: 'page-interactive' })));
      }
    }

    this.log(`Final selection: ${selected.length} screenshots`);
    selected.forEach(s => this.log(`  - ${s.local_path} (${s.priority})`));
    
    return selected.slice(0, maxScreenshots);
  }

  // Extract meaningful name from screenshot filename
  extractMeaningfulName(filename) {
    // Remove extension and common prefixes
    let name = filename
      .replace(/\.(png|jpg|jpeg)$/i, '')
      .replace(/^screenshot_/, '')
      .replace(/^index_/, '');
    
    // Take first 3 words to identify the state
    const words = name.split('_').slice(0, 3).join('_');
    return words.toLowerCase();
  }

  // Compress a screenshot
  async compressScreenshot(buffer) {
    const compressed = await sharp(buffer)
      .resize(1280, null, { withoutEnlargement: true }) // Increased from 1024 for better detail
      .jpeg({ quality: 80 }) // Slightly higher quality
      .toBuffer();
    return compressed;
  }

  // ============================================
  // IMPROVED: Extract text and structure from HTML
  // ============================================
  extractTextFromHtml(htmlContent, pageUrl = '') {
    const $ = cheerio.load(htmlContent);

    // Remove scripts, styles, and comments
    $('script, style, noscript, iframe, svg').remove();

    // Extract title
    const title = $('title').text().trim() || 
                  $('h1').first().text().trim() ||
                  $('meta[property="og:title"]').attr('content') || '';

    // Extract meta description
    const metaDescription = $('meta[name="description"]').attr('content') ||
                           $('meta[property="og:description"]').attr('content') || '';

    // Extract keywords
    const keywords = $('meta[name="keywords"]').attr('content') || '';

    // Extract ALL headings (increased limit)
    const headings = [];
    $('h1, h2, h3, h4, h5, h6').each((i, el) => {
      if (headings.length < 50) { // Increased from 30
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text && text.length > 1 && text.length < 300) {
          headings.push({
            level: el.tagName.toLowerCase(),
            text: text
          });
        }
      }
    });

    // Extract navigation items (increased limit)
    const navigation = [];
    const navSeen = new Set();
    $('nav a, header a, .nav a, .navigation a, .menu a, [role="navigation"] a').each((i, el) => {
      if (navigation.length < 30) { // Increased from 20
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text && text.length > 0 && text.length < 50 && !navSeen.has(text.toLowerCase())) {
          navSeen.add(text.toLowerCase());
          navigation.push(text);
        }
      }
    });

    // Extract paragraphs (new!)
    const paragraphs = [];
    $('p').each((i, el) => {
      if (paragraphs.length < 30) {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text && text.length > 30 && text.length < 1000) {
          paragraphs.push(text);
        }
      }
    });

    // Extract body text (increased limit for SPAs)
    const bodyText = $('body').text()
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 15000); // Increased from 8000

    // Extract contact info with better patterns
    const pageText = $('body').text();
    
    // Phone patterns (more comprehensive)
    const phonePatterns = [
      /(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g,
      /(\+\d{1,3}[-.\s]?\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4})/g
    ];
    const phones = new Set();
    for (const pattern of phonePatterns) {
      const matches = pageText.match(pattern) || [];
      matches.forEach(m => phones.add(m.trim()));
    }

    // Email pattern
    const emails = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];

    // Social links (new!)
    const socialLinks = {};
    $('a[href*="linkedin.com"]').each((i, el) => {
      socialLinks.linkedin = $(el).attr('href');
    });
    $('a[href*="github.com"]').each((i, el) => {
      socialLinks.github = $(el).attr('href');
    });
    $('a[href*="twitter.com"], a[href*="x.com"]').each((i, el) => {
      socialLinks.twitter = $(el).attr('href');
    });

    // Extract CTAs (improved detection)
    const ctas = [];
    const ctaSeen = new Set();
    $('button, a.btn, a.button, [role="button"], .cta, .btn, [class*="button"], [class*="cta"]').each((i, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text && text.length > 1 && text.length < 50 && !ctaSeen.has(text.toLowerCase())) {
        ctaSeen.add(text.toLowerCase());
        ctas.push(text);
      }
    });

    // Identify sections (improved detection)
    const sections = [];
    const sectionKeywords = {
      'hero': /hero|banner|jumbotron|landing|intro/i,
      'about': /about|bio|story|who.*we|who.*i|profile/i,
      'services': /service|offer|what.*we.*do|solution/i,
      'experience': /experience|career|work.*history|employment/i,
      'education': /education|school|degree|university|academic/i,
      'skills': /skill|technolog|expertise|competenc|stack/i,
      'projects': /project|portfolio|work|case.*stud/i,
      'testimonials': /testimonial|review|feedback|client.*say/i,
      'contact': /contact|reach|get.*in.*touch|connect/i,
      'footer': /footer/i
    };

    const bodyLower = bodyText.toLowerCase();
    for (const [section, pattern] of Object.entries(sectionKeywords)) {
      if (pattern.test(bodyLower) || $(`#${section}, .${section}, [data-section="${section}"]`).length > 0) {
        sections.push(section);
      }
    }

    // Also check section elements
    $('section, [class*="section"]').each((i, el) => {
      const id = $(el).attr('id') || '';
      const classes = $(el).attr('class') || '';
      const text = $(el).text().substring(0, 200).toLowerCase();
      
      for (const [section, pattern] of Object.entries(sectionKeywords)) {
        if (pattern.test(id) || pattern.test(classes) || pattern.test(text)) {
          if (!sections.includes(section)) {
            sections.push(section);
          }
        }
      }
    });

    // Word count
    const wordCount = bodyText.split(/\s+/).filter(w => w.length > 0).length;

    return {
      title,
      metaDescription,
      keywords,
      headings: headings.map(h => typeof h === 'object' ? h.text : h), // Flatten for compatibility
      headingsWithLevels: headings, // Keep structured version
      navigation: [...new Set(navigation)],
      paragraphs: paragraphs.slice(0, 20),
      bodyText,
      contactInfo: {
        phones: [...phones].slice(0, 5),
        emails: [...new Set(emails)].slice(0, 5),
        socialLinks
      },
      ctas: ctas.slice(0, 15),
      sections: [...new Set(sections)],
      wordCount
    };
  }

  // Extract design tokens from CSS
  extractDesignTokens(cssContent) {
    const colors = {};
    const fonts = new Set();
    const fontSizes = [];
    const borderRadii = [];
    const shadows = [];
    const spacing = [];

    // Extract colors (hex, rgb, rgba, hsl)
    const colorMatches = cssContent.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)/g) || [];
    for (const color of colorMatches) {
      colors[color] = (colors[color] || 0) + 1;
    }

    // Extract CSS custom properties (variables)
    const cssVarMatches = cssContent.match(/--[\w-]+:\s*[^;]+/g) || [];
    for (const match of cssVarMatches) {
      const [name, value] = match.split(':').map(s => s.trim());
      if (/color|bg|background|primary|secondary|accent/i.test(name)) {
        const colorValue = value.replace(/['"]/g, '');
        if (colorValue.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/)) {
          colors[colorValue] = (colors[colorValue] || 0) + 5; // Boost CSS vars
        }
      }
    }

    // Extract font families
    const fontMatches = cssContent.match(/font-family:\s*([^;]+)/g) || [];
    for (const match of fontMatches) {
      const font = match.replace('font-family:', '').trim().split(',')[0].replace(/["']/g, '').trim();
      if (font && !font.includes('inherit') && font !== 'sans-serif' && font !== 'serif' && font !== 'monospace') {
        fonts.add(font);
      }
    }

    // Extract font sizes
    const sizeMatches = cssContent.match(/font-size:\s*([^;]+)/g) || [];
    for (const match of sizeMatches) {
      const size = match.replace('font-size:', '').trim();
      if (size && !fontSizes.includes(size)) {
        fontSizes.push(size);
      }
    }

    // Extract border-radius
    const radiusMatches = cssContent.match(/border-radius:\s*([^;]+)/g) || [];
    for (const match of radiusMatches) {
      const radius = match.replace('border-radius:', '').trim();
      if (radius && !borderRadii.includes(radius)) {
        borderRadii.push(radius);
      }
    }

    // Extract box-shadows
    const shadowMatches = cssContent.match(/box-shadow:\s*([^;]+)/g) || [];
    for (const match of shadowMatches) {
      const shadow = match.replace('box-shadow:', '').trim();
      if (shadow && shadow !== 'none' && !shadows.includes(shadow)) {
        shadows.push(shadow);
      }
    }

    // Extract spacing (margin, padding)
    const spacingMatches = cssContent.match(/(margin|padding):\s*(\d+px)/g) || [];
    for (const match of spacingMatches) {
      const value = match.match(/\d+px/)?.[0];
      if (value && !spacing.includes(value)) {
        spacing.push(value);
      }
    }

    // Sort colors by frequency
    const sortedColors = Object.entries(colors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([color]) => color);

    return {
      colors: {
        all: sortedColors,
        primary: sortedColors[0] || '#000000',
        secondary: sortedColors[1] || '#333333',
        accent: sortedColors.find(c => c.includes('rgb') && c.includes('255')) || sortedColors[2] || '#0066cc',
        background: sortedColors.find(c => c === '#ffffff' || c === '#fff' || c.includes('255, 255, 255')) || '#ffffff',
        text: sortedColors.find(c => c.includes('#1') || c.includes('#2') || c.includes('#3')) || '#333333'
      },
      typography: {
        fonts: [...fonts].slice(0, 5),
        headingFont: [...fonts][0] || 'sans-serif',
        bodyFont: [...fonts][1] || [...fonts][0] || 'sans-serif',
        sizes: {
          h1: fontSizes.find(s => parseInt(s) >= 36) || '48px',
          h2: fontSizes.find(s => parseInt(s) >= 28 && parseInt(s) < 36) || '36px',
          h3: fontSizes.find(s => parseInt(s) >= 20 && parseInt(s) < 28) || '24px',
          body: fontSizes.find(s => parseInt(s) >= 14 && parseInt(s) <= 18) || '16px',
          small: fontSizes.find(s => parseInt(s) < 14) || '14px'
        }
      },
      spacing: {
        base: spacing.find(s => parseInt(s) === 8) || '8px',
        common: spacing.slice(0, 6)
      },
      borderRadius: {
        common: borderRadii.slice(0, 5),
        buttons: borderRadii.find(r => parseInt(r) <= 8) || '4px',
        cards: borderRadii.find(r => parseInt(r) >= 8) || '8px'
      },
      shadows: shadows.slice(0, 5)
    };
  }

  // Build site structure map
  buildStructureMap(pages, scrapeLog) {
    const pageCount = pages.length;
    const pageTypes = [];
    const hierarchy = {};
    const components = [];
    const features = {
      hasMobileNav: false,
      hasSearch: false,
      hasBlog: false,
      hasEcommerce: false,
      hasForms: false,
      hasVideo: false,
      hasMap: false,
      hasSocialLinks: false,
      isSinglePage: pageCount === 1
    };

    // Analyze pages
    for (const page of pages) {
      const pathLower = (page.path || '').toLowerCase();
      const textLower = (page.bodyText || '').toLowerCase();

      // Detect page types
      if (pathLower === '/' || pathLower === '/index' || pathLower.includes('index.html')) pageTypes.push('home');
      if (pathLower.includes('about') || textLower.includes('about me') || textLower.includes('about us')) pageTypes.push('about');
      if (pathLower.includes('service') || textLower.includes('our services')) pageTypes.push('services');
      if (pathLower.includes('contact') || textLower.includes('contact us') || textLower.includes('get in touch')) pageTypes.push('contact');
      if (pathLower.includes('blog') || pathLower.includes('news') || textLower.includes('latest posts')) pageTypes.push('blog');
      if (pathLower.includes('product') || pathLower.includes('shop') || textLower.includes('add to cart')) pageTypes.push('products');
      if (pathLower.includes('portfolio') || textLower.includes('my work') || textLower.includes('my projects')) pageTypes.push('portfolio');

      // Build hierarchy
      if (page.navigation) {
        for (const nav of page.navigation) {
          if (!hierarchy[nav]) {
            hierarchy[nav] = pathLower;
          }
        }
      }

      // Detect features
      if (textLower.includes('menu') || textLower.includes('hamburger') || textLower.includes('☰')) features.hasMobileNav = true;
      if (textLower.includes('search')) features.hasSearch = true;
      if (textLower.includes('blog') || textLower.includes('article') || textLower.includes('posted on')) features.hasBlog = true;
      if (textLower.includes('cart') || textLower.includes('shop') || textLower.includes('buy now') || textLower.includes('add to cart')) features.hasEcommerce = true;
      if (textLower.includes('form') || textLower.includes('submit') || textLower.includes('send message')) features.hasForms = true;
      if (textLower.includes('video') || textLower.includes('youtube') || textLower.includes('vimeo') || textLower.includes('watch')) features.hasVideo = true;
      if (textLower.includes('map') || textLower.includes('location') || textLower.includes('directions') || textLower.includes('find us')) features.hasMap = true;
      if (textLower.includes('facebook') || textLower.includes('twitter') || textLower.includes('instagram') || textLower.includes('linkedin') || textLower.includes('github')) features.hasSocialLinks = true;

      // For single-page sites, detect sections
      if (features.isSinglePage) {
        if (page.sections) {
          for (const section of page.sections) {
            if (!pageTypes.includes(section)) {
              pageTypes.push(section);
            }
          }
        }
      }
    }

    // Detect components from screenshots
    const screenshotCount = scrapeLog.screenshots?.length || 0;
    if (screenshotCount > 0) {
      components.push({ type: 'navbar', variant: 'standard', count: 1 });
      if (pages.some(p => p.sections?.includes('hero'))) {
        components.push({ type: 'hero', variant: 'image-background', count: 1 });
      }
      if (features.hasForms) {
        components.push({ type: 'contact-form', variant: 'standard', count: 1 });
      }
      components.push({ type: 'footer', variant: 'standard', count: 1 });
      
      // For portfolios, add card components
      if (pageTypes.includes('portfolio') || pageTypes.includes('projects')) {
        components.push({ type: 'project-card', variant: 'grid', count: screenshotCount - 1 });
      }
    }

    return {
      pageCount,
      pageTypes: [...new Set(pageTypes)],
      hierarchy,
      components,
      features,
      isSinglePage: features.isSinglePage
    };
  }

  // Main method: compile the full analysis package
  async compileAnalysisPackage(scrapeId) {
    this.log(`Compiling analysis package for ${scrapeId}...`);
    const processingErrors = [];

    // Load scrape log
    const scrapeLog = await this.loadScrapeLog(scrapeId);

    // Select and compress screenshots (FIXED for SPAs)
    const selectedScreenshots = await this.selectKeyScreenshots(scrapeId, scrapeLog);
    const compressedScreenshots = [];

    for (const screenshot of selectedScreenshots) {
      try {
        const gcsPath = `scrapes/${scrapeId}/${screenshot.local_path}`;
        this.log(`Processing screenshot: ${gcsPath}`);

        const [buffer] = await this.bucket.file(gcsPath).download();
        const compressed = await this.compressScreenshot(buffer);

        // Get dimensions
        const metadata = await sharp(compressed).metadata();

        // Generate output filename (convert to .jpg)
        const filename = screenshot.local_path.split('/').pop().replace('.png', '.jpg');
        const outputPath = `analysis/${scrapeId}/screenshots/${filename}`;

        // Upload compressed screenshot
        await this.bucket.file(outputPath).save(compressed, {
          contentType: 'image/jpeg',
          metadata: { cacheControl: 'public, max-age=3600' }
        });

        // Get signed URL for the screenshot
        const screenshotUrl = await this.getSignedUrl(outputPath);

        // Extract meaningful name for Gemini
        const meaningfulName = this.extractMeaningfulDisplayName(filename);

        compressedScreenshots.push({
          id: filename.replace('.jpg', ''),
          name: meaningfulName, // Human-readable name
          page: screenshot.local_path.includes('index') ? 'index' :
                screenshot.local_path.match(/screenshot_([^_]+)_/)?.[1] || 'unknown',
          state: screenshot.priority || 'interactive',
          filename,
          url: screenshotUrl,
          dimensions: `${metadata.width}x${metadata.height}`,
          sizeBytes: compressed.length
        });

        this.log(`Compressed: ${filename} → ${meaningfulName} (${Math.round(compressed.length / 1024)}KB)`);
      } catch (error) {
        this.log(`Error processing screenshot: ${error.message}`);
        processingErrors.push({ type: 'screenshot', path: screenshot.local_path, error: error.message });
      }
    }

    // Extract content from HTML pages
    const pages = [];
    const allNavigation = new Set();
    const allCtas = new Set();
    const allPhones = new Set();
    const allEmails = new Set();
    const allSocialLinks = {};
    const allSections = new Set();
    const allParagraphs = [];
    let siteTitle = '';
    let siteDescription = '';

    const pagesList = scrapeLog.pages || [];
    for (const pageInfo of pagesList) {
      try {
        const gcsPath = `scrapes/${scrapeId}/${pageInfo.local_path}`;
        this.log(`Processing page: ${gcsPath}`);

        const [buffer] = await this.bucket.file(gcsPath).download();
        const htmlContent = buffer.toString();
        const extracted = this.extractTextFromHtml(htmlContent, pageInfo.url);

        // Capture site-level info from homepage
        if (pageInfo.url === scrapeLog.target_url || pageInfo.local_path?.includes('index')) {
          siteTitle = extracted.title;
          siteDescription = extracted.metaDescription;
        }

        // Collect global items
        extracted.navigation.forEach(n => allNavigation.add(n));
        extracted.ctas.forEach(c => allCtas.add(c));
        extracted.contactInfo.phones.forEach(p => allPhones.add(p));
        extracted.contactInfo.emails.forEach(e => allEmails.add(e));
        extracted.sections.forEach(s => allSections.add(s));
        allParagraphs.push(...extracted.paragraphs);
        
        // Merge social links
        if (extracted.contactInfo.socialLinks) {
          Object.assign(allSocialLinks, extracted.contactInfo.socialLinks);
        }

        pages.push({
          path: new URL(pageInfo.url).pathname,
          title: extracted.title,
          headings: extracted.headings.slice(0, 15),
          headingsWithLevels: extracted.headingsWithLevels?.slice(0, 15),
          paragraphs: extracted.paragraphs.slice(0, 10),
          bodyText: extracted.bodyText.substring(0, 5000),
          sections: extracted.sections,
          wordCount: extracted.wordCount
        });
      } catch (error) {
        this.log(`Error processing page: ${error.message}`);
        processingErrors.push({ type: 'page', path: pageInfo.local_path, error: error.message });
      }
    }

    // Extract design tokens from CSS
    let design = {
      colors: { all: [], primary: '#000000', secondary: '#333333', accent: '#0066cc', background: '#ffffff', text: '#333333' },
      typography: { fonts: [], headingFont: 'sans-serif', bodyFont: 'sans-serif', sizes: {} },
      spacing: { base: '8px', common: [] },
      borderRadius: { common: [], buttons: '4px', cards: '8px' },
      shadows: []
    };

    try {
      const [cssFiles] = await this.bucket.getFiles({ prefix: `scrapes/${scrapeId}/assets/css/` });
      let allCss = '';

      for (const cssFile of cssFiles.slice(0, 10)) { // Increased from 5
        try {
          const [buffer] = await cssFile.download();
          allCss += buffer.toString() + '\n';
        } catch (e) {
          // Skip unreadable CSS files
        }
      }

      if (allCss) {
        design = this.extractDesignTokens(allCss);
        this.log(`Extracted design tokens: ${design.colors.all.length} colors, ${design.typography.fonts.length} fonts`);
      }
    } catch (error) {
      this.log(`Error extracting design tokens: ${error.message}`);
      processingErrors.push({ type: 'css', error: error.message });
    }

    // Build structure map
    const structure = this.buildStructureMap(pages, scrapeLog);

    // Compile final package
    const analysisPackage = {
      version: '1.1', // Updated version
      generatedAt: new Date().toISOString(),
      source: {
        scrapeId,
        originalUrl: scrapeLog.target_url,
        scrapedAt: scrapeLog.started_at,
        pagesScraped: scrapeLog.stats?.pages_scraped || pages.length,
        screenshotsTotal: scrapeLog.screenshots?.length || 0,
        screenshotsSelected: compressedScreenshots.length
      },
      screenshots: compressedScreenshots,
      content: {
        siteTitle,
        siteDescription,
        pages,
        paragraphs: [...new Set(allParagraphs)].slice(0, 20), // Deduplicated paragraphs
        navigation: [...allNavigation].slice(0, 25),
        callsToAction: [...allCtas].slice(0, 15),
        sections: [...allSections],
        contactInfo: {
          phones: [...allPhones].slice(0, 5),
          emails: [...allEmails].slice(0, 5),
          socialLinks: allSocialLinks,
          addresses: []
        }
      },
      design,
      structure,
      assets: {
        logo: {
          found: false,
          url: null,
          dimensions: null
        },
        images: {
          total: scrapeLog.stats?.images_downloaded || 0,
          categories: {}
        },
        icons: {
          hasFavicon: scrapeLog.images?.some(i => i.type === 'favicon') || false,
          hasSvgIcons: scrapeLog.images?.some(i => i.type === 'svg_inline') || false,
          iconCount: scrapeLog.images?.filter(i => i.type === 'svg_inline' || i.type === 'favicon').length || 0
        }
      },
      seoData: {
        hasMetaDescription: !!siteDescription,
        hasOgTags: pages.some(p => p.bodyText?.includes('og:')),
        hasTwitterCards: false,
        hasStructuredData: false,
        robotsTxt: 'allowed'
      }
    };

    // Check for logo
    const logoImage = scrapeLog.images?.find(i =>
      i.local_path?.toLowerCase().includes('logo') ||
      i.url?.toLowerCase().includes('logo')
    );
    if (logoImage) {
      try {
        const logoPath = `scrapes/${scrapeId}/${logoImage.local_path}`;
        const logoUrl = await this.getSignedUrl(logoPath);
        analysisPackage.assets.logo = {
          found: true,
          url: logoUrl,
          dimensions: null
        };
      } catch (e) {
        this.log(`Could not get logo URL: ${e.message}`);
      }
    }

    // Check for profile photo (common in portfolios)
    const profileImage = scrapeLog.images?.find(i =>
      i.local_path?.toLowerCase().includes('profile') ||
      i.local_path?.toLowerCase().includes('avatar') ||
      i.local_path?.toLowerCase().includes('headshot')
    );
    if (profileImage) {
      try {
        const profilePath = `scrapes/${scrapeId}/${profileImage.local_path}`;
        const profileUrl = await this.getSignedUrl(profilePath);
        analysisPackage.assets.profilePhoto = {
          found: true,
          url: profileUrl
        };
      } catch (e) {
        // Ignore
      }
    }

    return { analysisPackage, processingErrors };
  }

  // Extract human-readable display name from screenshot filename
  extractMeaningfulDisplayName(filename) {
    let name = filename
      .replace(/\.(png|jpg|jpeg)$/i, '')
      .replace(/^screenshot_/, '')
      .replace(/^index_/, '');
    
    // Convert underscores to spaces and capitalize
    name = name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

    // Handle special cases
    if (name.toLowerCase() === 'initial') {
      return 'Homepage (Initial State)';
    }

    // Truncate very long names
    if (name.length > 50) {
      name = name.substring(0, 47) + '...';
    }

    return name || 'Screenshot';
  }

  // Save the analysis package to GCS
  async saveAnalysisPackage(scrapeId, analysisPackage) {
    const outputPath = `analysis/${scrapeId}/analysis_package.json`;
    const jsonContent = JSON.stringify(analysisPackage, null, 2);

    this.log(`Saving analysis package to ${outputPath} (${Math.round(jsonContent.length / 1024)}KB)`);

    await this.bucket.file(outputPath).save(jsonContent, {
      contentType: 'application/json',
      metadata: { cacheControl: 'public, max-age=3600' }
    });

    return await this.getSignedUrl(outputPath);
  }
}
