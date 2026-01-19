const api = (typeof chrome !== "undefined") ? chrome : browser;
let socket = null;
let keepAliveInterval = null;
let recordingState = false;
let panicMode = false; // 🛑 PANIC MODE State
let dashboardPorts = new Set(); // Active dashboard connections
let logHistory = []; // persist logs in memory

// --- SECURITY STATE ---
let allowLocalFiles = false; // Default: Block file://
let allowDataTools = true; // Default: Allow cookies/storage
let userBlocklist = []; // User-defined glob patterns
let lastCommandTime = 0;
let rateLimitMs = 500; // Default 500ms
let serverPort = 8765; // Default Port

const MAX_TYPE_LENGTH = 10000;
const MAX_SCRIPT_LENGTH = 100000;

// Hardcoded Restricted Protocols (Always Blocked)
const RESTRICTED_PROTOCOLS = ['chrome:', 'edge:', 'about:', 'brave:', 'opera:'];

// Load saved security settings
api.storage.local.get(['allowLocalFiles', 'allowDataTools', 'userBlocklist', 'panicMode', 'rateLimitMs', 'serverPort'], (result) => {
  if (result.allowLocalFiles !== undefined) allowLocalFiles = result.allowLocalFiles;
  if (result.allowDataTools !== undefined) allowDataTools = result.allowDataTools;
  if (result.userBlocklist !== undefined) userBlocklist = result.userBlocklist;
  if (result.panicMode !== undefined) panicMode = result.panicMode;
  if (result.rateLimitMs !== undefined) rateLimitMs = result.rateLimitMs;
  if (result.serverPort !== undefined) serverPort = result.serverPort;
});

// Helper: Glob to Regex
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const finalParams = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${finalParams}$`, 'i');
}

function checkUrlAllowed(url) {
  if (!url) return true;
  try {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol;

    if (RESTRICTED_PROTOCOLS.some(p => protocol.startsWith(p))) {
      return { allowed: false, reason: "Restricted System Protocol" };
    }

    if (protocol === 'file:' && !allowLocalFiles) {
      return { allowed: false, reason: "Local File Access Disabled" };
    }

    const domain = urlObj.hostname;
    const fullUrl = url;

    for (const pattern of userBlocklist) {
      const regex = globToRegex(pattern);
      if (regex.test(domain) || regex.test(fullUrl)) {
        return { allowed: false, reason: `Blocked by User Rule: ${pattern}` };
      }
    }

    return { allowed: true };
  } catch (e) {
    if (url.startsWith('about:')) return { allowed: false, reason: "Restricted System Protocol" };
    return { allowed: true };
  }
}

// Dynamic Socket URL
function getSocketUrl() {
  return `ws://127.0.0.1:${serverPort}?token=mcp-browser-bridge-secret`;
}

// remove const socketUrl = ... we use getSocketUrl() now
let manualDisconnect = false;

// Keep-Alive Mechanism
function startKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(() => {
    // 1. Local API call to reset idle timer
    api.runtime.getPlatformInfo(() => {
      // no-op
    });

    // 2. Log to console (active devtools keeps it alive)
    console.log("Keep-Alive Heartbeat");

    // 3. Update dashboard if connected
    if (dashboardPorts.size > 0 && socket && socket.readyState === WebSocket.OPEN) {
      // Optional: We could broadcast a heartbeat here if needed
    }
  }, 20000); // 20s
}

function stopKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

function connect() {
  if (manualDisconnect) return;

  // Cleanup existing connection to prevent duplicates
  if (socket) {
    try { socket.close(); } catch (e) { }
    socket = null;
  }

  broadcastLog("SYSTEM", `Attempting WebSocket connection to port ${serverPort}...`);
  socket = new WebSocket(getSocketUrl());

  socket.onopen = () => {
    console.log('Connected to MCP Server');
    broadcastLog("SYSTEM", "WebSocket connection OPEN");
    broadcastState();
    startKeepAlive();
  };

  socket.onmessage = async (event) => {
    const command = JSON.parse(event.data);
    await handleIncomingMessage(command);
  };

  socket.onclose = () => {
    console.log('Disconnected.');
    socket = null;
    stopKeepAlive();
    broadcastState();

    if (!manualDisconnect) {
      console.log('Reconnecting in 5s...');
      setTimeout(connect, 5000);
    }
  };

  socket.onerror = (error) => {
    console.error('WebSocket Error:', error);
    broadcastLog("ERROR", "WebSocket connection failure");
  };
}

