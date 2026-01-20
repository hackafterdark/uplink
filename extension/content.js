// --- Console Interception ---
try {
  // Inject script from file to avoid CSP inline-script violations
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject_console.js');
  script.onload = function () {
    this.remove(); // Clean up script tag after loading
  };
  (document.head || document.documentElement).appendChild(script);
} catch (e) {
  console.log("Browser Bridge: Failed to inject console interceptor", e);
}

// Listen for the logs
let capturedLogs = [];
window.addEventListener('mcp-console-log', (e) => {
  capturedLogs.push(e.detail);
  if (capturedLogs.length > 500) capturedLogs.shift();
});

// --- Performance Monitor ---
const PerfMon = {
  // Store interaction timings
  lastInteraction: { type: null, duration: 0, timestamp: 0 },
  longTasks: [], // Store recent long tasks (INP approximation)

  recordInteraction(type, duration) {
    this.lastInteraction = { type, duration, timestamp: Date.now() };
  },

  getMetrics() {
    const p = window.performance;
    const t = p.timing;

    // 1. Navigation Timing (Legacy but reliable)
    const nav = {
      ttfb: t.responseStart - t.requestStart,
      domProcessing: t.domComplete - t.domInteractive,
      pageLoad: t.loadEventEnd - t.navigationStart
    };

    // 2. Paint Timing (FCP)
    let fcp = 0;
    try {
      const paint = p.getEntriesByType('paint');
      const fcpEntry = paint.find(e => e.name === 'first-contentful-paint');
      if (fcpEntry) fcp = fcpEntry.startTime;
    } catch (e) { } // Firefox < 84 or missing support

    // 3. Resource Bottlenecks (Top 5 > 500ms)
    let slowResources = [];
    try {
      slowResources = p.getEntriesByType('resource')
        .filter(e => e.duration > 500)
        .sort((a, b) => b.duration - a.duration) // Descending
        .slice(0, 5)
        .map(e => ({
          name: e.name.split('/').pop().split('?')[0] || e.name, // Short name
          duration: Math.round(e.duration),
          type: e.initiatorType
        }));
    } catch (e) { }

    return {
      navigation: nav,
      fcp: Math.round(fcp),
      slowResources: slowResources,
      lastInteraction: this.lastInteraction,
      // Recent long tasks count (last 10s)
      longTaskCount: this.longTasks.filter(t => Date.now() - t.timestamp < 10000).length
    };
  }
};

// Start Observer for Long Tasks (INP Proxy)
try {
  const observer = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      PerfMon.longTasks.push({ duration: entry.duration, timestamp: Date.now() });
      if (PerfMon.longTasks.length > 50) PerfMon.longTasks.shift();
    });
  });
  observer.observe({ entryTypes: ['longtask'] });
} catch (e) {
  // Graceful degradation: Observer not supported
}


// --- Overlay System ---
function createOverlay(rect, labelText) {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'absolute',
    border: '2px solid #ff00ff',
    backgroundColor: 'rgba(255, 0, 255, 0.1)',
    top: (rect.top + window.scrollY) + 'px',
    left: (rect.left + window.scrollX) + 'px',
    width: rect.width + 'px',
    height: rect.height + 'px',
    zIndex: '2147483647',
    pointerEvents: 'none',
    transition: 'all 0.2s ease'
  });

  if (labelText) {
    const label = document.createElement('div');
    label.textContent = labelText;
    Object.assign(label.style, {
      background: '#ff00ff',
      color: 'white',
      fontSize: '12px',
      padding: '2px 4px',
      position: 'absolute',
      top: '-20px',
      left: '0',
      whiteSpace: 'nowrap'
    });
    overlay.appendChild(label);
  }

  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 2500);
}

// --- Global State for Uplink ---
window.uplink = {
  map: new Map(), // Stores ID -> Element Reference
  idCounter: 0
};

// --- Semantic DOM Parser ---
/**
 * Returns a simplified text representation for the AI.
 */

// Helper: Is the element actually visible to the user?
function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    rect.width > 0 &&
    rect.height > 0
  );
}

