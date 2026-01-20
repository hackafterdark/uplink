import { pipeline, env } from './transformers.js';

// Configure transformers.js for extension use
env.allowLocalModels = false;
env.useBrowserCache = true;
// MV3 Service Worker Fix: Disable worker spawning (requires blob:)
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;

// EXPLICITLY load WASM from CDN (since JS is now local, it might look locally)
env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.16.1/dist/';

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

// --- AI MODEL STATE ---
let embedder = null;
let modelLoading = false;
let aiModelId = 'Xenova/all-MiniLM-L6-v2'; // Default
let customHubUrl = null;

// --- DEBUG STATE ---
let lastError = null;
let debugLog = [];

function logDebug(msg) {
  const entry = new Date().toISOString() + " " + msg;
  debugLog.push(entry);
  if (debugLog.length > 50) debugLog.shift();
  console.log(msg);
  api.storage.local.set({ debugLog: debugLog, lastError: lastError });
}

// Helpers: Vector Math
function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(a) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}

function cosineSimilarity(a, b) {
  return dotProduct(a, b) / (magnitude(a) * magnitude(b));
}

// Helper: Load Model Singleton
async function loadModel() {
  // If model is already loaded and matches requested ID, return it
  if (embedder && embedder.modelId === aiModelId) return embedder;

  if (modelLoading) {
    // Wait for existing load
    while (modelLoading) await new Promise(r => setTimeout(r, 100));
    // Re-check if the loaded model is what we wanted (race condition handling)
    if (embedder && embedder.modelId === aiModelId) return embedder;
  }

  try {
    modelLoading = true;
    logDebug(`📥 Uplink Action: Loading Model "${aiModelId}"...`);
    broadcastLog("SYSTEM", `Loading Model "${aiModelId}"...`);

    // Dispose previous model if exists
    if (embedder) {
      logDebug("Disposing previous model...");
      // Transformers.js pipelines don't have a distinct 'dispose' method yet, 
      // but dereferencing allows GC to do its job. 
      // We can explicitly clear the cache if requested via clear_model_cache.
      embedder = null;
    }

    logDebug("SYSTEM: Starting pipeline()...");
    broadcastLog("SYSTEM", "Starting pipeline()...");

    // Explicitly disabling local files just in case
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // Custom Hub Configuration
    if (customHubUrl) {
      logDebug(`Using Custom Hub: ${customHubUrl}`);
      env.remoteHost = customHubUrl;
      env.remotePathTemplate = '{model}/'; // Simplified template
    } else {
      // Reset to defaults if no custom hub
      // Transformers.js defaults aren't easily "reset" without page reload 
      // if we polluted the env, so we set them back to standard HF.
      env.remoteHost = 'https://huggingface.co/';
      env.remotePathTemplate = '{model}/resolve/{revision}/';
    }

    embedder = await pipeline('feature-extraction', aiModelId);
    // Tag the embedder with the ID so we know what's loaded
    embedder.modelId = aiModelId;

    logDebug("✅ Uplink Action: AI Model Loaded");
    broadcastLog("SYSTEM", "✅ Uplink Action: AI Model Loaded");
    return embedder;
  } catch (e) {
    console.error("❌ Uplink Error: Failed to load model", e);
    logDebug("ERROR: Failed to load model: " + e.toString());
    broadcastLog("ERROR", "Failed to load model: " + e.toString());
    lastError = e.toString();
    throw e;
  } finally {
    modelLoading = false;
    logDebug("Finally block reached. Loading=false");
  }
}

// --- MESSAGE HANDLER (Content -> Background) ---
api.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'semantic_search') {
    (async () => {
      try {
        const pipe = await loadModel();
        console.log(`🔍 SemSearch: Query="${request.query}" Candidates=${request.candidates.length}`);

        // 1. Embed Query
        const queryEmbedding = await pipe(request.query, { pooling: 'mean', normalize: true });

        // 2. Embed Candidates (Batch Optimized)
        const texts = request.candidates.map(c => c.text);
        if (texts.length === 0) {
          console.log("⚠️ No candidates to embed.");
          sendResponse(null);
          return;
        }

        // 2. Embed Candidates (Concurrent Promise.all)
        // Map each text to a separate inference call
        // This avoids the risk of unknown batch return shapes from the pipeline for now
        const embeddingPromises = texts.map(text => pipe(text, { pooling: 'mean', normalize: true }));
        const embeddings = await Promise.all(embeddingPromises);

        // 3. Score
        const results = [];

        for (let i = 0; i < embeddings.length; i++) {
          const score = cosineSimilarity(queryEmbedding.data, embeddings[i].data);
          results.push({ ...request.candidates[i], score: score });
        }

        // 4. Sort & Log
        results.sort((a, b) => b.score - a.score);
        if (results.length > 0) {
          console.log(`🏆 Top Match: [${results[0].id}] "${results[0].text}" Score=${results[0].score}`);
        } else {
          console.log("⚠️ SemSearch: No valid candidates found.");
        }

        sendResponse(results.length > 0 ? results[0] : null);

      } catch (e) {
        console.error("Semantic Search Failed", e);
        sendResponse({ error: e.toString() });
      }
    })();
    return true; // Async response
  }
});

