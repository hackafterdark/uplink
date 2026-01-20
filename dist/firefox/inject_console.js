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

  // Hook Fetch
  const _fetch = window.fetch;
  window.fetch = async (...args) => {
    try {
      const response = await _fetch(...args);
      if (!response.ok) {
        capture('error', `Fetch Error: ${response.status} ${response.statusText}`, `URL: ${args[0]}`);
      }
      return response;
    } catch (e) {
      capture('error', `Fetch Failed: ${e.message}`, `URL: ${args[0]}`);
      throw e;
    }
  };

})();
