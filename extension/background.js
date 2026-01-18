const api = (typeof chrome !== "undefined") ? chrome : browser;
let socket = null;
let keepAliveInterval = null;
let recordingState = false;
let panicMode = false; // 🛑 PANIC MODE State
let dashboardPorts = new Set(); // Active dashboard connections
let logHistory = []; // persist logs in memory

// --- SECURITY STATE ---
let allowLocalFiles = false; // Default: Block file://
let userBlocklist = []; // User-defined glob patterns
let lastCommandTime = 0;
let rateLimitMs = 500; // Default 500ms
const MAX_TYPE_LENGTH = 10000;
const MAX_SCRIPT_LENGTH = 100000;

// Hardcoded Restricted Protocols (Always Blocked)
const RESTRICTED_PROTOCOLS = ['chrome:', 'edge:', 'about:', 'brave:', 'opera:'];

// Load saved security settings
api.storage.local.get(['allowLocalFiles', 'userBlocklist', 'panicMode', 'rateLimitMs'], (result) => {
  if (result.allowLocalFiles !== undefined) allowLocalFiles = result.allowLocalFiles;
  if (result.userBlocklist !== undefined) userBlocklist = result.userBlocklist;
  if (result.panicMode !== undefined) panicMode = result.panicMode;
  if (result.rateLimitMs !== undefined) rateLimitMs = result.rateLimitMs;
});