// Helper: Extract useful attributes (The "Bot Gold")
function getContextAttrs(el) {
  const attrs = [];

  // Input state
  if (el.tagName === 'INPUT') {
    const type = el.type;
    if (type !== 'text') attrs.push(`type="${type}"`);
    if (el.checked) attrs.push('checked');
    if (el.value && type !== 'password' && type !== 'hidden') attrs.push(`value="${el.value.slice(0, 20)}"`);
  }

  // Stable IDs for testing/bots
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-action');
  if (testId) attrs.push(`test-id="${testId}"`);

  // ARIA role if specific
  const role = el.getAttribute('role');
  if (role && role !== el.tagName.toLowerCase()) attrs.push(`role="${role}"`);

  return attrs.length > 0 ? ` (${attrs.join(' ')})` : '';
}

// Helper: Robust text extraction that respects 'inert' and 'aria-hidden'
function getVisibleText(el) {
  if (!el) return '';

  // 1. Skip if hidden by common visibility signals
  if (el.nodeType === Node.ELEMENT_NODE) {
    if (el.hasAttribute('inert') ||
      el.getAttribute('aria-hidden') === 'true' ||
      el.hasAttribute('hidden')) {
      return '';
    }

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return '';
    }
  }

  // 2. Return text if it's a text node
  if (el.nodeType === Node.TEXT_NODE) {
    return el.textContent;
  }

  // 3. Recurse into children
  return Array.from(el.childNodes)
    .map(child => getVisibleText(child))
    .join('')
    .trim();
}

