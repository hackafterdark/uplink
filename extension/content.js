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

// --- Message Handler ---
const api = (typeof chrome !== "undefined") ? chrome : browser;

api.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Helper to resolve the promise safely
  const respond = (data) => sendResponse(data);

  if (request.action === 'read') {
    respond(document.body.innerText.substring(0, 10000)); // Limit to 10k chars
    return true;
  }

  if (request.action === 'get_logs') {
    respond(JSON.stringify(capturedLogs));
    capturedLogs = []; // Clear after reading
    return true;
  }

  if (request.action === 'execute') {
    try {
      const result = eval(request.script);
      respond(String(result));
    } catch (e) {
      respond("Error: " + e.message);
    }
    return true;
  }

  if (request.action === 'wait_for') {
    const timeout = request.timeout || 15000;
    const start = Date.now();

    const check = () => {
      const el = document.querySelector(request.selector);
      if (el) {
        // Highlight found element
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        createOverlay(el.getBoundingClientRect(), "Found");
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

  if (request.action === 'read_as_markdown') {
    const md = htmlToMarkdown(document.body);
    respond(md);
    return true;
  }

  // DOM Interaction requiring selectors (immediate)
  try {
    const el = document.querySelector(request.selector);

    if (!el && request.action !== 'wait_for') {
      respond({ error: `Element not found: ${request.selector}` });
      return true;
    }

    if (request.action === 'highlight') {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const rect = el.getBoundingClientRect();
      createOverlay(rect, request.label);
      respond("Highlighted");
    }
    else if (request.action === 'click') {
      el.click();
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

      // Also fire pointer events for modern compatibility
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