async function handleIncomingMessage(command) {
  if (panicMode) {
    console.warn("Command blocked by PANIC MODE:", command);
    broadcastLog("BLOCKED", `Action: ${command.action} (Panic Mode Active)`);
    if (socket) socket.send(JSON.stringify({ error: "Command blocked: Panic Mode is ENABLED locally." }));
    return;
  }

  let logDetails = "";
  if (command.url) logDetails += ` → ${command.url}`;
  if (command.selector) logDetails += ` [${command.selector}]`;

  let safeText = command.text;
  if (command.action === "type_text" || command.action === "type") {
    let isPwd = false;
    try {
      isPwd = await checkIsPasswordField(command.selector);
    } catch (e) {
      console.warn("Password check error:", e);
    }
    if (!isPwd && command.selector && command.selector.toLowerCase().includes('password')) {
      isPwd = true;
    }
    if (isPwd) {
      safeText = "******** (Redacted)";
    }
  }

  if (command.text) logDetails += ` "${safeText}"`;
  if (command.key) logDetails += ` (key=${command.key})`;

  broadcastLog(command.action.toUpperCase(), logDetails);

  try {
    await handleCommand(command);
  } catch (err) {
    console.error("Command Execution Error:", err);
    broadcastLog("ERROR", err.message);
    if (socket) socket.send(JSON.stringify({ error: "Internal Extension Error: " + err.message }));
  }
}

async function checkIsPasswordField(selector) {
  if (!selector) return false;
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) return false;

    const results = await api.scripting.executeScript({
      target: { tabId: tabs[0].id, allFrames: true },
      func: (sel) => {
        const el = document.querySelector(sel);
        return el ? el.type === 'password' : false;
      },
      args: [selector]
    });
    return results.some(r => r.result === true);
  } catch (e) {
    return false;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "dashboard") {
    dashboardPorts.add(port);

    port.onDisconnect.addListener(() => {
      dashboardPorts.delete(port);
    });

    port.onMessage.addListener((msg) => {
      try {
        if (msg.type === "GET_STATE") {
          broadcastState();
        }
        if (msg.type === "SET_PANIC") {
          panicMode = msg.value;
          api.storage.local.set({ panicMode: panicMode });
          broadcastState();
        }
        if (msg.type === "SET_RATE_LIMIT") {
          rateLimitMs = parseInt(msg.value);
          if (isNaN(rateLimitMs)) rateLimitMs = 500;
          api.storage.local.set({ rateLimitMs: rateLimitMs });
          broadcastState();
        }
        if (msg.type === "SET_PORT") {
          const newPort = parseInt(msg.value);
          if (!isNaN(newPort) && newPort !== serverPort) {
            serverPort = newPort;
            api.storage.local.set({ serverPort: serverPort });
            broadcastLog("SYSTEM", `Port changed to ${serverPort}. Reconnecting...`);

            // Force reconnect
            if (socket) {
              try { socket.close(); } catch (e) { }
              socket = null;
            }
            manualDisconnect = false;
            connect();
          }
        }
        if (msg.type === "SET_LOCAL_FILES") {
          allowLocalFiles = msg.value;
          api.storage.local.set({ allowLocalFiles: allowLocalFiles });
          broadcastState();
        }
        if (msg.type === "SET_ALLOW_DATA_TOOLS") {
          allowDataTools = msg.value;
          api.storage.local.set({ allowDataTools: allowDataTools });
          broadcastState();
        }
        if (msg.type === "ADD_BLOCKLIST_ITEM") {
          if (!Array.isArray(userBlocklist)) userBlocklist = [];
          if (!userBlocklist.includes(msg.value)) {
            userBlocklist.push(msg.value);
            api.storage.local.set({ userBlocklist: userBlocklist });
            broadcastLog("SYSTEM", `Blocked added: ${msg.value} (Total: ${userBlocklist.length})`);
            broadcastState();
          }
        }
        if (msg.type === "REMOVE_BLOCKLIST_ITEM") {
          if (!Array.isArray(userBlocklist)) userBlocklist = [];
          userBlocklist = userBlocklist.filter(item => item !== msg.value);
          api.storage.local.set({ userBlocklist: userBlocklist });
          broadcastLog("SYSTEM", `Blocked removed: ${msg.value}`);
          broadcastState();
        }
        if (msg.type === "TOGGLE_CONNECTION") {
          if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            // Disconnect
            manualDisconnect = true;
            socket.close();
            logHistory.unshift({ action: "SYSTEM", details: "Disconnected by user request", time: new Date().toISOString() });
            broadcastState();
          } else {
            // Connect
            manualDisconnect = false;
            if (socket) {
              try { socket.close(); } catch (e) { }
              socket = null;
            }
            connect();
            logHistory.unshift({ action: "SYSTEM", details: "Connecting by user request...", time: new Date().toISOString() });
            broadcastState();
          }
        }
      } catch (err) {
        console.error("Dashboard Msg Error:", err);
        broadcastLog("ERROR", "Dashboard handler: " + err.message);
      }
    });
  }
});