// Helper: Get a rich "Virtual Document" label for AI processing
function getLabel(el) {
  const parts = [];

  // 1. Visible Text (The primary signal)
  const visible = getVisibleText(el);
  if (visible) parts.push(visible);

  // 2. Strong Semantic Attributes
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel !== visible) parts.push(ariaLabel);

  const title = el.getAttribute('title');
  if (title && title !== visible && title !== ariaLabel) parts.push(title);

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) parts.push(placeholder);

  // 3. Image Alt Text
  const imgs = el.querySelectorAll('img');
  imgs.forEach(img => {
    if (img.alt && !visible.includes(img.alt)) parts.push(img.alt);
  });

  // 4. Fallbacks for empty elements
  if (parts.length === 0) {
    const testId = el.getAttribute('data-testid') || el.getAttribute('name') || el.id;
    if (testId) parts.push(testId);
  }

  // 5. Link Href Context (Last resort or enrichment for generic links)
  if (el.tagName === 'A') {
    const href = el.getAttribute('href');
    // If we have very little text, add the URL slug for context
    // e.g. <a href="/login">Login</a> -> "Login /login"
    if (href && (parts.length === 0 || parts.join(' ').length < 10)) {
      parts.push(href);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function getPageSnapshot() {
  // Reset state
  window.uplink.map.clear();
  window.uplink.idCounter = 0;

  let output = [];



  // Recursive function to walk DOM and Shadow DOM
  function processNode(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const tag = node.tagName.toLowerCase();
      let isInteractive = false;
      let role = tag;

      // 1. Detect Interactivity
      if (['a', 'button', 'select', 'textarea', 'details', 'summary'].includes(tag)) isInteractive = true;
      if (tag === 'input' && node.type !== 'hidden') isInteractive = true;
      if (node.getAttribute('role') === 'button' || node.onclick) {
        isInteractive = true;
        role = 'button';
      }

      // 2. Capture Important Text (Context)
      if (!isInteractive && ['h1', 'h2', 'h3', 'p', 'li', 'span', 'div'].includes(tag)) {
        const text = getVisibleText(node).replace(/\s+/g, ' ').trim();

        if (text.length > 3) {
          output.push(`    ${text}`);
        }
      }

      // 3. Register Interactive Element
      if (isInteractive) {
        window.uplink.idCounter++;
        const id = window.uplink.idCounter;
        let label = getLabel(node);

        // Fallback for unlabeled generic inputs
        if (!label && tag === 'input') label = 'Input';
        if (!label && tag === 'select') label = 'Dropdown';
        if (!label) label = 'Element';

        // Context attributes
        const context = getContextAttrs(node);

        // Store reference
        window.uplink.map.set(id, node);

        output.push(`[${id}] <${role}> "${label}"${context}`);
      }

      // 4. Handle Shadow DOM
      if (node.shadowRoot) {
        processNode(node.shadowRoot);
      }
    }
  }

  processNode(document.body);
  return output.join('\n');
}

// --- Message Handler ---
const api = (typeof chrome !== "undefined") ? chrome : browser;

api.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Helper to resolve the promise safely
  const respond = (data) => sendResponse(data);

  try {
    // --- ACTION: READ ---
    if (request.action === 'read') {
      const format = request.format || 'distilled'; // Default to new parser

      if (format === 'html') {
        respond(document.documentElement.outerHTML);
      } else if (format === 'text') {
        respond(document.body.innerText.substring(0, 10000));
      } else {
        // Default: Distilled
        let snapshot = getPageSnapshot();
        if (!snapshot.trim()) {
          // Retry logic for hydrating pages
          setTimeout(() => {
            snapshot = getPageSnapshot();
            respond(snapshot);
          }, 1000);
          return true; // Async wait
        }
        respond(snapshot);
      }
      return true;
    }

    if (request.action === 'get_logs') {
      respond(JSON.stringify(capturedLogs));
      capturedLogs = []; // Clear after reading
      return true;
    }

    if (request.action === 'execute') {
      const result = eval(request.script);
      respond(String(result));
      return true;
    }

    if (request.action === 'read_as_markdown') {
      const md = htmlToMarkdown(document.body);
      respond(md);
      return true;
    }

    // --- Observability Handlers (Global) ---
    if (request.action === 'check_errors') {
      respond(capturedLogs); // Send array
      return true;
    }

    if (request.action === 'manage_session') {
      const action = request.command || 'clear';
      if (action === 'clear' || action === 'clear_all') {
        try {
          window.localStorage.clear();
          window.sessionStorage.clear();
          document.cookie.split(";").forEach((c) => {
            document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
          });
          capturedLogs = [];
          respond({ status: "success", message: "Session/Cookies/Logs cleared." });
        } catch (e) {
          respond({ status: "error", message: e.toString() });
        }
      } else if (action === 'clear_logs') {
        capturedLogs = [];
        respond({ status: "success", message: "Logs cleared." });
      } else {
        respond({ status: "error", message: "Unknown command" });
      }
      return true;
    }

    if (request.action === 'get_performance_metrics') {
      respond(PerfMon.getMetrics());
      return true;
    }

    if (request.action === 'audit_accessibility') {
      if (typeof axe === 'undefined') {
        respond({ error: 'axe-core library not loaded. Please ensure axe.min.js is injected.' });
        return true;
      }

      // Ensure map is hydrated so we can match elements to IDs
      if (window.uplink.map.size === 0) {
        getPageSnapshot();
      }

      const reverseMap = new Map();
      for (const [id, el] of window.uplink.map.entries()) {
        reverseMap.set(el, id);
      }

      axe.run().then(results => {
        const violations = results.violations.map(v => {
          return {
            id: v.id,
            impact: v.impact,
            description: v.description,
            nodes: v.nodes.map(node => {
              const el = node.element;
              const mcpId = reverseMap.get(el);
              return {
                mcpId: mcpId || "N/A",
                target: node.target,
                html: node.html.slice(0, 100),
                failureSummary: node.failureSummary
              };
            })
          };
        });

        respond({
          url: results.url,
          timestamp: results.timestamp,
          violations: violations,
          passesCount: results.passes.length,
          incompleteCount: results.incomplete.length
        });
      }).catch(err => {
        respond({ error: `Axe Run Error: ${err.message}` });
      });

      return true; // Async
    }


    // --- SEMANTIC SEARCH (Pre-Resolution) ---
    if (request.action === 'semantic_find') {
      const api = (typeof chrome !== "undefined") ? chrome : browser;

      // 1. Gather all candidates
      const candidates = [];
      for (const [id, node] of window.uplink.map.entries()) {
        const label = getLabel(node);
        if (label && label.length > 2) {
          const context = getContextAttrs(node);
          candidates.push({
            id: id,
            text: `${label} ${context}`.trim()
          });
        }
      }

      if (candidates.length === 0) {
        getPageSnapshot();
        for (const [id, node] of window.uplink.map.entries()) {
          const label = getLabel(node);
          if (label && label.length > 2) {
            const context = getContextAttrs(node);
            candidates.push({ id: id, text: `${label} ${context}`.trim() });
          }
        }
      }

      // 2. Offload to Background AI
      (async () => {
        const bestMatch = await api.runtime.sendMessage({
          action: 'semantic_search',
          query: request.query,
          candidates: candidates
        });

        // 3. Handle Result
        if (bestMatch && bestMatch.score > 0.3) {
          const matchEl = window.uplink.map.get(bestMatch.id);
          if (matchEl) {
            matchEl.scrollIntoView({ behavior: "smooth", block: "center" });
            const rect = matchEl.getBoundingClientRect();
            createOverlay(rect, `Found: ${bestMatch.score.toFixed(2)}`);
            respond(`Found [${bestMatch.id}] "${bestMatch.text}" (Confidence: ${bestMatch.score.toFixed(2)})`);
          } else {
            respond({ error: "Match found but element reference lost." });
          }
        } else {
          const debugMsg = bestMatch
            ? `Top match: "${bestMatch.text}" (Score: ${bestMatch.score.toFixed(4)})`
            : "No candidates returned by AI.";
          respond({ error: `No element found > 0.3. ${debugMsg}` });
        }
      })();

      return true; // Async wait
    }

    // --- RESOLVE ELEMENT (ID vs Selector) ---
    // Universal element resolution for all interaction tools
    let el = null;


    const selector = request.selector;

    // Check if selector is a numeric ID (e.g., "42")
    if (selector && /^\d+$/.test(selector)) {
      const id = parseInt(selector);
      el = window.uplink.map.get(id);
      if (!el) {
        // If using an ID that doesn't exist, we can't really "wait" for it easily 
        // without re-parsing, but for now we'll just fail or let wait_for handle it differently?
        // For now, if ID not found, treat as null.
      }
    } else if (selector) {
      // Fallback to standard CSS selector
      el = document.querySelector(selector);
    }

    // ACTION: WAIT_FOR (Special handling for polling)
    if (request.action === 'wait_for') {
      const timeout = request.timeout || 15000;
      const start = Date.now();

      const check = () => {
        let foundEl = null;
        if (/^\d+$/.test(request.selector)) {
          foundEl = window.uplink.map.get(parseInt(request.selector));
        } else {
          foundEl = document.querySelector(request.selector);
        }

        if (foundEl) {
          foundEl.scrollIntoView({ behavior: "smooth", block: "center" });
          createOverlay(foundEl.getBoundingClientRect(), "Found");
          const waitTime = Date.now() - start;
          respond(`Found element (waited ${waitTime}ms)`);
        } else if (Date.now() - start > timeout) {
          respond({ error: `Timeout waiting for ${request.selector}` });
        } else {
          requestAnimationFrame(check); // Poll every frame
        }
      };
      check();
      return true; // Async
    }

    // --- INTERACTION ---
    // Handle default target for press_key if no selector provided
    if (!el && request.action === 'press_key' && !request.selector) {
      el = document.activeElement || document.body;
    }

    if (!el) {
      respond({ error: `Element not found: ${request.selector}` });
      return true;
    }

    // Standard interactions on 'el'
    if (request.action === 'highlight') {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const rect = el.getBoundingClientRect();
      createOverlay(rect, request.label || `ID: ${selector}`);
      respond("Highlighted");
    }
    else if (request.action === 'click') {
      const start = performance.now();
      el.click();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      const duration = Math.round(performance.now() - start);
      PerfMon.recordInteraction('click', duration);
      respond(`Clicked (Internal: ${duration}ms)`);
    }
    else if (request.action === 'type') {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const rect = el.getBoundingClientRect();

      let label = `Typing: ${request.text}`;
      if (el.type === 'password') {
        label = "Typing: ••••••••";
      }
      createOverlay(rect, label);

      const start = performance.now();
      if (el.isContentEditable) {
        el.focus();
        document.execCommand('insertText', false, request.text);
        const duration = Math.round(performance.now() - start);
        PerfMon.recordInteraction('type', duration);
        respond(`Typed (ContentEditable, ${duration}ms)`);
      } else {
        el.value = request.text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const duration = Math.round(performance.now() - start);
        PerfMon.recordInteraction('type', duration);
        respond(`Typed (${duration}ms)`);
      }
    }
    else if (request.action === 'press_key') {
      const start = performance.now();
      const key = request.key;
      // Simple modifier check (not full support yet)
      const options = {
        key: key,
        code: key, // 'Enter' -> 'Enter'
        keyCode: key === 'Enter' ? 13 : 0,
        which: key === 'Enter' ? 13 : 0,
        bubbles: true,
        cancelable: true,
        view: window
      };

      el.dispatchEvent(new KeyboardEvent('keydown', options));
      el.dispatchEvent(new KeyboardEvent('keypress', options));
      el.dispatchEvent(new KeyboardEvent('keyup', options));

      const duration = Math.round(performance.now() - start);
      PerfMon.recordInteraction('press_key', duration);

      // If it's an input and we are "typing" a single char, might want input event
      if (key.length === 1 && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        // This is complex, so for now just rely on raw events or assume type_text is used for typing.
        // press_key is mostly for navigation/submission (Enter, Tab, Esc).
      }

      respond(`Pressed ${key} (${duration}ms)`);
    }
    else if (request.action === 'hover') {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const rect = el.getBoundingClientRect();
      createOverlay(rect, "Hovering");

      const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      };

      el.dispatchEvent(new MouseEvent('mouseover', eventOptions));
      el.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
      el.dispatchEvent(new MouseEvent('mousemove', eventOptions));

      if (typeof PointerEvent !== 'undefined') {
        el.dispatchEvent(new PointerEvent('pointerover', { ...eventOptions, pointerType: 'mouse' }));
        el.dispatchEvent(new PointerEvent('pointerenter', { ...eventOptions, pointerType: 'mouse' }));
        el.dispatchEvent(new PointerEvent('pointermove', { ...eventOptions, pointerType: 'mouse' }));
      }

      respond("Hovered");
    }
    else if (request.action === 'select_option') {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      createOverlay(el.getBoundingClientRect(), `Selecting: ${request.value}`);

      el.value = request.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      respond("Option Selected");
    }
    else if (request.action === 'get_html') {
      respond(el.outerHTML);
    }



  } catch (e) {
    respond({ error: e.toString() });
  }

  return true; // Keep channel open
});