const MAX_TYPE_LENGTH = 10000;
const MAX_SCRIPT_LENGTH = 100000;

// Hardcoded Restricted Protocols (Always Blocked)
const RESTRICTED_PROTOCOLS = ['chrome:', 'edge:', 'about:', 'brave:', 'opera:'];

// Load saved security settings
// Load saved security settings and AI config
api.storage.local.get(['allowLocalFiles', 'allowDataTools', 'userBlocklist', 'panicMode', 'rateLimitMs', 'serverPort', 'aiModelId', 'customHubUrl'], (result) => {
  if (result.allowLocalFiles !== undefined) allowLocalFiles = result.allowLocalFiles;
  if (result.allowDataTools !== undefined) allowDataTools = result.allowDataTools;
  if (result.userBlocklist !== undefined) userBlocklist = result.userBlocklist;
  if (result.panicMode !== undefined) panicMode = result.panicMode;
  if (result.rateLimitMs !== undefined) rateLimitMs = result.rateLimitMs;
  if (result.serverPort !== undefined) serverPort = result.serverPort;
  if (result.aiModelId !== undefined) aiModelId = result.aiModelId;
  if (result.customHubUrl !== undefined) customHubUrl = result.customHubUrl;

  // Initial Connection (After settings load)
  connect();
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

api.runtime.onConnect.addListener((port) => {
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
        if (msg.type === "SET_AI_CONFIG") {
          if (msg.modelId) aiModelId = msg.modelId;
          customHubUrl = msg.customHubUrl;

          api.storage.local.set({ aiModelId: aiModelId, customHubUrl: customHubUrl });
          broadcastLog("SYSTEM", `AI Config Updated: ${aiModelId}`);

          // Reload model logic
          if (embedder) {
            broadcastLog("SYSTEM", "Reloading AI Model due to config change...");
            embedder = null;
            // Trigger load in background
            loadModel().catch(e => broadcastLog("ERROR", "Reload failed: " + e.message));
          }
          broadcastState();
        }
        if (msg.type === "CLEAR_AI_CACHE") {
          (async () => {
            try {
              if (self.caches) {
                const keys = await self.caches.keys();
                let count = 0;
                for (const key of keys) {
                  if (key.includes('transformers')) {
                    await self.caches.delete(key);
                    count++;
                  }
                }
                broadcastLog("SYSTEM", `Cache Cleared: Removed ${count} model caches.`);
              }
            } catch (e) {
              broadcastLog("ERROR", "Cache clear failed: " + e.message);
            }
          })();
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

  // --- DEBUG STATE ---
  let lastError = null;

  // ...

  if (command.action === "get_status") {
    api.storage.local.get(['debugLog', 'lastError'], (result) => {
      socket.send(JSON.stringify({
        status: "connected",
        model_loaded: !!embedder,
        model_loading: modelLoading,
        model_id: aiModelId,
        custom_hub: customHubUrl,
        last_error: lastError || result.lastError,
        debug_log: debugLog.length > 0 ? debugLog : (result.debugLog || [])
      }));
    });
    return;
  }

  if (command.action === "set_model_config") {
    if (command.model_id) aiModelId = command.model_id;
    if (command.custom_hub !== undefined) customHubUrl = command.custom_hub; // Allow null to reset

    api.storage.local.set({ aiModelId: aiModelId, customHubUrl: customHubUrl });

    // If a model is currently loaded, reload it with the new config
    if (embedder) {
      (async () => {
        try {
          socket.send(JSON.stringify(`Switching model to ${aiModelId}...`));
          embedder = null; // Invalidate current
          await loadModel();
          socket.send(JSON.stringify(`Model switched to ${aiModelId}`));
        } catch (e) {
          socket.send(JSON.stringify({ error: "Model switch failed: " + e.message }));
        }
      })();
    } else {
      socket.send(JSON.stringify(`Model config saved: ${aiModelId}`));
    }
    return;
  }

  if (command.action === "clear_model_cache") {
    (async () => {
      try {
        // Transformers.js uses the Cache API under 'transformers-cache'
        if (window.caches) {
          const keys = await window.caches.keys();
          for (const key of keys) {
            if (key.includes('transformers')) {
              await window.caches.delete(key);
              console.log("Deleted cache:", key);
            }
          }
          socket.send(JSON.stringify("Model cache cleared."));
        } else {
          socket.send(JSON.stringify("Cache API not available in this context."));
        }
      } catch (e) {
        socket.send(JSON.stringify({ error: "Failed to clear cache: " + e.message }));
      }
    })();
    return;
  }

  if (command.action === "preload_model") {
    (async () => {
      try {
        socket.send(JSON.stringify("Starting Model Preload..."));
        await loadModel();
        socket.send(JSON.stringify("Model Preload Complete!"));
      } catch (e) {
        socket.send(JSON.stringify("Model Preload Failed: " + e.message));
      }
    })();
    return;
  }

  if (["click", "type", "highlight", "get_html", "wait_for", "press_key", "semantic_find"].includes(command.action)) {
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

// Removed synchronous connect() to prevent race condition.
// Connection is now triggered inside the storage callback.
