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

  async getSignedUrl(filePath) {
    try {
      const [url] = await this.bucket.file(filePath).getSignedUrl({
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
      });
      return url;
    } catch (e) {
      this.log(`Error getting signed URL for ${filePath}: ${e.message}`);
      return null;
    }
  }

  async findLatestScrape() {
    this.log('Finding latest scrape...');
    const [files] = await this.bucket.getFiles({ prefix: 'scrapes/' });

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
      } catch (e) {}
    }

    if (!latestScrape) {
      throw new Error('No valid scrapes found');
    }

    this.log(`Found latest scrape: ${latestScrape}`);
    return latestScrape;
  }

  async loadScrapeLog(scrapeId) {
    this.log(`Loading scrape log for ${scrapeId}...`);
    const logFile = this.bucket.file(`scrapes/${scrapeId}/logs/scrape_log.json`);

    try {
      const [buffer] = await logFile.download();
      const scrapeLog = JSON.parse(buffer.toString());
      this.log(`Loaded scrape log: ${scrapeLog.stats?.pages_scraped || 0} pages, ${scrapeLog.screenshots?.length || 0} screenshots`);
      return scrapeLog;
    } catch (error) {
      throw new Error(`Invalid scrape data: missing or corrupt scrape_log.json - ${error.message}`);
    }
  }

  async selectKeyScreenshots(scrapeId, scrapeLog) {
    this.log('Selecting key screenshots...');
    const screenshots = Array.isArray(scrapeLog.screenshots) ? scrapeLog.screenshots : [];
    const successScreenshots = screenshots.filter(s => s && s.status === 'success').filter(Boolean);
    
    this.log(`Total screenshots: ${screenshots.length}, successful: ${successScreenshots.length}`);

    const hasOnlyIndexPages = successScreenshots.length > 0 && successScreenshots.every(s => 
      s && (s.local_path?.includes('screenshot_index_') || 
      s.local_path?.includes('/index'))
    );
    
    const isSinglePageApp = hasOnlyIndexPages || (scrapeLog.stats?.pages_scraped === 1);
    this.log(`Single-page app detected: ${isSinglePageApp}`);

    const selected = [];
    const maxScreenshots = 15;

    if (isSinglePageApp) {
      this.log('Using SPA selection strategy - capturing ALL unique states');
      
      const initial = successScreenshots.find(s => s.local_path?.includes('_initial'));
      if (initial) {
        selected.push({ ...initial, priority: 'initial' });
      }

      const interactive = successScreenshots.filter(s => 
        !s.local_path?.includes('_initial') &&
        !selected.some(sel => sel.local_path === s.local_path)
      );

      const seen = new Set();
      for (const screenshot of interactive) {
        const filename = screenshot.local_path?.split('/').pop() || '';
        const meaningfulPart = this.extractMeaningfulName(filename);
        
        if (!seen.has(meaningfulPart) && selected.length < maxScreenshots) {
          seen.add(meaningfulPart);
          selected.push({ ...screenshot, priority: 'interactive', name: meaningfulPart });
        }
      }
    } else {
      const homeInitial = successScreenshots.find(s => s.local_path?.includes('screenshot_index_initial'));
    if (homeInitial) {
      selected.push({ ...homeInitial, priority: 'home-initial' });
    }

      const homeInteractive = successScreenshots.filter(s =>
        s.local_path?.includes('screenshot_index_') && !s.local_path?.includes('_initial')
      ).slice(0, 5);
    selected.push(...homeInteractive.map(s => ({ ...s, priority: 'home-interactive' })));

      const otherInitials = successScreenshots.filter(s =>
        !s.local_path?.includes('screenshot_index_') && s.local_path?.includes('_initial')
      ).slice(0, 5);
    selected.push(...otherInitials.map(s => ({ ...s, priority: 'page-initial' })));

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
    return selected.slice(0, maxScreenshots);
  }

  extractMeaningfulName(filename) {
    let name = filename.replace(/\.(png|jpg|jpeg)$/i, '').replace(/^screenshot_/, '').replace(/^index_/, '');
    return name.split('_').slice(0, 3).join('_').toLowerCase();
  }

  async compressScreenshot(buffer) {
    return await sharp(buffer).resize(1280, null, { withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  }

  getImageTagSubdir(type = 'img_tag') {
    const typeToDir = {
      img_tag: 'img_tags',
      css_background: 'css_backgrounds',
      svg_inline: 'svg_inline',
      favicon: 'favicons',
      og_meta: 'og_meta'
    };
    return typeToDir[type] || 'img_tags';
  }

  getContentTypeForPath(filePath) {
    const lower = (filePath || '').toLowerCase();
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.ico')) return 'image/x-icon';
    return 'application/octet-stream';
  }

  isRasterImagePath(filePath) {
    const lower = (filePath || '').toLowerCase();
    return (
      lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.gif') ||
      lower.endsWith('.ico')
    );
  }

  async compressImageToTargetWebp(buffer, targetBytes) {
    // Best-effort: try to hit <= targetBytes by lowering quality and (if needed) resizing down.
    // Always outputs WebP for best size/quality ratio and transparency support.
    const minTarget = Math.max(2048, Math.floor(targetBytes)); // avoid absurdly tiny targets

    let img = sharp(buffer, { failOn: 'none' });
    let meta;
    try {
      meta = await img.metadata();
    } catch {
      meta = {};
    }

    let width = meta.width || null;
    const minWidth = Math.max(160, Math.floor((meta.width || 800) * 0.25));

    const tryEncode = async (w, quality) => {
      let pipeline = sharp(buffer, { failOn: 'none' });
      if (w && meta.width && w < meta.width) {
        pipeline = pipeline.resize(w, null, { withoutEnlargement: true });
      }
      return await pipeline.webp({ quality, effort: 4 }).toBuffer();
    };

    // Phase 1: quality sweep at original size
    let best = null;
    for (const q of [80, 70, 60, 50, 40, 35, 30]) {
      const out = await tryEncode(null, q);
      if (!best || out.length < best.length) best = out;
      if (out.length <= minTarget) return { buffer: out, reachedTarget: true, strategy: `webp_q${q}` };
    }

    // Phase 2: downscale + quality sweep
    let currentWidth = width;
    for (let i = 0; i < 6; i++) {
      if (!meta.width || !currentWidth) break;
      currentWidth = Math.floor(currentWidth * 0.85);
      if (currentWidth < minWidth) break;

      for (const q of [70, 60, 50, 40, 35, 30]) {
        const out = await tryEncode(currentWidth, q);
        if (!best || out.length < best.length) best = out;
        if (out.length <= minTarget) return { buffer: out, reachedTarget: true, strategy: `webp_w${currentWidth}_q${q}` };
      }
    }

    return { buffer: best || buffer, reachedTarget: (best?.length || buffer.length) <= minTarget, strategy: 'webp_best_effort' };
  }

  async processAndSaveWebsiteImages(scrapeId, scrapeLog, maxImages = 250) {
    this.log(`STEP 4.5: Exporting website images (cap ${maxImages})...`);

    const images = Array.isArray(scrapeLog.images) ? scrapeLog.images : [];
    const candidates = images
      .filter(i => i && i.status === 'success' && typeof i.local_path === 'string')
      .filter(i => i.local_path.startsWith('images/'))
      .slice(0, maxImages);

    if (candidates.length === 0) {
      this.log('  No website images found to export');
      return { manifestPath: null, imagesFolder: `analysis/${scrapeId}/scraper/images/`, exportedCount: 0 };
    }

    const manifest = {
      scrapeId,
      exportedAt: new Date().toISOString(),
      maxImages,
      exportedCount: 0,
      items: []
    };

    for (const img of candidates) {
      try {
        const srcGcsPath = `scrapes/${scrapeId}/${img.local_path}`;
        const [srcBuf] = await this.bucket.file(srcGcsPath).download();
        const originalBytes = srcBuf.length;
        const targetBytes = Math.floor(originalBytes * 0.3);

        const type = img.type || 'img_tag';
        const tagDir = this.getImageTagSubdir(type);
        const baseName = (img.local_path.split('/').pop() || 'image').replace(/\.(png|jpg|jpeg|webp|gif|ico)$/i, '');

        // SVGs: keep as-is (already small and vector)
        if ((img.local_path || '').toLowerCase().endsWith('.svg') || type === 'svg_inline') {
          const outPath = `analysis/${scrapeId}/scraper/images/${tagDir}/${baseName}.svg`;
          await this.bucket.file(outPath).save(srcBuf, { contentType: 'image/svg+xml' });
          const signedUrl = await this.getSignedUrl(outPath);
          manifest.items.push({
            type,
            originalUrl: img.url,
            sourcePath: srcGcsPath,
            outputPath: outPath,
            signedUrl,
            originalBytes,
            outputBytes: originalBytes,
            reduction: 0,
            reachedTarget: true,
            format: 'svg'
          });
          manifest.exportedCount++;
          continue;
        }

        if (!this.isRasterImagePath(img.local_path)) {
          // Unknown/non-image file in images/ — skip
          continue;
        }

        const { buffer: compressed, reachedTarget, strategy } = await this.compressImageToTargetWebp(srcBuf, targetBytes);
        const outputBytes = compressed.length;
        const reduction = originalBytes > 0 ? Math.round((1 - outputBytes / originalBytes) * 100) : 0;

        const outPath = `analysis/${scrapeId}/scraper/images/${tagDir}/${baseName}.webp`;
        await this.bucket.file(outPath).save(compressed, { contentType: 'image/webp', metadata: { cacheControl: 'public, max-age=3600' } });

        const signedUrl = await this.getSignedUrl(outPath);
        manifest.items.push({
          type,
          originalUrl: img.url,
          sourcePath: srcGcsPath,
          outputPath: outPath,
          signedUrl,
          originalBytes,
          outputBytes,
          targetBytes,
          reductionPercent: reduction,
          reachedTarget,
          strategy,
          format: 'webp'
        });
        manifest.exportedCount++;
      } catch (e) {
        // Best-effort; continue exporting others
        // eslint-disable-next-line no-console
        console.error(`[AnalysisCompressor] Image export error: ${e.message}`);
      }
    }

    const manifestPath = `analysis/${scrapeId}/scraper/images/images_manifest.json`;
    await this.bucket.file(manifestPath).save(JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
    this.log(`  ✓ Exported ${manifest.exportedCount} images to analysis/${scrapeId}/scraper/images/`);
    this.log('STEP 4.5 COMPLETE');

    return { manifestPath, imagesFolder: `analysis/${scrapeId}/scraper/images/`, exportedCount: manifest.exportedCount };
  }

  extractTextFromHtml(htmlContent, pageUrl = '') {
    const $ = cheerio.load(htmlContent);
    $('script, style, noscript, iframe, svg').remove();

    const title = $('title').text().trim() || $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
    const metaDescription = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
    const keywords = $('meta[name="keywords"]').attr('content') || '';

    const headings = [];
    $('h1, h2, h3, h4, h5, h6').each((i, el) => {
      if (headings.length < 50) {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text && text.length > 1 && text.length < 300) {
          headings.push({ level: el.tagName.toLowerCase(), text });
        }
      }
    });

    const navigation = [];
    const navSeen = new Set();
    $('nav a, header a, .nav a, .navigation a, .menu a').each((i, el) => {
      if (navigation.length < 30) {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text && text.length > 0 && text.length < 50 && !navSeen.has(text.toLowerCase())) {
          navSeen.add(text.toLowerCase());
          navigation.push(text);
        }
      }
    });

    const paragraphs = [];
    $('p').each((i, el) => {
      if (paragraphs.length < 50) {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text && text.length > 20 && text.length < 2000) {
          paragraphs.push(text);
        }
      }
    });

    const listItems = [];
    $('li').each((i, el) => {
      if (listItems.length < 100) {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text && text.length > 2 && text.length < 500) {
          listItems.push(text);
        }
      }
    });

    const cardContents = [];
    $('.card, .section, [class*="card"], [class*="section"], article, .content').each((i, el) => {
      if (cardContents.length < 30) {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text && text.length > 50 && text.length < 3000) {
          cardContents.push(text);
        }
      }
    });

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 20000);

    const pageText = $('body').text();
    const phones = new Set();
    (pageText.match(/(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g) || []).forEach(m => phones.add(m.trim()));
    const emails = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];

    const socialLinks = {};
    $('a[href*="linkedin.com"]').each((i, el) => { socialLinks.linkedin = $(el).attr('href'); });
    $('a[href*="github.com"]').each((i, el) => { socialLinks.github = $(el).attr('href'); });
    $('a[href*="twitter.com"], a[href*="x.com"]').each((i, el) => { socialLinks.twitter = $(el).attr('href'); });

    const ctas = [];
    const ctaSeen = new Set();
    $('button, a.btn, a.button, [role="button"], .cta, .btn').each((i, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text && text.length > 1 && text.length < 50 && !ctaSeen.has(text.toLowerCase())) {
        ctaSeen.add(text.toLowerCase());
        ctas.push(text);
      }
    });

    const sections = [];
    const sectionKeywords = {
      hero: /hero|banner|jumbotron|landing|intro|cover|splash/i,
      about: /about|bio|story|who.*we|who.*i|profile|team|company|mission|vision/i,
      services: /service|offer|solution|capabilit|what.*we.*do|practice|consult/i,
      experience: /experience|career|work.*history|employment|resume|cv/i,
      education: /education|school|degree|university|college|academic|certification|training|course/i,
      skills: /skill|technolog|expertise|competenc|stack|tools|proficien/i,
      projects: /project|portfolio|case.*stud|work\s*sample|engagement/i,
      testimonials: /testimonial|review|feedback|client.*say|social proof|ratings?/i,
      pricing: /pricing|plans?|packages|rates|fees|subscription/i,
      contact: /contact|reach|get.*in.*touch|connect|support|help|inquiry|enquire|faq/i,
      blog: /blog|news|article|insights|resources|updates|press/i,
      shop: /shop|store|product|catalog|cart|checkout|e-?commerce/i,
      events: /event|webinar|conference|workshop|meetup|summit/i,
      downloads: /download|assets|resources|whitepaper|ebook|brochure/i,
      careers: /career|jobs?|hiring|join.*team|openings/i,
      legal: /legal|privacy|terms|gdpr|cookie/i,
      sitemap: /sitemap/i,
      footer: /footer/i,
      // Local business / restaurant / hospitality
      menu: /menu|our\s+menu|food|drinks|beverage|wine\s+list|cocktails?|bar\s+menu/i,
      order: /order|delivery|takeout|pickup|carryout|online\s+order|ubereats|doordash|grubhub/i,
      reservations: /reservation|book\s+a\s+table|book\s+now|rsvp|booking/i,
      location: /location|find\s+us|directions|map|where\s+to\s+find/i,
      hours: /hours|opening\s+hours|open\s+daily|closing\s+time/i,
      specials: /specials?|deals|offers|happy\s+hour|discount|promo/i,
      gallery: /gallery|photos|images|media|lookbook/i,
      amenities: /amenit|facilit|parking|wifi|accessib|pet\s+friendly/i,
      team: /chef|staff|team|meet\s+the\s+team|owners?/i,
      eventsVenue: /private\s+events?|catering|banquet|venue|host\s+your\s+event/i,
      // Salon / spa / wellness
      salon: /salon|spa|barber|groom|beauty|makeup|stylist|hair\s*(cut|color|styling|blowout)|nail|manicure|pedicure|massage|facial|wax|brow|lash|tan|treatment/i,
      salonBooking: /book\s+(now|appointment|visit)|schedule|reserve|availability|appointment/i,
      salonPackages: /package|membership|plan|bundle|pricing|rates|fees/i,
      salonTeam: /stylist|technician|artist|therapist|esthetici|team|staff/i,
      salonOffers: /special|offer|deal|promo|discount|gift\s*card|voucher/i
    };

    const bodyLower = bodyText.toLowerCase();
    for (const [section, pattern] of Object.entries(sectionKeywords)) {
      if (pattern.test(bodyLower)) sections.push(section);
    }

    return {
      title, metaDescription, keywords,
      headings: headings.map(h => h.text),
      headingsWithLevels: headings,
      navigation: [...new Set(navigation)],
      paragraphs, listItems, cardContents, bodyText,
      contactInfo: { phones: [...phones].slice(0, 5), emails: [...new Set(emails)].slice(0, 5), socialLinks },
      ctas: ctas.slice(0, 15),
      sections: [...new Set(sections)],
      wordCount: bodyText.split(/\s+/).filter(w => w.length > 0).length
    };
  }

  extractDesignTokens(cssContent) {
    const colors = {};
    const fonts = new Set();
    const fontSizes = [], borderRadii = [], shadows = [], spacing = [];

    (cssContent.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)/g) || []).forEach(c => colors[c] = (colors[c] || 0) + 1);
    (cssContent.match(/--[\w-]+:\s*[^;]+/g) || []).forEach(match => {
      const [name, value] = match.split(':').map(s => s.trim());
      if (/color|bg|primary|secondary|accent/i.test(name) && value.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/)) {
        colors[value.replace(/['"]/g, '')] = (colors[value] || 0) + 5;
      }
    });
    (cssContent.match(/font-family:\s*([^;]+)/g) || []).forEach(m => {
      const font = m.replace('font-family:', '').trim().split(',')[0].replace(/["']/g, '').trim();
      if (font && !['inherit', 'sans-serif', 'serif', 'monospace'].includes(font)) fonts.add(font);
    });
    (cssContent.match(/font-size:\s*([^;]+)/g) || []).forEach(m => { const s = m.replace('font-size:', '').trim(); if (!fontSizes.includes(s)) fontSizes.push(s); });
    (cssContent.match(/border-radius:\s*([^;]+)/g) || []).forEach(m => { const r = m.replace('border-radius:', '').trim(); if (!borderRadii.includes(r)) borderRadii.push(r); });
    (cssContent.match(/box-shadow:\s*([^;]+)/g) || []).forEach(m => { const s = m.replace('box-shadow:', '').trim(); if (s !== 'none' && !shadows.includes(s)) shadows.push(s); });
    (cssContent.match(/(margin|padding):\s*(\d+px)/g) || []).forEach(m => { const v = m.match(/\d+px/)?.[0]; if (v && !spacing.includes(v)) spacing.push(v); });

    const sortedColors = Object.entries(colors).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([c]) => c);
    return {
      colors: { all: sortedColors, primary: sortedColors[0] || '#000000', secondary: sortedColors[1] || '#333333', accent: sortedColors[2] || '#0066cc', background: sortedColors.find(c => c === '#ffffff' || c === '#fff') || '#ffffff', text: '#333333' },
      typography: { fonts: [...fonts].slice(0, 5), headingFont: [...fonts][0] || 'sans-serif', bodyFont: [...fonts][1] || 'sans-serif', sizes: { h1: fontSizes.find(s => parseInt(s) >= 36) || '48px', h2: fontSizes.find(s => parseInt(s) >= 28) || '36px', h3: fontSizes.find(s => parseInt(s) >= 20) || '24px', body: '16px', small: '14px' } },
      spacing: { base: '8px', common: spacing.slice(0, 6) },
      borderRadius: { common: borderRadii.slice(0, 5), buttons: borderRadii.find(r => parseInt(r) <= 8) || '4px', cards: borderRadii.find(r => parseInt(r) >= 8) || '8px' },
      shadows: shadows.slice(0, 5)
    };
  }

  buildStructureMap(pages, scrapeLog) {
    const pagesArray = Array.isArray(pages) ? pages : [];
    const pageTypes = [], hierarchy = {}, components = [];
    const features = { hasMobileNav: false, hasSearch: false, hasBlog: false, hasEcommerce: false, hasForms: false, hasVideo: false, hasMap: false, hasSocialLinks: false, isSinglePage: pagesArray.length === 1 };

    for (const page of pagesArray) {
      if (!page) continue;
      const pathLower = (page.path || '').toLowerCase();
      const textLower = (page.bodyText || '').toLowerCase();
      if (pathLower.includes('index')) pageTypes.push('home');
      if (textLower.includes('about')) pageTypes.push('about');
      if (textLower.includes('contact')) pageTypes.push('contact');
      if (textLower.includes('portfolio') || textLower.includes('project')) pageTypes.push('portfolio');
      if (Array.isArray(page.navigation)) page.navigation.forEach(n => { if (!hierarchy[n]) hierarchy[n] = pathLower; });
      if (textLower.includes('linkedin') || textLower.includes('github')) features.hasSocialLinks = true;
      if (textLower.includes('form') || textLower.includes('submit')) features.hasForms = true;
      if (features.isSinglePage && Array.isArray(page.sections)) page.sections.forEach(s => { if (!pageTypes.includes(s)) pageTypes.push(s); });
    }

      components.push({ type: 'navbar', variant: 'standard', count: 1 });
    if (pagesArray.some(p => p && Array.isArray(p.sections) && p.sections.includes('hero'))) {
        components.push({ type: 'hero', variant: 'image-background', count: 1 });
      }
    components.push({ type: 'footer', variant: 'standard', count: 1 });

    return { pageCount: pagesArray.length, pageTypes: [...new Set(pageTypes)], hierarchy, components, features, isSinglePage: features.isSinglePage };
  }

  extractMeaningfulDisplayName(filename) {
    let name = filename.replace(/\.(png|jpg|jpeg)$/i, '').replace(/^screenshot_/, '').replace(/^index_/, '');
    name = name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    if (name.toLowerCase() === 'initial') return 'Homepage (Initial State)';
    return name.length > 50 ? name.substring(0, 47) + '...' : name || 'Screenshot';
  }

  deduplicateArray(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    return arr.filter(item => {
      if (item == null) return false;
      const normalized = (typeof item === 'string' ? item : JSON.stringify(item)).toLowerCase().substring(0, 100);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  async compileAnalysisPackage(scrapeId) {
    this.log(`=== COMPILING ANALYSIS PACKAGE FOR ${scrapeId} ===`);
    const processingErrors = [];
    const scrapeLog = await this.loadScrapeLog(scrapeId);

    // STEP 1: PROCESS SCREENSHOTS
    this.log('STEP 1: Processing screenshots...');
    const selectedScreenshots = await this.selectKeyScreenshots(scrapeId, scrapeLog);
    const compressedScreenshots = [];

    for (const screenshot of selectedScreenshots) {
      try {
        const gcsPath = `scrapes/${scrapeId}/${screenshot.local_path}`;
        const [buffer] = await this.bucket.file(gcsPath).download();
        const compressed = await this.compressScreenshot(buffer);
        const metadata = await sharp(compressed).metadata();
        const filename = screenshot.local_path.split('/').pop().replace('.png', '.jpg');
        const outputPath = `analysis/${scrapeId}/scraper/screenshots/${filename}`;
        await this.bucket.file(outputPath).save(compressed, { contentType: 'image/jpeg', metadata: { cacheControl: 'public, max-age=3600' } });
        const screenshotUrl = await this.getSignedUrl(outputPath);
        compressedScreenshots.push({
          id: filename.replace('.jpg', ''), name: this.extractMeaningfulDisplayName(filename),
          page: screenshot.local_path.includes('index') ? 'index' : 'unknown',
          state: screenshot.priority || 'interactive', filename, url: screenshotUrl,
          dimensions: `${metadata.width}x${metadata.height}`, sizeBytes: compressed.length
        });
        this.log(`  ✓ ${filename}`);
      } catch (error) {
        this.log(`  ✗ Error: ${error.message}`);
        processingErrors.push({ type: 'screenshot', path: screenshot.local_path, error: error.message });
      }
    }
    this.log(`STEP 1 COMPLETE: ${compressedScreenshots.length} screenshots`);

    // STEP 2: EXTRACT TEXT FROM HTML
    this.log('STEP 2: Extracting text from HTML pages...');
    const pages = [];
    const allNavigation = new Set(), allCtas = new Set(), allPhones = new Set(), allEmails = new Set();
    const allSocialLinks = {}, allSections = new Set();
    const allParagraphs = [], allListItems = [], allCardContents = [], allHeadings = [];
    let siteTitle = '', siteDescription = '';

    const pagesList = Array.isArray(scrapeLog.pages) ? scrapeLog.pages : [];
    for (const pageInfo of pagesList) {
      try {
        const gcsPath = `scrapes/${scrapeId}/${pageInfo.local_path}`;
        const [buffer] = await this.bucket.file(gcsPath).download();
        const extracted = this.extractTextFromHtml(buffer.toString(), pageInfo.url);
        if (pageInfo.url === scrapeLog.target_url || pageInfo.local_path?.includes('index')) {
          siteTitle = extracted.title;
          siteDescription = extracted.metaDescription;
        }
        if (Array.isArray(extracted.navigation)) extracted.navigation.forEach(n => allNavigation.add(n));
        if (Array.isArray(extracted.ctas)) extracted.ctas.forEach(c => allCtas.add(c));
        if (extracted.contactInfo && Array.isArray(extracted.contactInfo.phones)) extracted.contactInfo.phones.forEach(p => allPhones.add(p));
        if (extracted.contactInfo && Array.isArray(extracted.contactInfo.emails)) extracted.contactInfo.emails.forEach(e => allEmails.add(e));
        if (Array.isArray(extracted.sections)) extracted.sections.forEach(s => allSections.add(s));
        if (Array.isArray(extracted.paragraphs)) allParagraphs.push(...extracted.paragraphs);
        if (Array.isArray(extracted.listItems)) allListItems.push(...extracted.listItems);
        if (Array.isArray(extracted.cardContents)) allCardContents.push(...extracted.cardContents);
        if (Array.isArray(extracted.headingsWithLevels)) allHeadings.push(...extracted.headingsWithLevels);
        if (extracted.contactInfo && extracted.contactInfo.socialLinks) Object.assign(allSocialLinks, extracted.contactInfo.socialLinks);
        pages.push({
          path: new URL(pageInfo.url).pathname, title: extracted.title || '',
          headings: Array.isArray(extracted.headings) ? extracted.headings.slice(0, 20) : [],
          headingsWithLevels: Array.isArray(extracted.headingsWithLevels) ? extracted.headingsWithLevels.slice(0, 20) : [],
          paragraphs: Array.isArray(extracted.paragraphs) ? extracted.paragraphs.slice(0, 15) : [],
          listItems: Array.isArray(extracted.listItems) ? extracted.listItems.slice(0, 30) : [],
          bodyText: (extracted.bodyText || '').substring(0, 8000),
          sections: Array.isArray(extracted.sections) ? extracted.sections : [],
          wordCount: extracted.wordCount || 0
        });
        this.log(`  ✓ ${pageInfo.local_path} (${extracted.wordCount} words)`);
      } catch (error) {
        this.log(`  ✗ Error: ${error.message}`);
        processingErrors.push({ type: 'page', path: pageInfo.local_path, error: error.message });
      }
    }
    this.log(`STEP 2 COMPLETE: ${pages.length} pages`);

    // STEP 3: EXTRACT DESIGN TOKENS
    this.log('STEP 3: Extracting design tokens...');
    let design = { colors: { all: [], primary: '#000', secondary: '#333', accent: '#06c', background: '#fff', text: '#333' }, typography: { fonts: [], headingFont: 'sans-serif', bodyFont: 'sans-serif', sizes: {} }, spacing: { base: '8px', common: [] }, borderRadius: { common: [], buttons: '4px', cards: '8px' }, shadows: [] };
    try {
      const [cssFiles] = await this.bucket.getFiles({ prefix: `scrapes/${scrapeId}/assets/css/` });
      let allCss = '';
      for (const cssFile of cssFiles.slice(0, 10)) {
        try { const [buf] = await cssFile.download(); allCss += buf.toString() + '\n'; } catch (e) {}
      }
      if (allCss) {
        design = this.extractDesignTokens(allCss);
        this.log(`  ✓ ${design?.colors?.all?.length || 0} colors, ${design?.typography?.fonts?.length || 0} fonts`);
      }
    } catch (error) {
      this.log(`  ✗ Error: ${error.message}`);
      processingErrors.push({ type: 'css', error: error.message });
    }
    this.log('STEP 3 COMPLETE');

    // STEP 4: BUILD CONTENT OBJECTS
    this.log('STEP 4: Building content objects...');
    const structure = this.buildStructureMap(pages, scrapeLog);
    const safeHeadings = Array.isArray(allHeadings) ? allHeadings.filter(h => h && h.text) : [];
    const textContent = {
      siteTitle: siteTitle || '', siteDescription: siteDescription || '',
      headings: this.deduplicateArray(safeHeadings.map(h => h.text)).slice(0, 50),
      headingsWithLevels: safeHeadings.slice(0, 50),
      paragraphs: this.deduplicateArray(Array.isArray(allParagraphs) ? allParagraphs : []).slice(0, 40),
      listItems: this.deduplicateArray(Array.isArray(allListItems) ? allListItems : []).slice(0, 60),
      cardContents: this.deduplicateArray(Array.isArray(allCardContents) ? allCardContents : []).slice(0, 20),
      navigation: Array.from(allNavigation).slice(0, 30),
      callsToAction: Array.from(allCtas).slice(0, 20),
      sections: Array.from(allSections),
      contactInfo: { phones: Array.from(allPhones).slice(0, 5), emails: Array.from(allEmails).slice(0, 5), socialLinks: allSocialLinks || {} }
    };
    this.log(`  ${textContent.headings?.length || 0} headings, ${textContent.paragraphs?.length || 0} paragraphs, ${textContent.listItems?.length || 0} list items`);
    this.log('STEP 4 COMPLETE');

    // STEP 4.5: EXPORT WEBSITE IMAGES (compressed)
    let exportedImages = { manifestPath: null, imagesFolder: `analysis/${scrapeId}/scraper/images/`, exportedCount: 0 };
    try {
      exportedImages = await this.processAndSaveWebsiteImages(scrapeId, scrapeLog, 250);
    } catch (e) {
      this.log(`  ✗ Image export error: ${e.message}`);
      processingErrors.push({ type: 'images', error: e.message });
    }

    // STEP 5: SAVE JSON FILES TO data/ FOLDER
    this.log('STEP 5: Saving JSON files to data/ folder...');
    const dataFolder = `analysis/${scrapeId}/scraper/data`;

    try {
      const textContentPath = `${dataFolder}/text_content.json`;
      await this.bucket.file(textContentPath).save(JSON.stringify(textContent, null, 2), { contentType: 'application/json' });
      this.log(`  ✓ ${textContentPath}`);
    } catch (error) {
      this.log(`  ✗ text_content.json: ${error.message}`);
      processingErrors.push({ type: 'save', file: 'text_content.json', error: error.message });
    }

    try {
      const structurePath = `${dataFolder}/site_structure.json`;
      await this.bucket.file(structurePath).save(JSON.stringify(structure, null, 2), { contentType: 'application/json' });
      this.log(`  ✓ ${structurePath}`);
    } catch (error) {
      this.log(`  ✗ site_structure.json: ${error.message}`);
      processingErrors.push({ type: 'save', file: 'site_structure.json', error: error.message });
    }

    try {
      const designPath = `${dataFolder}/design_tokens.json`;
      await this.bucket.file(designPath).save(JSON.stringify(design, null, 2), { contentType: 'application/json' });
      this.log(`  ✓ ${designPath}`);
    } catch (error) {
      this.log(`  ✗ design_tokens.json: ${error.message}`);
      processingErrors.push({ type: 'save', file: 'design_tokens.json', error: error.message });
    }

    try {
      const pagesPath = `${dataFolder}/pages_content.json`;
      await this.bucket.file(pagesPath).save(JSON.stringify(pages, null, 2), { contentType: 'application/json' });
      this.log(`  ✓ ${pagesPath}`);
    } catch (error) {
      this.log(`  ✗ pages_content.json: ${error.message}`);
      processingErrors.push({ type: 'save', file: 'pages_content.json', error: error.message });
    }

    this.log('STEP 5 COMPLETE');

    // STEP 6: BUILD FINAL PACKAGE
    this.log('STEP 6: Building final analysis package...');
    const textContentUrl = await this.getSignedUrl(`${dataFolder}/text_content.json`);
    const structureUrl = await this.getSignedUrl(`${dataFolder}/site_structure.json`);
    const designUrl = await this.getSignedUrl(`${dataFolder}/design_tokens.json`);
    const pagesUrl = await this.getSignedUrl(`${dataFolder}/pages_content.json`);

    const analysisPackage = {
      version: '1.2', generatedAt: new Date().toISOString(),
      source: { scrapeId, originalUrl: scrapeLog.target_url, scrapedAt: scrapeLog.started_at, pagesScraped: scrapeLog.stats?.pages_scraped || pages.length, screenshotsTotal: scrapeLog.screenshots?.length || 0, screenshotsSelected: compressedScreenshots.length },
      files: { textContent: textContentUrl, siteStructure: structureUrl, designTokens: designUrl, pagesContent: pagesUrl },
      screenshots: compressedScreenshots,
      content: textContent,
      design, structure,
      assets: {
        logo: { found: false, url: null },
        images: {
          total: scrapeLog.stats?.images_downloaded || 0,
          exportedCompressed: exportedImages.exportedCount,
          folder: exportedImages.imagesFolder,
          manifestPath: exportedImages.manifestPath
        },
        icons: { hasFavicon: Array.isArray(scrapeLog.images) ? scrapeLog.images.some(i => i.type === 'favicon') : false }
      },
      seoData: { hasMetaDescription: !!siteDescription, hasOgTags: false }
    };

    const logoImage = scrapeLog.images?.find(i => i.local_path?.toLowerCase().includes('logo'));
    if (logoImage) {
      const url = await this.getSignedUrl(`scrapes/${scrapeId}/${logoImage.local_path}`);
      if (url) analysisPackage.assets.logo = { found: true, url };
    }

    const profileImage = scrapeLog.images?.find(i => i.local_path?.toLowerCase().includes('profile') || i.local_path?.toLowerCase().includes('avatar'));
    if (profileImage) {
      const url = await this.getSignedUrl(`scrapes/${scrapeId}/${profileImage.local_path}`);
      if (url) analysisPackage.assets.profilePhoto = { found: true, url };
    }

    this.log('STEP 6 COMPLETE');
    this.log(`=== ANALYSIS COMPLETE: ${compressedScreenshots.length} screenshots, ${textContent.headings?.length || 0} headings, ${textContent.paragraphs?.length || 0} paragraphs ===`);

    return { analysisPackage, processingErrors };
  }

  async saveAnalysisPackage(scrapeId, analysisPackage) {
    const outputPath = `analysis/${scrapeId}/scraper/analysis_package.json`;
    await this.bucket.file(outputPath).save(JSON.stringify(analysisPackage, null, 2), { contentType: 'application/json' });
    this.log(`Saved: ${outputPath} (${Math.round(JSON.stringify(analysisPackage).length / 1024)}KB)`);
    return await this.getSignedUrl(outputPath);
  }
}
