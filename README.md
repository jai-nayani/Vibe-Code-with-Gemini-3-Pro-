# Website Scraper

A full-featured website scraper with a Web UI for gathering website content and assets. Built for local development and data gathering tasks.

## Features

- **Web-based UI** - Easy-to-use browser interface with real-time progress updates
- **JavaScript Rendering** - Uses Playwright headless browser to capture dynamically rendered content
- **Full-Page Screenshots** - Captures full-page PNG screenshots of every page for visual analysis
- **Comprehensive Image Extraction**:
  - `<img>` tag `src` and `srcset` attributes
  - CSS `background-image` properties
  - Inline SVGs
  - Favicons
  - Open Graph and Twitter Card imgs
- **Respects robots.txt** - Automatically fetches and honors robots.txt directives
- **Rate Limiting** - Configurable delays and concurrent request limits
- **Organized Output** - Clean directory structure for scraped content
- **Error Resilient** - Continues scraping even when individual pages/assets fail

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/varsha-km1/Vibe-Code-with-Gemini-3-Pro-.git
   cd Vibe-Code-with-Gemini-3-Pro-
   cd Vibe-Code-with-Gemini-3-Pro--claude-website-scraper-ui-01DUUqh2QE8xmFj4L2jDapGR
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Install Playwright browsers:**
   ```bash
   npx playwright install chromium
   ```

## Usage

1. **Start the server:**
   ```bash
   npm start
   ```

2. **Open the Web UI:**
   Navigate to [http://localhost:3500](http://localhost:3500) in your browser

3. **Enter a URL and click "Scrape"**

   Each scraping session automatically creates a new numbered folder in `CC_Output/` (1, 2, 3, etc.) to keep your scrapes organized.

## Output Structure

Scraped content is saved to `CC_Output/` with numbered folders for each scraping session. Each run creates a new folder (1, 2, 3, etc.) to keep your scrapes organized:

```
CC_Output/
├── 1/                       # First scraping session
│   ├── pages/               # HTML pages
│   │   ├── index.html
│   │   └── [url_path].html
│   ├── images/
│   │   ├── img_tags/        # Images from <img> tags
│   │   ├── css_backgrounds/ # CSS background images
│   │   ├── svg_inline/      # Extracted inline SVGs
│   │   ├── favicons/        # Favicon files
│   │   ├── og_meta/         # Open Graph/Twitter images
│   │   └── web_screenshots/ # Full-page screenshots of each page
│   ├── assets/
│   │   ├── css/             # CSS stylesheets
│   │   └── js/              # JavaScript files
│   └── logs/
│       └── scrape_log.json  # Detailed scrape log
├── 2/                       # Second scraping session
│   └── ...
└── 3/                       # Third scraping session
    └── ...
```

## Configuration

Default settings (can be modified in `src/server.js`):

| Parameter | Value | Description |
|-----------|-------|-------------|
| Port | 3500 | Server port |
| Max Depth | 5 | Maximum crawl depth from starting URL |
| Max Concurrent | 3 | Simultaneous requests |
| Request Delay | 500ms | Minimum delay between requests |
| Timeout | 60s | Request timeout (increased for slow-loading sites) |
| Max File Size | 50MB | Maximum size per asset |
| User-Agent | `MyScraper/1.0` | Scraper identification |
| Output Directory | `CC_Output/` | Base directory for scraped content (numbered folders) |

### Timeout Handling

The scraper uses a progressive fallback strategy for page loading:
1. **First attempt**: `domcontentloaded` (60s) - Fastest, waits for DOM to be ready
2. **Fallback**: `load` (120s) - Waits for page load event
3. **Final fallback**: `networkidle` (120s) - Waits for network to be idle

This ensures the scraper works reliably even with slow-loading or JavaScript-heavy websites.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/start` | POST | Start scraping (body: `{ url: string }`) |
| `/api/stop` | POST | Stop current scrape |
| `/api/status` | GET | Get current scraper status |
| `/api/output-dir` | GET | Get output directory path |
| `/api/log` | GET | Download scrape log |

## Log File Format

The `scrape_log.json` file contains:

```json
{
  "scrape_id": "uuid",
  "started_at": "ISO8601 timestamp",
  "completed_at": "ISO8601 timestamp",
  "target_url": "https://example.com",
  "config": {
    "max_depth": 5,
    "respect_robots_txt": true
  },
  "stats": {
    "pages_scraped": 42,
    "images_downloaded": 156,
    "screenshots_captured": 42,
    "errors_encountered": 3,
    "total_size_bytes": 15234567
  },
  "pages": [...],
  "images": [...],
  "screenshots": [...],
  "errors": [...]
}
```


## Technical Details

- **Backend**: Node.js with Express.js
- **Scraping**: Playwright (Chromium)
- **Real-time Updates**: WebSocket
- **HTML Parsing**: Cheerio
- **CSS Parsing**: css library
- **robots.txt**: robots-parser library

## Error Handling

The scraper handles errors gracefully:

- **HTTP 4xx/5xx**: Logged and skipped
- **Timeout**: Automatically retries with less strict loading strategies
- **Invalid URLs**: Logged and skipped
- **robots.txt disallowed**: Skipped silently
- **Slow-loading pages**: Progressive fallback to faster loading strategies

Individual errors never crash the entire scrape job. The scraper will attempt multiple loading strategies before giving up on a page.

## Limitations

- Only crawls pages within the same domain
- External assets (CDN images, etc.) are downloaded but external pages are not crawled
- Maximum crawl depth of 5 levels
- Does not execute JavaScript for asset discovery (uses initial page render)

## License

MIT