// --- Markdown Converter ---
function htmlToMarkdown(root) {
  let output = '';

  function walk(node, indent = 0) {
    if (!node) return;

    // Ignore invisible or irrelevant elements
    if (node.nodeType === Node.ELEMENT_NODE) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;

      const tag = node.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'iframe', 'svg', 'button', 'input', 'select', 'textarea'].includes(tag)) return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      let text = node.textContent.replace(/\s+/g, ' ');
      if (text.trim()) output += text;
      return;
    }

    const tag = node.tagName.toLowerCase();
    let prefix = '';
    let suffix = '';

    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
      prefix = '\n\n' + '#'.repeat(parseInt(tag[1])) + ' ';
      suffix = '\n';
    } else if (tag === 'p') {
      prefix = '\n\n';
      suffix = '\n';
    } else if (tag === 'br') {
      output += '  \n';
      return;
    } else if (tag === 'a') {
      output += '[';
      // Children will populate the text
    } else if (tag === 'strong' || tag === 'b') {
      output += '**';
    } else if (tag === 'em' || tag === 'i') {
      output += '_';
    } else if (tag === 'code') {
      output += '`';
    } else if (tag === 'pre') {
      prefix = '\n```\n';
      suffix = '\n```\n';
    } else if (tag === 'li') {
      prefix = '\n' + '  '.repeat(indent) + '- ';
    } else if (tag === 'ul' || tag === 'ol') {
      // increase indentation for children
      indent++;
    } else if (tag === 'img') {
      const alt = node.getAttribute('alt') || 'image';
      const src = node.getAttribute('src') || '';
      if (src) output += `![${alt}](${src})`;
      return; // No children needed for img
    }

    output += prefix;

    // Process children
    for (let child of node.childNodes) {
      walk(child, indent);
    }

    // Closing tags
    if (tag === 'a') {
      const href = node.getAttribute('href') || '#';
      output += `](${href})`;
    } else if (tag === 'strong' || tag === 'b') {
      output += '**';
    } else if (tag === 'em' || tag === 'i') {
      output += '_';
    } else if (tag === 'code') {
      output += '`';
    }

    output += suffix;
  }

  walk(root);
  return output.replace(/\n{3,}/g, '\n\n').trim();
}