function broadcastState() {
  const state = {
    connected: socket && socket.readyState === WebSocket.OPEN,
    panicMode: panicMode,
    allowLocalFiles: allowLocalFiles,
    allowDataTools: allowDataTools,
    userBlocklist: userBlocklist,
    rateLimitMs: rateLimitMs,
    serverPort: serverPort,
    logs: logHistory
  };
  for (const port of dashboardPorts) {
    try { port.postMessage({ type: "STATE_UPDATE", state: state }); } catch (e) { }
  }
}

function broadcastLog(action, details) {
  const entry = {
    action,
    details,
    time: new Date().toISOString()
  };

  logHistory.unshift(entry);
  if (logHistory.length > 500) logHistory.pop();

  for (const port of dashboardPorts) {
    try { port.postMessage({ type: "LOG_ENTRY", ...entry }); } catch (e) { }
  }
}

async function handleCommand(command) {
  const now = Date.now();
  if (now - lastCommandTime < rateLimitMs) {
    await new Promise(r => setTimeout(r, rateLimitMs - (now - lastCommandTime)));
  }
  lastCommandTime = Date.now();

  if (command.action === 'type_text' || command.action === 'type') {
    if (command.text && command.text.length > MAX_TYPE_LENGTH) {
      throw new Error(`Input text exceeds limit (${MAX_TYPE_LENGTH} chars)`);
    }
  }
  if (command.action === 'execute_script' || command.action === 'execute') {
    if (command.script && command.script.length > MAX_SCRIPT_LENGTH) {
      throw new Error(`Script exceeds limit (${MAX_SCRIPT_LENGTH} chars)`);
    }
  }

  if (command.action === 'navigate' || command.action === 'open_tab') {
    const check = checkUrlAllowed(command.url);
    if (!check.allowed) {
      throw new Error(`Navigation Blocked: ${check.reason}`);
    }
  }

  if (command.action === "start_recording") {
    await startRecording(command);
    return;
  }
  if (command.action === "stop_recording") {
    await stopRecording(command);
    return;
  }

  if (command.action === "open_tab") {
    try {
      const tab = await api.tabs.create({ url: command.url, active: true });

      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          api.tabs.onUpdated.removeListener(listener);
          reject(new Error("Open tab timed out (15s)"));
        }, 15000);

        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tab.id && changeInfo.status === 'complete') {
            clearTimeout(timeoutId);
            api.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        api.tabs.onUpdated.addListener(listener);
      });

      socket.send(JSON.stringify(`Opened tab ${command.url}`));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) {
    socket.send(JSON.stringify({ error: "No active tab" }));
    return;
  }
  const tabId = tabs[0].id;

  if (command.action === "screenshot") {
    try {
      const dataUrl = await api.tabs.captureVisibleTab(null, { format: "png" });
      socket.send(JSON.stringify(dataUrl));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "navigate" || command.action === "go_back" || command.action === "go_forward" || command.action === "reload_page") {
    try {
      if (command.action === "go_back") {
        await api.tabs.goBack(tabId);
      } else if (command.action === "go_forward") {
        await api.tabs.goForward(tabId);
      } else if (command.action === "reload_page") {
        await api.tabs.reload(tabId);
      } else {
        await api.tabs.update(tabId, { url: command.url });
      }

      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          api.tabs.onUpdated.removeListener(listener);
          reject(new Error("Navigation timed out (15s)"));
        }, 15000);

        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tabId && changeInfo.status === 'complete') {
            clearTimeout(timeoutId);
            api.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        api.tabs.onUpdated.addListener(listener);
      });

      socket.send(JSON.stringify("Navigation Complete"));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "set_viewport") {
    try {
      const windowId = await api.windows.getCurrent().then(w => w.id);
      await api.windows.update(windowId, {
        width: command.width,
        height: command.height,
        state: "normal" // Ensure not maximized/minimized
      });
      socket.send(JSON.stringify(`Viewport set to ${command.width}x${command.height}`));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "execute") {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: (code) => {
          try {
            return window.eval(code);
          } catch (e) {
            return "Error: " + e.message;
          }
        },
        args: [command.script]
      });
      socket.send(JSON.stringify(results[0].result || "Executed"));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "get_logs") {
    try {
      await api.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: () => {
          if (window.__mcp_console_hooked) return;

          const _log = console.log;
          const _warn = console.warn;
          const _error = console.error;
          window.__mcp_logs = [];

          function capture(type, args) {
            try {
              const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
              window.__mcp_logs.push({ type, msg, timestamp: Date.now() });
              if (window.__mcp_logs.length > 500) window.__mcp_logs.shift();
            } catch (e) { }
          }

          console.log = (...args) => { capture('log', args); _log.apply(console, args); };
          console.warn = (...args) => { capture('warn', args); _warn.apply(console, args); };
          console.error = (...args) => { capture('error', args); _error.apply(console, args); };
          window.__mcp_console_hooked = true;
        }
      });

      const results = await api.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: () => window.__mcp_logs || []
      });

      await api.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: () => { window.__mcp_logs = []; }
      });

      socket.send(JSON.stringify(results[0].result));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "read") {
    try {
      // Forward to content script which has the new DOM Parser
      const response = await api.tabs.sendMessage(tabId, command);
      socket.send(JSON.stringify(response || "Page is empty"));
    } catch (err) {
      // Fallback if content script not loaded (e.g. restricted page)
      if (err.message.includes("receiving end does not exist")) {
        socket.send(JSON.stringify({ error: "Please reload the page to activate the extension." }));
      } else {
        socket.send(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  if (["click", "type", "highlight", "get_html", "wait_for"].includes(command.action)) {
    try {
      let targetFrameId = 0;

      if (command.selector) {
        // If it's a numeric ID (Project Uplink), skip pre-check and assume Main Frame (0)
        // because we can't querySelector an ID that only exists in the content script's memory.
        if (/^\d+$/.test(command.selector)) {
          targetFrameId = 0;
        } else {
          // Standard CSS Selector: Find which frame contains the element
          const searchResults = await api.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            func: (sel) => !!document.querySelector(sel),
            args: [command.selector]
          });
          const match = searchResults.find(r => r.result === true);
          if (match) {
            targetFrameId = match.frameId;
          } else if (command.action !== 'wait_for') {
            socket.send(JSON.stringify({ error: `Element not found: ${command.selector}` }));
            return;
          }
        }
      }

      if (command.action === 'wait_for') {
        const timeout = command.timeout || 15000;
        const start = Date.now();

        const poll = async () => {
          const results = await api.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            func: (sel) => !!document.querySelector(sel),
            args: [command.selector]
          });
          if (results.some(r => r.result)) {
            socket.send(JSON.stringify("Found element"));
          } else if (Date.now() - start > timeout) {
            socket.send(JSON.stringify({ error: "Timeout" }));
          } else {
            setTimeout(poll, 500);
          }
        };
        poll();
        return;
      }

      const response = await api.tabs.sendMessage(tabId, command, { frameId: targetFrameId });
      socket.send(JSON.stringify(response || "Done"));

    } catch (err) {
      socket.send(JSON.stringify({ error: "Frame Error: " + err.message }));
    }
    return;
  }


  // --- DATA TOOL SECURITY CHECK ---
  if (['get_cookies', 'set_cookie', 'get_storage', 'set_storage', 'clear_storage'].includes(command.action)) {
    if (!allowDataTools) {
      socket.send(JSON.stringify({ error: "Data tools are disabled by security policy." }));
      return;
    }
  }

  // --- REDACTION HELPER ---
  const sanitize = (data) => {
    if (!data) return data;
    const sensitiveKeys = ['token', 'auth', 'key', 'password', 'secret', 'session'];
    // Simple key-value pair redaction for cookies/storage objects
    // If it's a string (cookies), we might need regex, but let's assume raw string for now.
    // Actually, for document.cookie it's "key=value; key2=value2"

    // For string output (Cookies)
    if (typeof data === 'string') {
      let masked = data;
      sensitiveKeys.forEach(key => {
        const regex = new RegExp(`(${key}[^=]*)=([^;]*)`, 'gi');
        masked = masked.replace(regex, '$1=********(Redacted)');
      });
      return masked;
    }
    return data;
  }

  if (command.action === "get_cookies") {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: tabId },
        func: () => document.cookie
      });
      const rawCookies = results[0].result || "";
      socket.send(JSON.stringify(sanitize(rawCookies)));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "set_cookie") {
    try {
      await api.scripting.executeScript({
        target: { tabId: tabId },
        func: (n, v) => { document.cookie = `${n}=${v}; path=/`; },
        args: [command.name, command.value]
      });
      socket.send(JSON.stringify(`Cookie set: ${command.name}`));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "get_storage") {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: (type, key) => {
          try {
            const storage = (type === 'session') ? window.sessionStorage : window.localStorage;
            return storage.getItem(key);
          } catch (e) { return null; }
        },
        args: [command.storageType, command.key]
      });
      // Sanitize single value if key is sensitive
      let val = results[0].result;
      const keyLower = command.key.toLowerCase();
      if (['token', 'auth', 'key', 'password', 'secret', 'session'].some(s => keyLower.includes(s))) {
        val = "******** (Redacted)";
      }
      socket.send(JSON.stringify(val));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "set_storage") {
    try {
      await api.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: (type, key, value) => {
          const storage = (type === 'session') ? window.sessionStorage : window.localStorage;
          storage.setItem(key, value);
        },
        args: [command.storageType, command.key, command.value]
      });
      socket.send(JSON.stringify(`Storage set: ${command.key}`));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "clear_storage") {
    try {
      await api.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: (type) => {
          const storage = (type === 'session') ? window.sessionStorage : window.localStorage;
          storage.clear();
        },
        args: [command.storageType]
      });
      socket.send(JSON.stringify("Storage cleared"));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "get_metadata") {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: tabId },
        func: () => {
          const getMeta = (name) => {
            const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
            return el ? el.content : null;
          };
          return {
            title: document.title,
            description: getMeta('description') || getMeta('og:description'),
            keywords: getMeta('keywords'),
            author: getMeta('author'),
            ogImage: getMeta('og:image'),
            ogUrl: getMeta('og:url'),
            favicon: document.querySelector('link[rel~="icon"]')?.href
          };
        }
      });
      socket.send(JSON.stringify(results[0].result));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  try {
    const response = await api.tabs.sendMessage(tabId, command);
    socket.send(JSON.stringify(response || "Done"));
  } catch (err) {
    socket.send(JSON.stringify({ error: "Content script error: " + err.message }));
  }
}

