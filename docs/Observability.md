# Observability & Diagnostics

Uplink includes a robust suite of observability tools designed to help AI agents diagnose failures, measure performance, and understand browser state objectively.

## 1. Error Intelligence
Uplink uses **Semantic Clustering** to group errors and reduce noise, preventing the AI agent from being overwhelmed by repetitive logs.

### Key Tools
- `check_errors()`: Returns a semantically clustered summary of console errors, warnings, and network failures.
- `get_console_logs()`: Retrieves raw browser logs (useful for debugging specific stack traces).

### Intelligence Pipeline
1.  **Smart Capture**: An injected spy script hooks `console.error`, `window.onerror`, and `window.fetch`.
2.  **Heuristic Cleaning**: Stack traces are truncated to the top 5 frames to minimize token usage.
3.  **Exact Deduplication**: Identical sequential errors are collapsed into a single entry with an occurrence count.
4.  **Semantic Clustering**: Similar error messages (e.g., "Network Error 404" and "Network Error 500") are grouped using local AI embeddings to provide a high-level overview.

---

## 2. Performance Monitoring (RUM Lite)
Objective metrics help distinguish between server bottlenecks, frontend rendering issues, and script execution delays.

### Tool: `get_page_performance()`
Provides a holistic report of the current page's speed and responsiveness.

### Metrics Captured
- **TTFB (Time To First Byte)**: Measures backend/server latency.
- **FCP (First Contentful Paint)**: Measures the time until the first visual content appears.
- **Page Load & DOM Processing**: Basic navigation timings.
- **Top Slow Resources**: Lists the top 5 network requests taking >500ms.
- **Long Tasks**: Counts main-thread freezes (>50ms) in the last 10 seconds, providing a proxy for responsiveness (INP).

---

## 3. Interaction Instrumentation
All interaction tools are instrumented to return their execution duration in the response string. This helps identify if a specific AI action caused a page freeze.

- **Click**: `await click_element("button")` → `"Clicked (Internal: 45ms)"`
- **Type**: `await type_text("#input", "hello")` → `"Typed (12ms)"`
- **Wait**: `await wait_for_element(".ready")` → `"Found element (waited 2400ms)"`

---

## 4. Session Management
The `manage_session` tool allows for clean-slate testing and privacy-preserving log management.

- `manage_session(action="clear")`: **The "Nuke" Button**. Clears all Cookies, LocalStorage, SessionStorage, and error logs.
- `manage_session(action="clear_logs")`: Clears only the buffered error history.

---

## 5. Usage for AI Agents
When an action fails or the browser feels "stuck," agents should follow this diagnostic flow:
1.  Run `check_errors()` to see if there are underlying JS/Network failures.
2.  Run `get_page_performance()` to check if the page is still loading or the main thread is blocked by long tasks.
3.  Use `manage_session("clear")` if the page state has become corrupted or needs a fresh login.
