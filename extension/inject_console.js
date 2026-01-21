(function () {
  // Prevent multiple injections
  if (window.__mcp_console_injected) return;
  window.__mcp_console_injected = true;

  const logs = [];
  const MAX_LOGS = 50;

  function cleanStack(stack) {
    if (!stack) return '';
    return stack.split('\n').slice(0, 5).join('\n'); // Top 5 frames only
  }

  function capture(type, msg, stack = '') {
    try {
      const entry = {
        type,
        msg: String(msg),
        stack: cleanStack(stack),
        timestamp: Date.now(),
        url: window.location.href
      };

      // Deduplication: Don't add if identical to the last one
      const last = logs[logs.length - 1];
      if (last && last.type === type && last.msg === entry.msg && last.stack === entry.stack) {
        last.count = (last.count || 1) + 1;
        last.timestamp = Date.now(); // Update timestamp
        return;
      }

      logs.push(entry);
      if (logs.length > MAX_LOGS) logs.shift();

      // Dispatch event for content script
      window.dispatchEvent(new CustomEvent('mcp-console-log', {
        detail: entry
      }));
    } catch (e) {
      // Prevent recursion if capture fails
    }
  }

  // Hook Console
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;

  console.warn = (...args) => {
    capture('warn', args.join(' '));
    try { _warn.apply(console, args); } catch (e) { }
  };

  console.error = (...args) => {
    const msg = args.map(a => (a instanceof Error) ? a.message : String(a)).join(' ');
    const stack = args.find(a => a instanceof Error)?.stack || new Error().stack;
    capture('error', msg, stack);
    try { _error.apply(console, args); } catch (e) { }
  };

  // Hook Unhandled Errors
  window.addEventListener('error', (event) => {
    capture('error', event.message || 'Unknown Error', event.error?.stack);
  });

  window.addEventListener('unhandledrejection', (event) => {
    capture('error', `Unhandled Promise Rejection: ${event.reason}`, event.reason?.stack);
  });

  // --- Network Capture ---
  function captureNetwork(data) {
    try {
      window.dispatchEvent(new CustomEvent('mcp-network-log', {
        detail: {
          timestamp: Date.now(),
          ...data
        }
      }));
    } catch (e) { }
  }

  // Hook Fetch
  const _fetch = window.fetch;
  window.fetch = async (...args) => {
    const method = args[1]?.method || 'GET';
    const url = String(args[0]);

    try {
      const response = await _fetch(...args);

      // Clone to read body without consuming original stream
      const clone = response.clone();

      // Asynchronously process response
      (async () => {
        let body = null;
        const contentType = clone.headers.get('content-type') || '';

        // Only read text/json to avoid perf issues
        if (contentType.includes('json') || contentType.includes('text') || contentType.includes('xml')) {
          try {
            const text = await clone.text();
            body = text.slice(0, 10000); // Limit to 10KB
            if (text.length > 10000) body += '...[TRUNCATED]';
          } catch (e) { body = `[Error reading body: ${e.message}]`; }
        } else {
          body = `[Binary/Opaque Content: ${contentType}]`;
        }

        captureNetwork({
          type: 'fetch',
          method: method,
          url: url,
          status: response.status,
          statusText: response.statusText,
          response: body
        });
      })();

      return response;
    } catch (e) {
      captureNetwork({ type: 'fetch', method, url, status: 0, statusText: 'Current Error: ' + e.message, response: null });
      throw e;
    }
  };

  // Hook XHR
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._mcp_metadata = { method, url };
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', () => {
      if (!this._mcp_metadata) return;

      let responseBody = null;
      try {
        const contentType = this.getResponseHeader('content-type') || '';
        if (this.responseType === '' || this.responseType === 'text') {
          responseBody = this.responseText.slice(0, 10000);
        } else if (this.responseType === 'json') {
          responseBody = JSON.stringify(this.response); // Helper only
        } else {
          responseBody = `[${this.responseType || 'blob'}]`;
        }
      } catch (e) { responseBody = `[Error: ${e.message}]`; }

      captureNetwork({
        type: 'xhr',
        method: this._mcp_metadata.method,
        url: this._mcp_metadata.url,
        status: this.status,
        statusText: this.statusText,
        response: responseBody
      });
    });
    return _send.apply(this, arguments);
  };

})();