async function createOffscreen() {
  if (await api.offscreen.hasDocument()) return;
  await api.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Recording tab video'
  });
}

async function startRecording(command) {
  try {
    // Feature Detection for Firefox/Safari etc.
    if (!api.offscreen) {
      throw new Error("Video recording not supported in this browser (requires chrome.offscreen API). Please use Chrome or Edge.");
    }

    await createOffscreen();
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) throw new Error("No active tab to record");

    const streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tabs[0].id });

    api.runtime.sendMessage({
      type: 'START_RECORDING',
      target: 'offscreen',
      data: { streamId: streamId }
    });

    recordingState = true;
    socket.send(JSON.stringify("Recording started"));
  } catch (err) {
    socket.send(JSON.stringify({ error: "Start recording failed: " + err.message }));
  }
}

async function stopRecording(command) {
  if (!recordingState) {
    socket.send(JSON.stringify({ error: "Not recording" }));
    return;
  }

  api.runtime.sendMessage({
    type: 'STOP_RECORDING',
    target: 'offscreen'
  });

  const dataHandler = (message) => {
    if (message.type === 'RECORDING_DATA') {
      socket.send(message.data);
      recordingState = false;
      api.runtime.onMessage.removeListener(dataHandler);
      api.offscreen.closeDocument();
    }
  };
  api.runtime.onMessage.addListener(dataHandler);
}

connect();
