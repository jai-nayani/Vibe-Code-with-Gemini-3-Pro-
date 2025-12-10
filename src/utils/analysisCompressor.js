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

  // Select key screenshots (max 10)
  async selectKeyScreenshots(scrapeId, scrapeLog) {
    this.log('Selecting key screenshots...');
    const screenshots = scrapeLog.screenshots || [];
    const selected = [];
    const maxScreenshots = 10;

    // Priority 1: Homepage initial state
    const homeInitial = screenshots.find(s =>
      s.local_path?.includes('screenshot_index_initial') && s.status === 'success'
    );
    if (homeInitial) {
      selected.push({ ...homeInitial, priority: 'home-initial' });
    }

    // Priority 2: Homepage interactive states (max 2)
    const homeInteractive = screenshots.filter(s =>
      s.local_path?.includes('screenshot_index_') &&
      !s.local_path?.includes('_initial') &&
      s.status === 'success'
    ).slice(0, 2);
    selected.push(...homeInteractive.map(s => ({ ...s, priority: 'home-interactive' })));

    // Priority 3: Other page initial states (max 4)
    const otherInitials = screenshots.filter(s =>
      !s.local_path?.includes('screenshot_index_') &&
      s.local_path?.includes('_initial') &&
      s.status === 'success'
    ).slice(0, 4);
    selected.push(...otherInitials.map(s => ({ ...s, priority: 'page-initial' })));

    // Priority 4: Other interactive states (fill remaining slots)
    const remaining = maxScreenshots - selected.length;
    if (remaining > 0) {
      const otherInteractive = screenshots.filter(s =>
        !s.local_path?.includes('screenshot_index_') &&
        !s.local_path?.includes('_initial') &&
        s.status === 'success' &&
        !selected.some(sel => sel.local_path === s.local_path)
      ).slice(0, remaining);
      selected.push(...otherInteractive.map(s => ({ ...s, priority: 'page-interactive' })));
    }

    this.log(`Selected ${selected.length} screenshots`);
    return selected.slice(0, maxScreenshots);
  }

  // Compress a screenshot
  async compressScreenshot(buffer) {
    const compressed = await sharp(buffer)
      .resize(1024, null, { withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    return compressed;
  }

  // Extract text and structure from HTML
  extractTextFromHtml(htmlContent, pageUrl = '') {
    const $ = cheerio.load(htmlContent);

    // Remove scripts, styles, and comments
    $('script, style, noscript, iframe').remove();

    // Extract title
    const title = $('title').text().trim();

    // Extract meta description
    const metaDescription = $('meta[name="description"]').attr('content') ||
                           $('meta[property="og:description"]').attr('content') || '';

    // Extract keywords
    const keywords = $('meta[name="keywords"]').attr('content') || '';

    // Extract headings (max 30)
    const headings = [];
    $('h1, h2, h3').each((i, el) => {
      if (headings.length < 30) {
        const text = $(el).text().trim();
        if (text && text.length < 200) {
          headings.push(text);
        }
      }
    });

    // Extract navigation items (max 20)
    const navigation = [];
    const seen = new Set();
    $('nav a, header a').each((i, el) => {
      if (navigation.length < 20) {
        const text = $(el).text().trim();
        if (text && text.length < 50 && !seen.has(text.toLowerCase())) {
          seen.add(text.toLowerCase());
          navigation.push(text);
        }
      }
    });

    // Extract body text (max 8000 chars)
    const bodyText = $('body').text()
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 8000);

    // Extract contact info
    const pageText = $('body').text();
    const phones = pageText.match(/(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g) || [];
    const emails = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];

    // Extract CTAs
    const ctas = [];
    $('button, a.btn, [role="button"], .cta, .button').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 50 && !ctas.includes(text)) {
        ctas.push(text);
      }
    });

    // Identify sections
    const sections = [];
    const bodyLower = bodyText.toLowerCase();
    if (bodyLower.includes('hero') || $('section').first().find('h1').length) sections.push('hero');
    if (bodyLower.includes('about') || bodyLower.includes('who we are')) sections.push('about');
    if (bodyLower.includes('service') || bodyLower.includes('what we do')) sections.push('services');
    if (bodyLower.includes('testimonial') || bodyLower.includes('review')) sections.push('testimonials');
    if (bodyLower.includes('contact') || bodyLower.includes('get in touch')) sections.push('contact');
    if ($('footer').length) sections.push('footer');

    // Word count
    const wordCount = bodyText.split(/\s+/).filter(w => w.length > 0).length;

    return {
      title,
      metaDescription,
      keywords,
      headings: [...new Set(headings)],
      navigation: [...new Set(navigation)],
      bodyText,
      contactInfo: {
        phones: [...new Set(phones)].slice(0, 5),
        emails: [...new Set(emails)].slice(0, 5)
      },
      ctas: ctas.slice(0, 10),
      sections,
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

    // Extract colors (hex, rgb, rgba)
    const colorMatches = cssContent.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)/g) || [];
    for (const color of colorMatches) {
      colors[color] = (colors[color] || 0) + 1;
    }

    // Extract font families
    const fontMatches = cssContent.match(/font-family:\s*([^;]+)/g) || [];
    for (const match of fontMatches) {
      const font = match.replace('font-family:', '').trim().split(',')[0].replace(/["']/g, '').trim();
      if (font && !font.includes('inherit') && !font.includes('sans-serif') && !font.includes('serif')) {
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
      .slice(0, 15)
      .map(([color]) => color);

    return {
      colors: {
        all: sortedColors,
        primary: sortedColors[0] || '#000000',
        secondary: sortedColors[1] || '#333333',
        accent: sortedColors.find(c => c.includes('rgb') && c.includes('255')) || sortedColors[2] || '#0066cc',
        background: sortedColors.find(c => c === '#ffffff' || c === '#fff') || '#ffffff',
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
      hasSocialLinks: false
    };

    // Analyze pages
    for (const page of pages) {
      const pathLower = (page.path || '').toLowerCase();
      const textLower = (page.bodyText || '').toLowerCase();

      // Detect page types
      if (pathLower === '/' || pathLower === '/index') pageTypes.push('home');
      else if (pathLower.includes('about')) pageTypes.push('about');
      else if (pathLower.includes('service')) pageTypes.push('services');
      else if (pathLower.includes('contact')) pageTypes.push('contact');
      else if (pathLower.includes('blog') || pathLower.includes('news')) pageTypes.push('blog');
      else if (pathLower.includes('product') || pathLower.includes('shop')) pageTypes.push('products');

      // Build hierarchy
      if (page.navigation) {
        for (const nav of page.navigation) {
          if (!hierarchy[nav]) {
            hierarchy[nav] = pathLower;
          }
        }
      }

      // Detect features
      if (textLower.includes('menu') || textLower.includes('hamburger')) features.hasMobileNav = true;
      if (textLower.includes('search')) features.hasSearch = true;
      if (textLower.includes('blog') || textLower.includes('article')) features.hasBlog = true;
      if (textLower.includes('cart') || textLower.includes('shop') || textLower.includes('buy')) features.hasEcommerce = true;
      if (textLower.includes('form') || textLower.includes('submit') || textLower.includes('contact us')) features.hasForms = true;
      if (textLower.includes('video') || textLower.includes('youtube') || textLower.includes('vimeo')) features.hasVideo = true;
      if (textLower.includes('map') || textLower.includes('location') || textLower.includes('directions')) features.hasMap = true;
      if (textLower.includes('facebook') || textLower.includes('twitter') || textLower.includes('instagram') || textLower.includes('linkedin')) features.hasSocialLinks = true;
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
    }

    return {
      pageCount,
      pageTypes: [...new Set(pageTypes)],
      hierarchy,
      components,
      features
    };
  }

  // Main method: compile the full analysis package
  async compileAnalysisPackage(scrapeId) {
    this.log(`Compiling analysis package for ${scrapeId}...`);
    const processingErrors = [];

    // Load scrape log
    const scrapeLog = await this.loadScrapeLog(scrapeId);

    // Select and compress screenshots
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
        await this.bucket.file(outputPath).makePublic();

        compressedScreenshots.push({
          id: filename.replace('.jpg', ''),
          page: screenshot.local_path.includes('index') ? 'index' :
                screenshot.local_path.match(/screenshot_([^_]+)_/)?.[1] || 'unknown',
          state: screenshot.type || 'initial',
          filename,
          url: `https://storage.googleapis.com/${this.bucketName}/${outputPath}`,
          dimensions: `${metadata.width}x${metadata.height}`,
          sizeBytes: compressed.length
        });

        this.log(`Compressed: ${filename} (${Math.round(compressed.length / 1024)}KB)`);
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

        pages.push({
          path: new URL(pageInfo.url).pathname,
          title: extracted.title,
          headings: extracted.headings.slice(0, 10),
          bodyText: extracted.bodyText.substring(0, 3000),
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

      for (const cssFile of cssFiles.slice(0, 5)) {
        try {
          const [buffer] = await cssFile.download();
          allCss += buffer.toString() + '\n';
        } catch (e) {
          // Skip unreadable CSS files
        }
      }

      if (allCss) {
        design = this.extractDesignTokens(allCss);
      }
    } catch (error) {
      this.log(`Error extracting design tokens: ${error.message}`);
      processingErrors.push({ type: 'css', error: error.message });
    }

    // Build structure map
    const structure = this.buildStructureMap(pages, scrapeLog);

    // Compile final package
    const analysisPackage = {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      source: {
        scrapeId,
        originalUrl: scrapeLog.target_url,
        scrapedAt: scrapeLog.started_at,
        pagesScraped: scrapeLog.stats?.pages_scraped || pages.length
      },
      screenshots: compressedScreenshots,
      content: {
        siteTitle,
        siteDescription,
        pages,
        navigation: [...allNavigation].slice(0, 20),
        callsToAction: [...allCtas].slice(0, 10),
        contactInfo: {
          phones: [...allPhones].slice(0, 5),
          emails: [...allEmails].slice(0, 5),
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
      analysisPackage.assets.logo = {
        found: true,
        url: `https://storage.googleapis.com/${this.bucketName}/scrapes/${scrapeId}/${logoImage.local_path}`,
        dimensions: null
      };
    }

    return { analysisPackage, processingErrors };
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

    await this.bucket.file(outputPath).makePublic();

    return `https://storage.googleapis.com/${this.bucketName}/${outputPath}`;
  }
}
