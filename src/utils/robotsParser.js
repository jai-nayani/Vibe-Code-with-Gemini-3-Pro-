import robotsParser from 'robots-parser';

export class RobotsChecker {
  constructor(userAgent = 'MyScraper/1.0') {
    this.userAgent = userAgent;
    this.robots = null;
    this.crawlDelay = 500; // Default 500ms
    this.loaded = false;
  }

  async load(baseUrl) {
    try {
      const robotsUrl = new URL('/robots.txt', baseUrl).href;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent
        }
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const robotsTxt = await response.text();
        this.robots = robotsParser(robotsUrl, robotsTxt);

        // Check for crawl delay
        const delay = this.robots.getCrawlDelay(this.userAgent);
        if (delay && delay > 0) {
          // Convert to milliseconds and use the greater of specified or default
          this.crawlDelay = Math.max(delay * 1000, this.crawlDelay);
        }

        this.loaded = true;
        return true;
      } else {
        // No robots.txt or error - allow all
        this.robots = null;
        this.loaded = true;
        return true;
      }
    } catch (error) {
      // Failed to fetch robots.txt - allow all by default
      console.log(`Could not fetch robots.txt: ${error.message}`);
      this.robots = null;
      this.loaded = true;
      return true;
    }
  }

  isAllowed(url) {
    if (!this.loaded) {
      console.warn('RobotsChecker not loaded yet');
      return true;
    }

    if (!this.robots) {
      return true; // No robots.txt, allow all
    }

    return this.robots.isAllowed(url, this.userAgent);
  }

  getCrawlDelay() {
    return this.crawlDelay;
  }
}
