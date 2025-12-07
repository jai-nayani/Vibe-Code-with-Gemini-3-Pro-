# Scraped output will be saved here in numbered folders (1, 2, 3, etc.)

Each scrape session creates a new numbered folder with the following structure:

```
1/                           # Session number
├── pages/                   # HTML pages
├── images/
│   ├── img_tags/           # <img> src images
│   ├── css_backgrounds/    # CSS background images
│   ├── svg_inline/         # Inline SVGs
│   ├── favicons/           # Favicon files
│   ├── og_meta/            # OG/Twitter images
│   └── web_screenshots/    # Full-page screenshots of each page
├── assets/
│   ├── css/                # Stylesheets
│   └── js/                 # Scripts
└── logs/
    └── scrape_log.json     # Detailed log with metadata
```
