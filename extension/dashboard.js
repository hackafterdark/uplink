// API Abstraction
const api = (typeof chrome !== "undefined") ? chrome : browser;

// Establish connection to background script updates
const port = api.runtime.connect({ name: "dashboard" });

port.onDisconnect.addListener(() => {
  if (api.runtime.lastError) {
    console.warn("Dashboard disconnected:", api.runtime.lastError.message);
  } else {
    console.warn("Dashboard disconnected");
  }
  statusEl.classList.remove('connected');
  statusText.innerText = "Suspended";
  addLog("SYSTEM", "Extension suspended. Settings will still save to storage.");

  // Try to reconnect after a short delay to wake up SW
  setTimeout(() => {
    window.location.reload();
  }, 2000);
});

const statusEl = document.getElementById('connectionStatus');
const statusText = document.getElementById('statusText');
const panicToggle = document.getElementById('panicToggle');
const localFileToggle = document.getElementById('localFileToggle');
const iframeToggle = document.getElementById('iframeToggle');
const logsContainer = document.getElementById('logs');
const blocklistInput = document.getElementById('blocklistInput');
const addBlockBtn = document.getElementById('addBlockBtn');
const blocklistEl = document.getElementById('blocklist');
const rateLimitInput = document.getElementById('rateLimitInput');
const portInput = document.getElementById('portInput');

