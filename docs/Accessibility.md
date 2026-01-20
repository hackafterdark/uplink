# Accessibility Auditing

Uplink provides a built-in accessibility auditor that allows AI agents to evaluate a page's WCAG compliance using the industry-standard **axe-core** engine.

## What is it?
The Accessibility Auditor is a tool that scans the DOM for violations of the **Web Content Accessibility Guidelines (WCAG)**. Unlike visual observation, this tool analyzes the underlying programmatic structure to identify issues that affect screen readers, keyboard users, and users with low vision.

---

## Why use it?
AI agents often struggle to detect subtle accessibility barriers through raw text or screenshots alone. This tool provides:
1.  **Clinical Accuracy**: Rule-based detection of color contrast issues, missing labels, and broken ARIA structures.
2.  **Explicit Guidance**: Each violation includes a "Failure Summary" that explains exactly *what* is wrong and *how* to fix it.
3.  **Bridge to Action**: By mapping violations to Uplink's **Numeric IDs**, an agent can instantly pinpoint the problematic element and attempt to fix it or report it with high precision.

---

## How it Works

### 1. On-Demand Injection
To keep the extension lightweight, the `axe-core` library (`axe.min.js`) is **not** loaded by default. It is only injected into the active tab when the `audit_accessibility()` tool is first called.

### 2. Numeric ID Mapping
The auditor automatically cross-references axe-core's findings with Uplink's internal DOM map. If a violation occurs on an interactive element, the report will include the **Numeric ID** (e.g., `[ID: 42]`), allowing for immediate interaction.

### 3. Summarized Reporting
Axe-core often generates massive JSON reports. Uplink's internal implementation filters and transforms this data into a concise, token-efficient Markdown report categorized by impact:
- **Critical**: Must be fixed immediately.
- **Serious**: High priority.
- **Moderate/Minor**: Important for a polished experience.

---

## Usage Example

### Request
An AI agent encounters a complex form and wants to ensure it's accessible.
`await audit_accessibility()`

### Response
```markdown
### IMAGE-ALT (critical)
**Description**: Ensures <img> elements have alternate text
**Affected Elements:**
- [ID: 15] `<img src="/icons/save.png">`
  * Fix: Element does not have an alt attribute.

### COLOR-CONTRAST (serious)
**Description**: Ensures the contrast between foreground and background colors meets WCAG 2 AA
**Affected Elements:**
- [ID: 22] `<button class="btn-pale">Submit</button>`
  * Fix: Insufficient color contrast of 2.1:1. Expected 4.5:1.
```

## Maintenance
The auditor uses a static version of `axe.min.js` located in the `extension/` directory. This ensures the tool works offline and does not rely on third-party CDNs during execution, maintaining strict security and privacy.
