// DOM Elements
const urlInput = document.getElementById('url-input');
const scrapeBtn = document.getElementById('scrape-btn');
const stopBtn = document.getElementById('stop-btn');
const downloadLogBtn = document.getElementById('download-log-btn');
const openOutputBtn = document.getElementById('open-output-btn');
const clearLogBtn = document.getElementById('clear-log-btn');

const statusText = document.getElementById('status-text');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');

const pagesCount = document.getElementById('pages-count');
const imagesCount = document.getElementById('images-count');
const errorsCount = document.getElementById('errors-count');
const queueCount = document.getElementById('queue-count');

const logContainer = document.getElementById('log-container');

const completionSection = document.getElementById('completion-section');
const completionTitle = document.getElementById('completion-title');
const finalPages = document.getElementById('final-pages');
const finalImages = document.getElementById('final-images');
const finalErrors = document.getElementById('final-errors');
const finalSize = document.getElementById('final-size');
const outputPath = document.getElementById('output-path');

// State
let ws = null;
let isConnected = false;
let isScraping = false;
let outputDir = '';

// WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    isConnected = true;
    console.log('WebSocket connected');
  };

  ws.onclose = () => {
    isConnected = false;
    console.log('WebSocket disconnected');
    // Reconnect after 2 seconds
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleMessage(message);
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  };
}

// Handle WebSocket Messages
function handleMessage(message) {
  const { type, data } = message;

  switch (type) {
    case 'status':
      updateStatus(data);
      break;
    case 'progress':
      updateProgress(data);
      break;
    case 'log':
      addLogEntry(data);
      break;
    case 'complete':
      handleComplete(data);
      break;
    case 'error':
      handleError(data);
      break;
  }
}

// Update Status Display
function updateStatus(data) {
  isScraping = data.isRunning;
  updateButtons();

  if (data.stats) {
    pagesCount.textContent = data.stats.pagesScraped || 0;
    imagesCount.textContent = data.stats.imagesDownloaded || 0;
    errorsCount.textContent = data.stats.errorsEncountered || 0;
  }

  queueCount.textContent = data.queueLength || 0;
}

// Update Progress Display
function updateProgress(data) {
  isScraping = data.status === 'scraping';
  updateButtons();

  // Update status text
  statusText.textContent = capitalizeFirst(data.status);
  statusText.className = `status-value ${data.status}`;

  // Update stats
  pagesCount.textContent = data.pagesScraped || 0;
  imagesCount.textContent = data.imagesDownloaded || 0;
  errorsCount.textContent = data.errorsEncountered || 0;
  queueCount.textContent = data.queueLength || 0;

  // Calculate progress (rough estimate based on queue)
  const total = (data.pagesScraped || 0) + (data.queueLength || 0);
  const done = data.pagesScraped || 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  progressFill.style.width = `${percent}%`;
  progressText.textContent = `${percent}%`;
}

// Add Log Entry
function addLogEntry(entry) {
  // Remove placeholder if present
  const placeholder = logContainer.querySelector('.log-placeholder');
  if (placeholder) {
    placeholder.remove();
  }

  const logEntry = document.createElement('div');
  logEntry.className = `log-entry ${entry.type || 'info'}`;

  const time = new Date(entry.timestamp).toLocaleTimeString();

  logEntry.innerHTML = `
    <span class="log-time">[${time}]</span>
    <span class="log-message">${escapeHtml(entry.message)}</span>
  `;

  logContainer.appendChild(logEntry);

  // Auto-scroll to bottom
  logContainer.scrollTop = logContainer.scrollHeight;

  // Limit log entries to prevent memory issues
  const entries = logContainer.querySelectorAll('.log-entry');
  if (entries.length > 1000) {
    entries[0].remove();
  }
}

// Handle Completion
function handleComplete(data) {
  isScraping = false;
  updateButtons();

  statusText.textContent = data.success ? 'Complete' : 'Error';
  statusText.className = `status-value ${data.success ? 'complete' : 'error'}`;

  progressFill.style.width = '100%';
  progressText.textContent = '100%';

  // Show completion section
  completionSection.classList.remove('hidden');
  completionTitle.textContent = data.success ? 'Scraping Complete!' : 'Scraping Stopped';

  if (data.stats) {
    finalPages.textContent = data.stats.pagesScraped || 0;
    finalImages.textContent = data.stats.imagesDownloaded || 0;
    finalErrors.textContent = data.stats.errorsEncountered || 0;
    finalSize.textContent = formatBytes(data.stats.totalSizeBytes || 0);
  }

  if (data.outputDir) {
    outputDir = data.outputDir;
    outputPath.textContent = `Output: ${data.outputDir}`;
  }

  // Enable download button
  downloadLogBtn.disabled = false;
  openOutputBtn.disabled = false;
}

// Handle Error
function handleError(data) {
  addLogEntry({
    timestamp: new Date().toISOString(),
    message: `Error: ${data.message}`,
    type: 'error'
  });
}

// Update Button States
function updateButtons() {
  scrapeBtn.disabled = isScraping;
  stopBtn.disabled = !isScraping;
  urlInput.disabled = isScraping;
}

// Start Scraping
async function startScraping() {
  const url = urlInput.value.trim();

  if (!url) {
    alert('Please enter a URL');
    return;
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    alert('Please enter a valid URL (e.g., https://example.com)');
    return;
  }

  // Reset UI
  completionSection.classList.add('hidden');
  logContainer.innerHTML = '';
  pagesCount.textContent = '0';
  imagesCount.textContent = '0';
  errorsCount.textContent = '0';
  queueCount.textContent = '0';
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
  downloadLogBtn.disabled = true;
  openOutputBtn.disabled = true;

  try {
    const response = await fetch('/api/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || 'Failed to start scraping');
      return;
    }

    isScraping = true;
    statusText.textContent = 'Scraping';
    statusText.className = 'status-value scraping';
    updateButtons();

  } catch (error) {
    alert('Failed to start scraping: ' + error.message);
  }
}

// Stop Scraping
async function stopScraping() {
  try {
    const response = await fetch('/api/stop', {
      method: 'POST'
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || 'Failed to stop scraping');
      return;
    }

    statusText.textContent = 'Stopping...';
    statusText.className = 'status-value stopped';

  } catch (error) {
    alert('Failed to stop scraping: ' + error.message);
  }
}

// Download Log
async function downloadLog() {
  try {
    const response = await fetch('/api/log');

    if (!response.ok) {
      alert('Log file not available');
      return;
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scrape_log.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

  } catch (error) {
    alert('Failed to download log: ' + error.message);
  }
}

// Show Output Directory
async function showOutputDir() {
  try {
    const response = await fetch('/api/output-dir');
    const data = await response.json();

    if (data.outputDir) {
      // Copy to clipboard
      await navigator.clipboard.writeText(data.outputDir);
      alert(`Output directory path copied to clipboard:\n\n${data.outputDir}`);
    }
  } catch (error) {
    alert('Failed to get output directory');
  }
}

// Clear Log
function clearLog() {
  logContainer.innerHTML = '<div class="log-placeholder">Waiting for scraping to start...</div>';
}

// Utility Functions
function capitalizeFirst(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Event Listeners
scrapeBtn.addEventListener('click', startScraping);
stopBtn.addEventListener('click', stopScraping);
downloadLogBtn.addEventListener('click', downloadLog);
openOutputBtn.addEventListener('click', showOutputDir);
clearLogBtn.addEventListener('click', clearLog);

urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !isScraping) {
    startScraping();
  }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();

  // Focus URL input
  urlInput.focus();
});
