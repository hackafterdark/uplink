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
});

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
 * Scans the page for interactive elements and text.
 * Returns a simplified text representation for the AI.
 */
function getPageSnapshot() {
  // Reset state
  window.uplink.map.clear();
  window.uplink.idCounter = 0;

  let output = [];

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

  // Helper: Get a meaningful label for the element
  function getLabel(el) {
    return (
      el.getAttribute('aria-label') ||
      el.innerText ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      el.getAttribute('title') ||
      el.value ||
      ''
    ).replace(/\s+/g, ' ').trim().slice(0, 100); // Clean and cap length
  }

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
      // Standard interactive tags
      if (['a', 'button', 'select', 'textarea', 'details', 'summary'].includes(tag)) isInteractive = true;
      // Inputs (skip hidden)
      if (tag === 'input' && node.type !== 'hidden') isInteractive = true;
      // ARIA roles or explicit click handlers
      if (node.getAttribute('role') === 'button' || node.onclick) {
        isInteractive = true;
        role = 'button';
      }

      // 2. Capture Important Text (Context)
      // Only non-interactive text containers to avoid duplication
      if (!isInteractive && ['h1', 'h2', 'h3', 'p', 'li', 'span', 'div'].includes(tag)) {
        // Get direct text content only (ignore children's text to prevent nesting noise)
        const directText = Array.from(node.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .join(' ');

        if (directText.length > 3) { // Ignore tiny artifacts
          output.push(`    ${directText}`);
        }
      }

      // 3. Register Interactive Element
      if (isInteractive) {
        window.uplink.idCounter++;
        const id = window.uplink.idCounter;
        let label = getLabel(node);

        // Fallback for unlabeled inputs
        if (!label && tag === 'input') label = '[Input]';
        if (!label && tag === 'select') label = '[Dropdown]';

        // Store reference
        window.uplink.map.set(id, node);

        output.push(`[${id}] <${role}> "${label}"`);
      }

      // 4. Handle Shadow DOM (Recursion)
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
        const snapshot = getPageSnapshot();
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
          respond("Found element");
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
      el.click();
      // Also dispatch generic events for React/Angular apps
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      respond("Clicked");
    }
    else if (request.action === 'type') {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const rect = el.getBoundingClientRect();

      let label = `Typing: ${request.text}`;
      if (el.type === 'password') {
        label = "Typing: ••••••••";
      }
      createOverlay(rect, label);

      if (el.isContentEditable) {
        el.focus();
        document.execCommand('insertText', false, request.text);
        respond("Typed (ContentEditable)");
      } else {
        el.value = request.text;
        // React/Angular often need these
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        respond("Typed");
      }
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
