// background.js
//
// Thin message relay between the DevTools panel (one open per inspected tab)
// and this extension's content-script instances (one per frame of that tab,
// since content.js is injected with all_frames: true). Holds no WebMCP logic
// of its own -- it only routes structured-clone-safe plain-object messages,
// keyed by tabId and, for tool execution, frameId.
//
// Deliberately uses long-lived chrome.runtime.connect() Ports rather than
// chrome.tabs.sendMessage(): a Port's `sender.tab.id` / `sender.frameId` are
// populated for free for any connection coming from a content script, so
// this file never needs the "tabs" permission just to find out which tab/
// frame a message came from or to route a reply back to it.

const contentPortsByTab = new Map(); // tabId -> Map<frameId, Port>
const panelPortsByTab = new Map(); // tabId -> Set<Port>

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'webmcp-content') {
    handleContentConnect(port);
  } else if (port.name === 'webmcp-panel') {
    handlePanelConnect(port);
  }
});

function handleContentConnect(port) {
  const tab = port.sender && port.sender.tab;
  if (!tab || typeof tab.id !== 'number') return; // not a real tab context; ignore

  const tabId = tab.id;
  const frameId = typeof port.sender.frameId === 'number' ? port.sender.frameId : 0;

  if (!contentPortsByTab.has(tabId)) contentPortsByTab.set(tabId, new Map());
  contentPortsByTab.get(tabId).set(frameId, port);

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    forwardToPanels(tabId, { ...msg, frameId });
  });

  port.onDisconnect.addListener(() => {
    const frames = contentPortsByTab.get(tabId);
    if (!frames) return;
    frames.delete(frameId);
    if (frames.size === 0) contentPortsByTab.delete(tabId);
  });
}

function handlePanelConnect(port) {
  let boundTabId = null;

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'init' && typeof msg.tabId === 'number') {
      boundTabId = msg.tabId;
      if (!panelPortsByTab.has(boundTabId)) panelPortsByTab.set(boundTabId, new Set());
      panelPortsByTab.get(boundTabId).add(port);
      return;
    }

    if (boundTabId === null) return; // panel must send `init` before anything else
    forwardToContent(boundTabId, msg);
  });

  port.onDisconnect.addListener(() => {
    if (boundTabId === null) return;
    const panels = panelPortsByTab.get(boundTabId);
    if (!panels) return;
    panels.delete(port);
    if (panels.size === 0) panelPortsByTab.delete(boundTabId);
  });
}

function forwardToPanels(tabId, msg) {
  const panels = panelPortsByTab.get(tabId);
  if (!panels) return;
  for (const panelPort of panels) {
    try {
      panelPort.postMessage(msg);
    } catch (err) {
      // stale port that hasn't fired onDisconnect yet; nothing to do
    }
  }
}

function forwardToContent(tabId, msg) {
  const frames = contentPortsByTab.get(tabId);
  if (!frames) return;

  if (typeof msg.frameId === 'number') {
    const target = frames.get(msg.frameId);
    if (!target) return;
    try {
      target.postMessage(msg);
    } catch (err) {
      // stale port; nothing to do
    }
    return;
  }

  // No frameId given (e.g. a broadcast "getTools" refresh) -> fan out to every frame.
  for (const contentPort of frames.values()) {
    try {
      contentPort.postMessage(msg);
    } catch (err) {
      // stale port; nothing to do
    }
  }
}
