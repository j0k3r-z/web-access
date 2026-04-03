// CDP Bridge Extension - Service Worker
// Connects to cdp-proxy via WebSocket, executes CDP commands via chrome.debugger

const PROXY_WS = 'ws://127.0.0.1:3456/extension';
const HEARTBEAT_INTERVAL = 20000;
const RECONNECT_DELAY = 3000;

let ws = null;
let heartbeatTimer = null;
const targetToTab = new Map();
const tabToTarget = new Map();
const attachedTabs = new Set();

// --- WebSocket Client ---

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(PROXY_WS);
  } catch {
    setTimeout(connect, RECONNECT_DELAY);
    return;
  }

  ws.onopen = () => {
    console.log('[CDP Bridge] Connected to proxy');
    startHeartbeat();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'pong') return;

    try {
      const result = await handleCommand(msg);
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, error: err.message }));
    }
  };

  ws.onclose = () => {
    console.log('[CDP Bridge] Disconnected from proxy');
    ws = null;
    stopHeartbeat();
    setTimeout(connect, RECONNECT_DELAY);
  };

  ws.onerror = () => {};
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// --- ID Mapping (targetId <-> tabId) ---

async function refreshMapping() {
  const targets = await chrome.debugger.getTargets();
  targetToTab.clear();
  tabToTarget.clear();
  for (const t of targets) {
    if (t.type === 'page' && t.tabId) {
      targetToTab.set(t.id, t.tabId);
      tabToTarget.set(t.tabId, t.id);
    }
  }
}

async function getTabId(targetId) {
  if (targetToTab.has(targetId)) return targetToTab.get(targetId);
  await refreshMapping();
  if (targetToTab.has(targetId)) return targetToTab.get(targetId);
  throw new Error('Target not found: ' + targetId);
}

async function getTargetId(tabId) {
  if (tabToTarget.has(tabId)) return tabToTarget.get(tabId);
  await refreshMapping();
  if (tabToTarget.has(tabId)) return tabToTarget.get(tabId);
  throw new Error('No target for tab: ' + tabId);
}

// --- Debugger Management ---

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabs.add(tabId);
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

// --- Helpers ---

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, timeoutMs);
  });
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); clearInterval(c); resolve(r); } };
    const t = setTimeout(() => finish('timeout'), timeoutMs);
    const c = setInterval(async () => {
      try {
        const r = await cdp(tabId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (r?.result?.value === 'complete') finish('complete');
      } catch { /* ignore */ }
    }, 500);
  });
}

// --- Command Router ---

async function handleCommand(msg) {
  switch (msg.action) {
    case 'targets': return await handleTargets();
    case 'new': return await handleNew(msg);
    case 'close': return await handleClose(msg);
    case 'navigate': return await handleNavigate(msg);
    case 'back': return await handleBack(msg);
    case 'cdp': return await handleCdp(msg);
    case 'clickAt': return await handleClickAt(msg);
    case 'setFiles': return await handleSetFiles(msg);
    default: throw new Error('Unknown action: ' + msg.action);
  }
}

// --- Action Handlers ---

async function handleTargets() {
  await refreshMapping();
  const targets = await chrome.debugger.getTargets();
  return targets
    .filter(t => t.type === 'page')
    .map(t => ({ targetId: t.id, type: t.type, title: t.title, url: t.url }));
}

async function handleNew(msg) {
  const url = msg.url || 'about:blank';
  const tab = await chrome.tabs.create({ url, active: false });
  if (url !== 'about:blank') {
    await waitForTabLoad(tab.id);
  }
  await ensureAttached(tab.id);
  const targetId = await getTargetId(tab.id);
  return { targetId };
}

async function handleClose(msg) {
  const tabId = await getTabId(msg.targetId);
  if (attachedTabs.has(tabId)) {
    try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
    attachedTabs.delete(tabId);
  }
  await chrome.tabs.remove(tabId);
  targetToTab.delete(msg.targetId);
  tabToTarget.delete(tabId);
  return { success: true };
}

async function handleNavigate(msg) {
  const tabId = await getTabId(msg.targetId);
  const result = await cdp(tabId, 'Page.navigate', { url: msg.url });
  await waitForLoad(tabId);
  return result;
}

async function handleBack(msg) {
  const tabId = await getTabId(msg.targetId);
  await cdp(tabId, 'Runtime.evaluate', { expression: 'history.back()' });
  await waitForLoad(tabId);
  return { ok: true };
}

async function handleCdp(msg) {
  const tabId = await getTabId(msg.targetId);
  return await cdp(tabId, msg.method, msg.params || {});
}

async function handleClickAt(msg) {
  const tabId = await getTabId(msg.targetId);
  const selectorJson = JSON.stringify(msg.selector);
  const js = `(() => {
    const el = document.querySelector(${selectorJson});
    if (!el) return { error: 'Element not found: ' + ${selectorJson} };
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
  })()`;
  const coordResult = await cdp(tabId, 'Runtime.evaluate', {
    expression: js, returnByValue: true, awaitPromise: true,
  });
  const coord = coordResult?.result?.value;
  if (!coord || coord.error) return coord || coordResult;
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1,
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1,
  });
  return { clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text };
}

async function handleSetFiles(msg) {
  const tabId = await getTabId(msg.targetId);
  await cdp(tabId, 'DOM.enable', {});
  const doc = await cdp(tabId, 'DOM.getDocument', {});
  const node = await cdp(tabId, 'DOM.querySelector', {
    nodeId: doc.root.nodeId, selector: msg.selector,
  });
  if (!node?.nodeId) throw new Error('Element not found: ' + msg.selector);
  await cdp(tabId, 'DOM.setFileInputFiles', {
    nodeId: node.nodeId, files: msg.files,
  });
  return { success: true, files: msg.files.length };
}

// --- Event Listeners ---

chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
  console.log(`[CDP Bridge] Detached from tab ${source.tabId}: ${reason}`);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  const targetId = tabToTarget.get(tabId);
  if (targetId) {
    targetToTab.delete(targetId);
    tabToTarget.delete(tabId);
  }
});

// --- Start ---
connect();
