(function () {
  // Prevent multiple injections
  if (window.__mcp_console_injected) return;
  window.__mcp_console_injected = true;

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

      logs.push({ type, msg, timestamp: Date.now() });
      // Keep buffer small
      if (logs.length > 500) logs.shift();

      // Dispatch event for content script
      window.dispatchEvent(new CustomEvent('mcp-console-log', {
        detail: { type, msg, timestamp: Date.now() }
      }));
    } catch (e) { }
  }

  console.log = (...args) => { capture('log', args); _log.apply(console, args); };
  console.warn = (...args) => { capture('warn', args); _warn.apply(console, args); };
  console.error = (...args) => { capture('error', args); _error.apply(console, args); };

  // Expose logs retrieval
  window.__mcp_get_logs = () => logs;
})();
