// Establish connection to background script updates
const port = chrome.runtime.connect({ name: "dashboard" });

port.onDisconnect.addListener(() => {
  if (chrome.runtime.lastError) {
    console.warn("Dashboard disconnected:", chrome.runtime.lastError.message);
  } else {
    console.warn("Dashboard disconnected");
  }
  statusEl.classList.remove('connected');
  statusText.innerText = "Suspended";
  addLog("SYSTEM", "Extension suspended. Reconnecting...");

  // Try to reconnect after a short delay to wake up SW
  setTimeout(() => {
    window.location.reload();
  }, 1000);
});

const statusEl = document.getElementById('connectionStatus');
const statusText = document.getElementById('statusText');
const panicToggle = document.getElementById('panicToggle');
const localFileToggle = document.getElementById('localFileToggle');
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
// 1. Ask for initial state
port.postMessage({ type: "GET_STATE" });

// 2. Listen for updates
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

    // Update Logs History
    if (msg.state.logs && msg.state.logs.length > 0) {
      logsContainer.innerHTML = '';
      msg.state.logs.forEach(entry => {
        const div = renderLogEntry(entry.action, entry.details, entry.time);
        logsContainer.appendChild(div); // History is Newest->Oldest
      });
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
  port.postMessage({ type: "SET_PANIC", value: isPanic });

  if (isPanic) {
    addLog("SYSTEM", "⚠️ Panic Mode ENABLED. Commands blocked.");
  } else {
    addLog("SYSTEM", "✅ Panic Mode DISABLED. Resuming.");
  }
});

// Local File Toggle
localFileToggle.addEventListener('change', (e) => {
  const allowed = e.target.checked;
  port.postMessage({ type: "SET_LOCAL_FILES", value: allowed });
});

// Data Tools Toggle
const dataToolsToggle = document.getElementById('dataToolsToggle');
dataToolsToggle.addEventListener('change', (e) => {
  const allowed = e.target.checked;
  port.postMessage({ type: "SET_ALLOW_DATA_TOOLS", value: allowed });
});

// Blocklist Input Handler
function submitBlocklistItems(rawInput) {
  if (!rawInput) return;

  // Split by comma, newline, or space
  const items = rawInput.split(/[\s,]+/).filter(s => s.trim().length > 0);

  items.forEach(item => {
    port.postMessage({ type: "ADD_BLOCKLIST_ITEM", value: item.trim() });
  });

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
  port.postMessage({ type: "SET_RATE_LIMIT", value: val });
});

if (portInput) {
  portInput.addEventListener('change', (e) => {
    let val = parseInt(e.target.value);
    if (val > 1024 && val < 65536) {
      port.postMessage({ type: "SET_PORT", value: val });
    }
  });
}

// Connection Toggle (Clicking the Status Badge)
statusEl.addEventListener('click', () => {
  port.postMessage({ type: "TOGGLE_CONNECTION" });
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

// Hook into state updates
port.onMessage.addListener((msg) => {
  if (msg.type === "STATE_UPDATE") {
    // Other status updates handled above
    if (msg.state.rateLimitMs) {
      rateLimitInput.value = msg.state.rateLimitMs;
    }
    if (msg.state.serverPort && portInput) {
      portInput.value = msg.state.serverPort;
    }
  }
});
