import * as cheerio from 'cheerio';
import css from 'css';
import crypto from 'crypto';

export class AssetExtractor {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    try {
      this.baseDomain = new URL(baseUrl).hostname;
    } catch {
      this.baseDomain = '';
    }
  }

  resolveUrl(url, pageUrl) {
    if (!url || url.startsWith('data:')) {
      return null;
    }

    try {
      // Handle protocol-relative URLs
      if (url.startsWith('//')) {
        url = 'https:' + url;
      }

      // Resolve relative URLs
      return new URL(url, pageUrl).href;
    } catch {
      return null;
    }
  }

  extractImgTags(html, pageUrl) {
    const $ = cheerio.load(html);
    const images = [];

    $('img').each((_, el) => {
      // Extract src
      const src = $(el).attr('src');
      const resolvedSrc = this.resolveUrl(src, pageUrl);
      if (resolvedSrc) {
        images.push({
          url: resolvedSrc,
          type: 'img_tag',
          attribute: 'src'
        });
      }

      // Extract srcset
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const srcsetUrls = this.parseSrcset(srcset);
        for (const srcUrl of srcsetUrls) {
          const resolvedUrl = this.resolveUrl(srcUrl, pageUrl);
          if (resolvedUrl) {
            images.push({
              url: resolvedUrl,
              type: 'img_tag',
              attribute: 'srcset'
            });
          }
        }
      }

      // Check data-src (lazy loading)
      const dataSrc = $(el).attr('data-src');
      const resolvedDataSrc = this.resolveUrl(dataSrc, pageUrl);
      if (resolvedDataSrc) {
        images.push({
          url: resolvedDataSrc,
          type: 'img_tag',
          attribute: 'data-src'
        });
      }
    });

    // Also check picture elements
    $('picture source').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const srcsetUrls = this.parseSrcset(srcset);
        for (const srcUrl of srcsetUrls) {
          const resolvedUrl = this.resolveUrl(srcUrl, pageUrl);
          if (resolvedUrl) {
            images.push({
              url: resolvedUrl,
              type: 'img_tag',
              attribute: 'picture-srcset'
            });
          }
        }
      }
    });

    return images;
  }

  parseSrcset(srcset) {
    const urls = [];
    const parts = srcset.split(',');

    for (const part of parts) {
      const trimmed = part.trim();
      const firstSpace = trimmed.indexOf(' ');
      const url = firstSpace > 0 ? trimmed.substring(0, firstSpace) : trimmed;
      if (url) {
        urls.push(url);
      }
    }

    return urls;
  }

  extractCssBackgroundImages(cssContent, cssUrl) {
    const images = [];

    try {
      const ast = css.parse(cssContent, { silent: true });

      if (ast && ast.stylesheet && ast.stylesheet.rules) {
        this.walkCssRules(ast.stylesheet.rules, (declarations) => {
          for (const decl of declarations) {
            if (decl.property === 'background' || decl.property === 'background-image') {
              const urls = this.extractUrlsFromCssValue(decl.value);
              for (const url of urls) {
                const resolvedUrl = this.resolveUrl(url, cssUrl);
                if (resolvedUrl) {
                  images.push({
                    url: resolvedUrl,
                    type: 'css_background',
                    source: cssUrl
                  });
                }
              }
            }
          }
        });
      }
    } catch (error) {
      // CSS parsing error, try regex fallback
      const regex = /url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;
      let match;
      while ((match = regex.exec(cssContent)) !== null) {
        const url = match[1];
        const resolvedUrl = this.resolveUrl(url, cssUrl);
        if (resolvedUrl) {
          images.push({
            url: resolvedUrl,
            type: 'css_background',
            source: cssUrl
          });
        }
      }
    }

    return images;
  }

  walkCssRules(rules, callback) {
    for (const rule of rules) {
      if (rule.type === 'rule' && rule.declarations) {
        callback(rule.declarations);
      } else if (rule.type === 'media' && rule.rules) {
        this.walkCssRules(rule.rules, callback);
      } else if (rule.type === 'supports' && rule.rules) {
        this.walkCssRules(rule.rules, callback);
      }
    }
  }

  extractUrlsFromCssValue(value) {
    const urls = [];
    const regex = /url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;
    let match;
    while ((match = regex.exec(value)) !== null) {
      if (!match[1].startsWith('data:')) {
        urls.push(match[1]);
      }
    }
    return urls;
  }

  extractInlineStyles(html, pageUrl) {
    const $ = cheerio.load(html);
    const images = [];

    // Check style attributes
    $('[style]').each((_, el) => {
      const style = $(el).attr('style');
      if (style) {
        const urls = this.extractUrlsFromCssValue(style);
        for (const url of urls) {
          const resolvedUrl = this.resolveUrl(url, pageUrl);
          if (resolvedUrl) {
            images.push({
              url: resolvedUrl,
              type: 'css_background',
              source: 'inline-style'
            });
          }
        }
      }
    });

    // Check <style> tags
    $('style').each((_, el) => {
      const cssContent = $(el).html();
      if (cssContent) {
        const extracted = this.extractCssBackgroundImages(cssContent, pageUrl);
        images.push(...extracted);
      }
    });

    return images;
  }

  extractInlineSvgs(html) {
    const $ = cheerio.load(html, { xmlMode: false });
    const svgs = [];

    $('svg').each((index, el) => {
      const $svg = $(el);

      // Get the outer HTML of the SVG
      const svgContent = $.html(el);

      // Generate a unique ID based on content or use existing id
      const id = $svg.attr('id') || crypto.createHash('md5').update(svgContent).digest('hex').substring(0, 12);

      svgs.push({
        id: id,
        content: svgContent,
        type: 'svg_inline'
      });
    });

    return svgs;
  }

  extractFavicons(html, pageUrl) {
    const $ = cheerio.load(html);
    const favicons = [];

    // Standard favicon links
    $('link[rel*="icon"]').each((_, el) => {
      const href = $(el).attr('href');
      const resolvedUrl = this.resolveUrl(href, pageUrl);
      if (resolvedUrl) {
        favicons.push({
          url: resolvedUrl,
          type: 'favicon',
          rel: $(el).attr('rel')
        });
      }
    });

    // Apple touch icons
    $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((_, el) => {
      const href = $(el).attr('href');
      const resolvedUrl = this.resolveUrl(href, pageUrl);
      if (resolvedUrl) {
        favicons.push({
          url: resolvedUrl,
          type: 'favicon',
          rel: $(el).attr('rel')
        });
      }
    });

    // Default favicon.ico
    try {
      const faviconUrl = new URL('/favicon.ico', pageUrl).href;
      favicons.push({
        url: faviconUrl,
        type: 'favicon',
        rel: 'default'
      });
    } catch {
      // Ignore invalid URLs
    }

    return favicons;
  }

  extractOgMetaImages(html, pageUrl) {
    const $ = cheerio.load(html);
    const images = [];

    // Open Graph images
    $('meta[property="og:image"], meta[property="og:image:url"]').each((_, el) => {
      const content = $(el).attr('content');
      const resolvedUrl = this.resolveUrl(content, pageUrl);
      if (resolvedUrl) {
        images.push({
          url: resolvedUrl,
          type: 'og_meta',
          property: $(el).attr('property')
        });
      }
    });

    // Twitter Card images
    $('meta[name="twitter:image"], meta[property="twitter:image"]').each((_, el) => {
      const content = $(el).attr('content');
      const resolvedUrl = this.resolveUrl(content, pageUrl);
      if (resolvedUrl) {
        images.push({
          url: resolvedUrl,
          type: 'og_meta',
          property: 'twitter:image'
        });
      }
    });

    return images;
  }

  extractCssLinks(html, pageUrl) {
    const $ = cheerio.load(html);
    const cssLinks = [];

    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      const resolvedUrl = this.resolveUrl(href, pageUrl);
      if (resolvedUrl) {
        cssLinks.push({
          url: resolvedUrl,
          type: 'css'
        });
      }
    });

    return cssLinks;
  }

  extractJsLinks(html, pageUrl) {
    const $ = cheerio.load(html);
    const jsLinks = [];

    $('script[src]').each((_, el) => {
      const src = $(el).attr('src');
      const resolvedUrl = this.resolveUrl(src, pageUrl);
      if (resolvedUrl) {
        jsLinks.push({
          url: resolvedUrl,
          type: 'js'
        });
      }
    });

    return jsLinks;
  }

  extractPageLinks(html, pageUrl) {
    const $ = cheerio.load(html);
    const links = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const resolvedUrl = this.resolveUrl(href, pageUrl);

      if (resolvedUrl) {
        try {
          const parsedUrl = new URL(resolvedUrl);

          // Only include same-domain links
          if (parsedUrl.hostname === this.baseDomain) {
            // Remove hash and normalize
            parsedUrl.hash = '';
            const normalizedUrl = parsedUrl.href;

            // Skip non-page links
            const path = parsedUrl.pathname.toLowerCase();
            if (
              !path.endsWith('.pdf') &&
              !path.endsWith('.zip') &&
              !path.endsWith('.exe') &&
              !path.endsWith('.dmg') &&
              !path.endsWith('.png') &&
              !path.endsWith('.jpg') &&
              !path.endsWith('.jpeg') &&
              !path.endsWith('.gif') &&
              !path.endsWith('.svg') &&
              !path.endsWith('.webp') &&
              !path.endsWith('.mp4') &&
              !path.endsWith('.mp3') &&
              !path.endsWith('.wav') &&
              !path.endsWith('.avi')
            ) {
              links.push(normalizedUrl);
            }
          }
        } catch {
          // Invalid URL, skip
        }
      }
    });

    // Remove duplicates
    return [...new Set(links)];
  }

  extractAllAssets(html, pageUrl) {
    const images = [
      ...this.extractImgTags(html, pageUrl),
      ...this.extractInlineStyles(html, pageUrl),
      ...this.extractFavicons(html, pageUrl),
      ...this.extractOgMetaImages(html, pageUrl)
    ];

    const inlineSvgs = this.extractInlineSvgs(html);
    const cssLinks = this.extractCssLinks(html, pageUrl);
    const jsLinks = this.extractJsLinks(html, pageUrl);
    const pageLinks = this.extractPageLinks(html, pageUrl);

    // Deduplicate images by URL
    const seenUrls = new Set();
    const uniqueImages = images.filter(img => {
      if (seenUrls.has(img.url)) return false;
      seenUrls.add(img.url);
      return true;
    });

    return {
      images: uniqueImages,
      inlineSvgs,
      cssLinks,
      jsLinks,
      pageLinks
    };
  }
}
