// --- Console Interception ---
// We need to inject code into the main world to capture page logs
const script = document.createElement('script');
script.textContent = `
    (function() {
        const _log = console.log;
        const _warn = console.warn;
        const _error = console.error;
        const logs = [];
        
        function capture(type, args) {
            try {
                // Convert args to string safely
                const msg = args.map(a => 
                    typeof a === 'object' ? JSON.stringify(a) : String(a)
                ).join(' ');
                
                logs.push({type, msg, timestamp: Date.now()});
                // Keep buffer small
                if (logs.length > 500) logs.shift();
                
                // Dispatch event for content script
                window.dispatchEvent(new CustomEvent('mcp-console-log', {
                    detail: {type, msg, timestamp: Date.now()}
                }));
            } catch(e) {}
        }
        
        console.log = (...args) => { capture('log', args); _log.apply(console, args); };
        console.warn = (...args) => { capture('warn', args); _warn.apply(console, args); };
        console.error = (...args) => { capture('error', args); _error.apply(console, args); };
        
        // Expose logs retrieval
        window.__mcp_get_logs = () => logs;
    })();
`;
(document.head || document.documentElement).appendChild(script);

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
    else if (request.action === 'get_html') {
      respond(el.outerHTML);
    }
  } catch (e) {
    respond({ error: e.toString() });
  }

  return true; // Keep channel open
});