// --- Helper: Format Time ---
function getTime() {
  const d = new Date();
  return d.toLocaleTimeString('en-US', { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// --- Helper: Render a single log entry ---
function renderLogEntry(action, details, time) {
  const div = document.createElement('div');
  div.className = 'log-entry';

  const d = new Date(time);
  const timeStr = d.toLocaleTimeString('en-US', { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  div.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-action">${action}</span> ${details || ''}`;
  return div;
}

// --- Helper: Appending Live Logs ---
function addLog(action, details) {
  // Clear "Waiting..." placeholder if present
  if (logsContainer.firstElementChild && logsContainer.firstElementChild.innerText.includes('Waiting')) {
    logsContainer.innerHTML = '';
  }
  const div = renderLogEntry(action, details, new Date().toISOString());
  logsContainer.prepend(div); // Newest on top

  // cleanup old logs
  if (logsContainer.children.length > 500) {
    logsContainer.lastElementChild.remove();
  }
}

// --- Render Blocklist ---
function renderBlocklist(list) {
  blocklistEl.innerHTML = '';
  list.forEach(item => {
    const li = document.createElement('li');
    li.style.cssText = "padding: 4px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #ccc;";

    const span = document.createElement('span');
    span.innerText = item;

    const delBtn = document.createElement('button');
    delBtn.innerText = "❌";
    delBtn.style.cssText = "background: none; border: none; cursor: pointer; font-size: 10px; color: #ff6b6b;";
    delBtn.onclick = () => {
      port.postMessage({ type: "REMOVE_BLOCKLIST_ITEM", value: item });
    };

    li.appendChild(span);
    li.appendChild(delBtn);
    blocklistEl.appendChild(li);
  });
}

// --- Sync State from Background ---
// 1. Initial Load from Storage (Robustness for Disconnected State)
api.storage.local.get(['rateLimitMs', 'serverPort', 'panicMode', 'allowLocalFiles', 'allowDataTools', 'userBlocklist', 'aiModelId', 'customHubUrl'], (res) => {
  if (res.rateLimitMs) rateLimitInput.value = res.rateLimitMs;
  if (res.serverPort) portInput.value = res.serverPort;
  if (res.panicMode !== undefined) panicToggle.checked = res.panicMode;
  if (res.allowLocalFiles !== undefined) localFileToggle.checked = res.allowLocalFiles;
  if (res.bypassIframeSecurity !== undefined) iframeToggle.checked = res.bypassIframeSecurity;
  if (res.allowDataTools !== undefined) dataToolsToggle.checked = res.allowDataTools;
  if (res.userBlocklist) {
    renderBlocklist(res.userBlocklist);
    document.getElementById('blocklistCount').innerText = res.userBlocklist.length;
  }

  // AI UI Init
  if (res.aiModelId) {
    const option = modelSelect.querySelector(`option[value="${res.aiModelId}"]`);
    if (option) {
      modelSelect.value = res.aiModelId;
      customModelIdInput.style.display = 'none';
    } else {
      modelSelect.value = 'custom';
      customModelIdInput.style.display = 'block';
      customModelIdInput.value = res.aiModelId;
    }
  }
  if (res.customHubUrl) customHubInput.value = res.customHubUrl;
});

// 2. Ask background for live state (in case of in-memory changes)
try { port.postMessage({ type: "GET_STATE" }); } catch (e) { }

// 3. Listen for updates
port.onMessage.addListener((msg) => {
  if (msg.type === "STATE_UPDATE") {
    // Update Connection Status
    if (msg.state.connected) {
      statusEl.classList.add('connected');
      statusText.innerText = "Connected";
    } else {
      statusEl.classList.remove('connected');
      statusText.innerText = "Disconnected";
    }

    // Update Panic Switch
    if (panicToggle.checked !== msg.state.panicMode) {
      panicToggle.checked = msg.state.panicMode;
    }

    // Update Local File Switch
    if (localFileToggle.checked !== msg.state.allowLocalFiles) {
      localFileToggle.checked = msg.state.allowLocalFiles;
    }

    // Update Iframe Toggle
    if (iframeToggle.checked !== msg.state.bypassIframeSecurity) {
      iframeToggle.checked = msg.state.bypassIframeSecurity;
    }

    // Update Data Tools Switch
    if (dataToolsToggle && msg.state.allowDataTools !== undefined) {
      if (dataToolsToggle.checked !== msg.state.allowDataTools) {
        dataToolsToggle.checked = msg.state.allowDataTools;
      }
    }

    // Update Blocklist UI
    const list = msg.state.userBlocklist || [];
    renderBlocklist(list);
    document.getElementById('blocklistCount').innerText = list.length;

    // Update Rate Limit
    if (document.activeElement !== rateLimitInput) {
      rateLimitInput.value = msg.state.rateLimitMs || 500;
    }

    // Update Port (Focus guarded)
    if (document.activeElement !== portInput && msg.state.serverPort) {
      portInput.value = msg.state.serverPort;
    }

    // Update Logs History
    if (msg.state.logs && msg.state.logs.length > 0) {
      logsContainer.innerHTML = '';
      msg.state.logs.forEach(entry => {
        const div = renderLogEntry(entry.action, entry.details, entry.time);
        logsContainer.appendChild(div); // History is Newest->Oldest
      });
    }

    // Update AI UI (Focus guarded)
    if (msg.state.aiModelId && document.activeElement !== modelSelect && document.activeElement !== customModelIdInput) {
      const option = modelSelect.querySelector(`option[value="${msg.state.aiModelId}"]`);
      if (option) {
        modelSelect.value = msg.state.aiModelId;
        customModelIdInput.style.display = 'none';
      } else {
        modelSelect.value = 'custom';
        customModelIdInput.style.display = 'block';
        customModelIdInput.value = msg.state.aiModelId;
      }
    }
  }

  if (msg.type === "LOG_ENTRY") {
    addLog(msg.action, msg.details);
  }
});

// --- User Interaction ---

// Panic Toggle
panicToggle.addEventListener('change', (e) => {
  const isPanic = e.target.checked;
  // Direct Save
  api.storage.local.set({ panicMode: isPanic });
  // Notify
  try { port.postMessage({ type: "SET_PANIC", value: isPanic }); } catch (e) { }

  if (isPanic) {
    addLog("SYSTEM", "⚠️ Panic Mode ENABLED. Commands blocked.");
  } else {
    addLog("SYSTEM", "✅ Panic Mode DISABLED. Resuming.");
  }
});

// Local File Toggle
localFileToggle.addEventListener('change', (e) => {
  const allowed = e.target.checked;
  api.storage.local.set({ allowLocalFiles: allowed });
  api.storage.local.set({ allowLocalFiles: allowed });
  try { port.postMessage({ type: "SET_LOCAL_FILES", value: allowed }); } catch (e) { }
});

// Iframe Security Toggle
iframeToggle.addEventListener('change', (e) => {
  const allowed = e.target.checked;
  api.storage.local.set({ bypassIframeSecurity: allowed });
  try { port.postMessage({ type: "SET_IFRAME_BYPASS", value: allowed }); } catch (e) { }
});

// Data Tools Toggle
const dataToolsToggle = document.getElementById('dataToolsToggle');
dataToolsToggle.addEventListener('change', (e) => {
  const allowed = e.target.checked;
  api.storage.local.set({ allowDataTools: allowed });
  try { port.postMessage({ type: "SET_ALLOW_DATA_TOOLS", value: allowed }); } catch (e) { }
});

// Blocklist Input Handler
function submitBlocklistItems(rawInput) {
  if (!rawInput) return;

  // Split by comma, newline, or space
  const items = rawInput.split(/[\s,]+/).filter(s => s.trim().length > 0);

  items.forEach(item => {
    try { port.postMessage({ type: "ADD_BLOCKLIST_ITEM", value: item.trim() }); } catch (e) { }
  });
  // Note: Blocklist management logic is complex (array push/remove), mostly handled by BG. 
  // We'll rely on BG or implement read-modify-write here if crucial. 
  // For now, let's assume BG handles blocklist logic best, or we'd duplicate logic.

  blocklistInput.value = '';
}

// Button Click
addBlockBtn.addEventListener('click', () => {
  submitBlocklistItems(blocklistInput.value);
});

// Enter Key
blocklistInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    submitBlocklistItems(blocklistInput.value);
  }
});

// Paste Handling (for comma-separated lists)
blocklistInput.addEventListener('paste', (e) => {
  e.preventDefault(); // Prevent default paste to handle it manually
  const text = (e.clipboardData || window.clipboardData).getData('text');
  submitBlocklistItems(text);
});

rateLimitInput.addEventListener('change', (e) => {
  let val = parseInt(e.target.value);
  if (val < 0) val = 0;
  api.storage.local.set({ rateLimitMs: val });
  try { port.postMessage({ type: "SET_RATE_LIMIT", value: val }); } catch (e) { }
});

if (portInput) {
  portInput.addEventListener('change', (e) => {
    let val = parseInt(e.target.value);
    if (val > 1024 && val < 65536) {
      // Direct Save! Crucial for fixing port when disconnected.
      api.storage.local.set({ serverPort: val });
      addLog("SYSTEM", `Port setting saved: ${val}. Reload ext to apply if suspended.`);

      try { port.postMessage({ type: "SET_PORT", value: val }); } catch (e) {
        console.log("Port updated in storage (offline mode)");
      }
    }
  });
}

// Connection Toggle (Clicking the Status Badge)
statusEl.addEventListener('click', () => {
  if (!statusEl.classList.contains('connected')) {
    // If suspended/disconnected, clicking should try to wake/reconnect
    // Since the port is dead, we can't message. We must reload the dashboard context
    // which triggers a new api.runtime.connect().
    addLog("SYSTEM", "Attempting manual reconnection...");
    setTimeout(() => window.location.reload(), 500);
  } else {
    // If connected, toggle the connection state via message
    port.postMessage({ type: "TOGGLE_CONNECTION" });
  }
});

// Download Logs
document.getElementById('downloadBtn').addEventListener('click', () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `uplink-logs-${timestamp}.json`;

  port.postMessage({ type: "GET_STATE" });

  const downloadListener = (msg) => {
    if (msg.type === "STATE_UPDATE" && msg.state.logs) {
      const blob = new Blob([JSON.stringify(msg.state.logs, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      port.onMessage.removeListener(downloadListener);
    }
  };
  port.onMessage.addListener(downloadListener);
});

// Update button visuals based on state
function updateConnectionButton(connected) {
  if (connected) {
    connectToggleBtn.innerText = "❌"; // Disconnect
    connectToggleBtn.title = "Disconnect from Server";
  } else {
    connectToggleBtn.innerText = "🔌"; // Connect
    connectToggleBtn.title = "Connect to Server";
  }
}

// --- AI Configuration UI ---
const modelSelect = document.getElementById('modelSelect');
const customModelIdInput = document.getElementById('customModelIdInput');
const customHubInput = document.getElementById('customHubInput');
const saveModelBtn = document.getElementById('saveModelBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');

// Toggle Custom Model ID Input
modelSelect.addEventListener('change', (e) => {
  if (e.target.value === 'custom') {
    customModelIdInput.style.display = 'block';
  } else {
    customModelIdInput.style.display = 'none';
    customModelIdInput.value = ''; // Reset custom input if preset selected
  }
});

saveModelBtn.addEventListener('click', () => {
  let modelId = modelSelect.value;
  if (modelId === 'custom') {
    modelId = customModelIdInput.value.trim();
    if (!modelId) {
      addLog("ERROR", "Please specify a Custom Model ID.");
      return;
    }
  }

  const hubUrl = customHubInput.value.trim() || null; // null resets to default

  addLog("SYSTEM", `Updating AI Config: ${modelId} ${hubUrl ? '(Custom Hub)' : ''}`);
  // Send command to background script
  // We send it as a "command" via socket usually, but here we can use the Port or direct messaging?
  // The background script listens to `port.onMessage` for SET_PANIC etc, but `set_model_config` is in `handleIncomingMessage` (from Socket).
  // Wait, the plan was to add `set_model_config` to `handleIncomingMessage`. 
  // The dashboard communicates via `port`. 
  // I need to add a handler for `SET_AI_CONFIG` in `background.js`'s port listener OR 
  // I should move the logic to `port.onMessage` listener in background.js.
  // Actually, background.js `handleIncomingMessage` is for WebSocket commands.
  // The Dashboard uses `chrome.runtime.connect` port.
  // I missed this distinction in the plan.
  // I should send a specialized port message, and the background script needs to listen for it.

  // Let's use a new port message type: SET_AI_CONFIG
  port.postMessage({
    type: "SET_AI_CONFIG",
    modelId: modelId,
    customHubUrl: hubUrl
  });
});

clearCacheBtn.addEventListener('click', () => {
  if (confirm("Are you sure? This will delete all downloaded AI models.")) {
    port.postMessage({ type: "CLEAR_AI_CACHE" });
  }
});