// Helper: Glob to Regex
function globToRegex(pattern) {
  // Escape regex characters except *
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Convert * to .*
  const finalParams = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${finalParams}$`, 'i'); // Case insensitive, full match
}

function checkUrlAllowed(url) {
  if (!url) return true; // Non-navigation commands don't have URLs usually
  try {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol;

    // 1. Check Hardcoded Protocols
    if (RESTRICTED_PROTOCOLS.some(p => protocol.startsWith(p))) {
      return { allowed: false, reason: "Restricted System Protocol" };
    }

    // 2. Check Local Files
    if (protocol === 'file:' && !allowLocalFiles) {
      return { allowed: false, reason: "Local File Access Disabled" };
    }

    // 3. Check User Blocklist (Glob Patterns)
    const domain = urlObj.hostname;
    const fullUrl = url; // Match against full URL for path blocking

    for (const pattern of userBlocklist) {
      const regex = globToRegex(pattern);
      if (regex.test(domain) || regex.test(fullUrl)) {
        return { allowed: false, reason: `Blocked by User Rule: ${pattern}` };
      }
    }

    return { allowed: true };
  } catch (e) {
    // Invalid URL? If it's not a URL (e.g. "about:blank"), we might catch it above or here.
    // "about:blank" parses as protocol "about:" in some environments or fails.
    if (url.startsWith('about:')) return { allowed: false, reason: "Restricted System Protocol" };
    return { allowed: true }; // Allow if we can't parse (e.g. data uri? maybe block specific ones?)
  }
}
const socketUrl = 'ws://127.0.0.1:8765?token=mcp-browser-bridge-secret';
function connect() {
  socket = new WebSocket(socketUrl);

  socket.onopen = () => {
    console.log('Connected to MCP Server');
    broadcastState(); // Notify dashboard
  };

  socket.onmessage = async (event) => {
    const command = JSON.parse(event.data);

    // --- 🛑 SECURITY CHECK: PANIC MODE ---
    if (panicMode) {
      console.warn("Command blocked by PANIC MODE:", command);
      // We still log it to dashboard so user sees what WAS blocked
      broadcastLog("BLOCKED", `Action: ${command.action} (Panic Mode Active)`);
      socket.send(JSON.stringify({ error: "Command blocked: Panic Mode is ENABLED locally." }));
      return;
    }

    // Only log incoming commands, prevent spam

    // Create detailed log message
    let logDetails = "";
    if (command.url) logDetails += ` → ${command.url}`;
    if (command.selector) logDetails += ` [${command.selector}]`;

    // SECURE LOGGING: Check if typing into a password field
    let safeText = command.text;
    if (command.action === "type_text" || command.action === "type") {
      let isPwd = false;

      // 1. Try DOM Inspection
      try {
        isPwd = await checkIsPasswordField(command.selector);
      } catch (e) {
        console.warn("Password check error:", e);
      }

      // 2. Fallback Heuristic (if DOM check didn't catch it)
      if (!isPwd && command.selector && command.selector.toLowerCase().includes('password')) {
        isPwd = true; // Selector implies password
      }

      if (isPwd) {
        safeText = "******** (Redacted)";
      }
    }

    if (command.text) logDetails += ` "${safeText}"`;
    if (command.key) logDetails += ` (key=${command.key})`;

    broadcastLog(command.action.toUpperCase(), logDetails); // Log to dashboard

    try {
      await handleCommand(command);
    } catch (err) {
      console.error("Command Execution Error:", err);
      broadcastLog("ERROR", err.message);
      socket.send(JSON.stringify({ error: "Internal Extension Error: " + err.message }));
    }
  };

  socket.onclose = () => {
    console.log('Disconnected. Reconnecting in 5s...');
    broadcastState(); // Notify dashboard
    setTimeout(connect, 5000);
  };

  socket.onerror = (error) => {
    console.error('WebSocket Error:', error);
  };
}

// Helper to check for password field safely
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
    // If ANY frame says it's a password field, then it is.
    return results.some(r => r.result === true);
  } catch (e) {
    return false;
  }
}

// --- Dashboard Communication ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "dashboard") {
    dashboardPorts.add(port);

    port.onDisconnect.addListener(() => {
      dashboardPorts.delete(port);
    });

    port.onMessage.addListener((msg) => {
      try {
        if (msg.type === "GET_STATE") {
          broadcastState(); // Just broadcast to all, simpler
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
        if (msg.type === "SET_LOCAL_FILES") {
          allowLocalFiles = msg.value;
          api.storage.local.set({ allowLocalFiles: allowLocalFiles });
          broadcastState();
        }
        if (msg.type === "ADD_BLOCKLIST_ITEM") {
          // Ensure array
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
    panicMode: panicMode,
    allowLocalFiles: allowLocalFiles,
    userBlocklist: userBlocklist,
    rateLimitMs: rateLimitMs,
    logs: logHistory
  };
  for (const port of dashboardPorts) {
    port.postMessage({ type: "STATE_UPDATE", state: state });
  }
}

function broadcastLog(action, details) {
  const entry = {
    action,
    details,
    time: new Date().toISOString()
  };

  // Update History
  logHistory.unshift(entry);
  if (logHistory.length > 500) logHistory.pop();

  for (const port of dashboardPorts) {
    port.postMessage({ type: "LOG_ENTRY", ...entry });
  }
}

// --- Command Handler ---
async function handleCommand(command) {
  // 1. Rate Limiting
  const now = Date.now();
  if (now - lastCommandTime < rateLimitMs) {
    // Too fast!
    // Optional: We could just delay execution code here using await new Promise...
    // But purely dropping or erroring might be safer for "Bot" detection.
    // Let's delay it to be nice.
    await new Promise(r => setTimeout(r, rateLimitMs - (now - lastCommandTime)));
  }
  lastCommandTime = Date.now();

  // 2. Input Length Validation
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

  // 3. URL Validation (Navigate / Open Tab)
  if (command.action === 'navigate' || command.action === 'open_tab') {
    const check = checkUrlAllowed(command.url);
    if (!check.allowed) {
      throw new Error(`Navigation Blocked: ${check.reason}`);
    }
  }


  // Commands that don't need a tab content script
  if (command.action === "start_recording") {
    await startRecording(command);
    return;
  }
  if (command.action === "stop_recording") {
    await stopRecording(command);
    return;
  }

  // Open Tab (handled here so it works even if no tab is currently active)
  if (command.action === "open_tab") {
    try {
      const tab = await api.tabs.create({ url: command.url, active: true });

      // Wait for page load
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

  // Find active tab
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) {
    socket.send(JSON.stringify({ error: "No active tab" }));
    return;
  }
  const tabId = tabs[0].id;

  // Screenshot is special in background for full capture if desired, 
  // but let's stick to content script or captureVisibleTab here.
  if (command.action === "screenshot") {
    try {
      const dataUrl = await api.tabs.captureVisibleTab(null, { format: "png" });
      // Remove data:image/png;base64, prefix if you want raw, but usually keep it or just confirm.
      // Server expects base64.
      socket.send(JSON.stringify(dataUrl));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (command.action === "navigate") {
    try {
      await api.tabs.update(tabId, { url: command.url });

      // Wait for page load
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

      socket.send(JSON.stringify(`Navigated to ${command.url}`));
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
            // Attempt to evaluate. Note: Strict Page CSP may still block 'eval'.
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

  // Inject Console Hook (Lazy load or ensure it's there)
  // We'll try to inject it every time we get a log request or navigation, 
  // but let's do it on 'get_logs' to be safe, or maybe just rely on 'content.js' 
  // BUT the user wants it to work where content.js failed.
  // Let's force inject it if requested.

  if (command.action === "get_logs") {
    try {
      // First, ensure hook is there (idempotent-ish)
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

      // Then retrieve
      const results = await api.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: () => window.__mcp_logs || []
      });

      // Clear logs after reading? Maybe not, just return them.
      // Or we can clear them to mimic the stream.
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

  // --- Frame-Agnostic Handler for DOM Actions ---
  // 1. READ: Aggregate text from ALL frames
  if (command.action === "read") {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        func: () => document.body.innerText
      });
      // Combine all frames' text, filtering empty ones
      const fullText = results.map(r => r.result).filter(t => t && t.trim().length > 0).join("\n\n--- Frame ---\n\n");
      socket.send(JSON.stringify(fullText || "Page is empty"));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2. ELEMENT ACTIONS: Find which frame has the element, then target it.
  if (["click", "type", "highlight", "get_html", "wait_for"].includes(command.action)) {
    try {
      // Special case: wait_for doesn't need to find it *now*, it needs to wait.
      // We can broadcast wait_for to all frames, and whoever finds it first wins?
      // But broadcast via sendMessage resolves to the first response (usually Top Frame).
      // So for wait_for, we should probably let all frames run the check and race.
      // BUT standard sendMessage behavior is: callback invoked only once.

      // Strategy for Interactions (click/type/highlight/get_html):
      // Find the frame ID first.
      let targetFrameId = 0;

      if (command.selector) {
        const searchResults = await api.scripting.executeScript({
          target: { tabId: tabId, allFrames: true },
          func: (sel) => !!document.querySelector(sel),
          args: [command.selector]
        });
        const match = searchResults.find(r => r.result === true);
        if (match) {
          targetFrameId = match.frameId;
        } else if (command.action !== 'wait_for') {
          // If not waiting, and not found => Error
          socket.send(JSON.stringify({ error: `Element not found: ${command.selector}` }));
          return;
        }
      }

      // Send to specific frame (or 0 if not found/wait_for default)
      // For wait_for, we actually want to send to ALL frames and ignore failures?
      // No, simplest V1 IFrame fix: Just target the frame we found. 
      // If wait_for, we might need to poll via scripting. 
      // Let's stick to simple "Try found frame" for now.

      // Wait: wait_for needs to poll. The content script handles polling.
      // If we send to frame 0, and element is in frame 99, frame 0 waits and fails.
      // We need 'wait_for' to search all frames repeatedly.
      // Let's implement 'wait_for' using scripting here in background to save complexity?
      // Actually, let's keep it simple: If action is wait_for, we send to ALL frames?
      // Issue: Promise resolves on first response.

      // BETTER WAIT_FOR:
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

      // For Click/Type/GetHTML: We definitely found the frame above.
      const response = await api.tabs.sendMessage(tabId, command, { frameId: targetFrameId });
      socket.send(JSON.stringify(response || "Done"));

    } catch (err) {
      socket.send(JSON.stringify({ error: "Frame Error: " + err.message }));
    }
    return;
  }

  // 3. STORAGE: Read from Main World (Top Frame usually)
  if (command.action === "get_storage") {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: tabId }, // Default to top frame for storage
        world: 'MAIN',
        func: (type, key) => {
          try {
            const storage = (type === 'session') ? window.sessionStorage : window.localStorage;
            return storage.getItem(key);
          } catch (e) { return null; }
        },
        args: [command.storageType, command.key]
      });
      socket.send(JSON.stringify(results[0].result));
    } catch (err) {
      socket.send(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Fallback for other commands
  try {
    const response = await api.tabs.sendMessage(tabId, command);
    // If response is undefined, it might be that the listener didn't return anything
    // or the connection was closed.
    socket.send(JSON.stringify(response || "Done"));
  } catch (err) {
    // If content script isn't loaded (e.g. new tab or restricted page), try injecting?
    // For V1, just report error.
    socket.send(JSON.stringify({ error: "Content script error: " + err.message }));
  }
}

// --- Recording Logic (Offscreen) ---

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
    await createOffscreen();
    // Get the active tab ID to record
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) throw new Error("No active tab to record");

    // Get a stream ID (Chrome specific, for Firefox might need different path)
    const streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tabs[0].id });

    // Send to offscreen
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

  // Ask offscreen to stop
  api.runtime.sendMessage({
    type: 'STOP_RECORDING',
    target: 'offscreen'
  });
  // We wait for the offscreen to send the blob back via message, 
  // BUT we need to bridge it to the socket.

  // We'll set a one-time listener for the data
  const dataHandler = (message) => {
    if (message.type === 'RECORDING_DATA') {
      socket.send(message.data); // The big base64 string
      recordingState = false;
      api.runtime.onMessage.removeListener(dataHandler);
      // Close offscreen to save resources?
      api.offscreen.closeDocument();
    }
  };
  api.runtime.onMessage.addListener(dataHandler);
}

connect();
