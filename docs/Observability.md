# Observability & Diagnostics

Uplink includes a robust suite of observability tools designed to help AI agents diagnose failures, measure performance, and understand browser state objectively.

## 1. Accessibility Audit (Axe-Core)
Empowers the AI to evaluate the page's WCAG compliance using the industry-standard `axe-core` library.

### Tool: `audit_accessibility()`
Performs an on-demand accessibility scan of the active page.
- **Engine**: `axe-core` (injected only when called).
- **Report**: Returns a summarized markdown list of violations (Critical, Serious, Moderate).
- **Integration**: Maps violations back to Uplink's **Numeric IDs** where possible, allowing agents to inspect or fix specific elements.

**Example Report:**
```markdown
### IMAGE-ALT (critical)
**Description**: Ensures <img> elements have alternate text
**Affected Elements:**
- [ID: 42] `<img src="hero.jpg">`
  * Fix: Element does not have an alt attribute
```

---

## 2. Error Intelligence
Uplink uses **Semantic Clustering** to group errors and reduce noise.

### Key Tools
- `check_errors()`: Returns a semantically clustered summary of console errors, warnings, and network failures.
- `get_console_logs()`: Retrieves raw browser logs.

### Intelligence Pipeline
1.  **Smart Capture**: Hooks `console.error`, `window.onerror`, and `window.fetch`.
2.  **Heuristic Cleaning**: Truncates stack traces.
3.  **Exact Deduplication**: Collapses identical errors.
4.  **Semantic Clustering**: Groups similar messages (e.g., 404s) using local embeddings.

---

## 3. Performance Monitoring (RUM Lite)
Objective metrics help distinguish between server bottlenecks and frontend delays.

### Tool: `get_page_performance()`
Provides a holistic report:
- **TTFB & Page Load**: Server/Network latency.
- **FCP (First Contentful Paint)**: Visual rendering speed.
- **Top Slow Resources**: Network requests >500ms.
- **Long Tasks**: Main-thread freezes (INP proxy).

---

## 4. Interaction Instrumentation
All interaction tools report their internal execution duration to help diagnose UI freezes.
- `click_element` → `"Clicked (Internal: 45ms)"`
- `wait_for_element` → `"Found element (waited 2400ms)"`

---

## 5. Session Management
- `manage_session(action="clear")`: Clears Cookies, LocalStorage, and logs.
