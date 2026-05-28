# Using the ITSM Workflow Intelligence Tool Locally

The tool is fully self-contained in a single HTML file. However, browsers apply security restrictions when opening HTML files directly from your desktop (`file://` protocol), which can prevent features like session save/restore, export and the accessibility panel from working correctly.

**There are three ways to use the tool — choose the one that suits you.**

---

## Option 1 — Use it online (recommended for most people)

Visit the tool directly in your browser. No installation needed. Your data never leaves your machine.

**[https://zeus-17.github.io/itsm-workflow-intelligence/](https://zeus-17.github.io/itsm-workflow-intelligence/)**

Works in Chrome, Edge, Firefox and Safari. Everything functions correctly over HTTPS.

---

## Option 2 — Install it as a desktop app (recommended for offline use)

The tool is a Progressive Web App (PWA). After visiting the URL above once, you can install it as a desktop application that works fully offline.

**In Chrome or Edge:**
1. Visit the URL above
2. Look for the install icon in the address bar
3. Click it and select **Install**
4. Find it in your Start Menu as **ITSM Tool**

**On mobile:** Visit in Safari (iOS) or Chrome (Android) → Share → Add to Home Screen.

---

## Option 3 — Run it locally with a simple web server

**Python:**
```bash
cd path/to/downloaded/files
python -m http.server 8080
```
Then open `http://localhost:8080/index.html`

**Node.js:**
```bash
npx serve .
```

Press `Ctrl+C` to stop.

---

## Why does this limitation exist?

Browsers treat files opened from disk (`file://`) as untrusted and block storage APIs, download features and some JavaScript. The same file works correctly when served over HTTP or HTTPS.
