'use strict';

// Twitch's markup changes periodically. Prefer known conversation-window roots;
// use fallback selectors only when neither canonical root is present.
const DOM_SELECTORS = Object.freeze({
  primaryThread: [
    '.whispers-thread',
    '.whispers__thread-window'
  ],
  fallbackThread: [
    '[data-a-target="whisper-thread"]',
    '[data-test-selector="thread__wrapper"]',
    '[data-test-selector="whisper-thread"]',
    '[data-test-selector*="whisper-thread"]'
  ],
  header: [
    '[data-a-target="whisper-thread-header"]',
    '.thread-header__title-bar-container',
    '.thread-header',
    '[data-test-selector*="thread-header"]',
    '[class*="thread-header"]'
  ],
  title: [
    '.thread-header__title',
    '[data-test-selector="thread-header__username"]',
    '[data-a-target="whisper-thread-header"]'
  ],
  excludedAncestors: [
    '.whispers-list-item',
    '[data-test-selector*="notification"]',
    '[data-a-target="whisper-notification"]',
    '[role="alert"]',
    '.toast'
  ],
  composerCandidates: 'textarea, input, [contenteditable="true"], [role="textbox"], [data-a-target*="message-input"]',
  messageList: [
    '[data-test-selector*="message-list"]',
    '[data-a-target*="message-list"]',
    '.thread-messages',
    '.thread-message-list',
    '[role="log"]'
  ]
});

const STORAGE_KEYS = Object.freeze({
  settings: 'twrSettings',
  sizes: 'twrSizes',
  debugEnabled: 'twrDebugEnabled'
});
const DEBUG_LOG_PREFIX = 'twrDebugLog_';
const DEFAULT_SETTINGS = Object.freeze({
  minWidth: 200,
  minHeight: 150,
  maxWidth: 1600,
  maxHeight: 1200,
  handleColor: '#9146ff',
  handleSize: 24
});
const DIMENSION_PROPERTIES = [
  'width', 'min-width', 'max-width',
  'height', 'min-height', 'max-height'
];
const MANAGED_PROPERTIES = DIMENSION_PROPERTIES.concat('position', 'left', 'top');
const PRIMARY_THREAD_SELECTOR = DOM_SELECTORS.primaryThread.join(',');
const FALLBACK_THREAD_SELECTOR = DOM_SELECTORS.fallbackThread.join(',');
const EXCLUDED_SELECTOR = DOM_SELECTORS.excludedAncestors.join(',');
const SESSION_ID = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
const SESSION_LOG_KEY = DEBUG_LOG_PREFIX + SESSION_ID;
const SESSION_STARTED_AT = new Date().toISOString();

let settings = { ...DEFAULT_SETTINGS };
let savedSizes = {};
let debugEnabled = false;
let debugEntries = [];
let debugPersistTimer = null;
let lastScanSignature = '';
const candidateSignatures = new WeakMap();
const records = new Map();
let activeThread = null;
let dragState = null;
let initialized = false;

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeSettings(candidate) {
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const result = { ...DEFAULT_SETTINGS };
  ['minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'handleSize'].forEach((key) => {
    const value = Number(input[key]);
    if (Number.isFinite(value)) result[key] = Math.round(value);
  });
  result.minWidth = clampNumber(result.minWidth, 100, 2400, DEFAULT_SETTINGS.minWidth);
  result.minHeight = clampNumber(result.minHeight, 100, 2000, DEFAULT_SETTINGS.minHeight);
  result.maxWidth = clampNumber(result.maxWidth, result.minWidth, 3000, DEFAULT_SETTINGS.maxWidth);
  result.maxHeight = clampNumber(result.maxHeight, result.minHeight, 2400, DEFAULT_SETTINGS.maxHeight);
  result.handleSize = clampNumber(result.handleSize, 12, 48, DEFAULT_SETTINGS.handleSize);
  result.handleColor = typeof input.handleColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.handleColor)
    ? input.handleColor
    : DEFAULT_SETTINGS.handleColor;
  return result;
}

function debugLog(eventName, details = {}) {
  if (!debugEnabled) return;
  debugEntries.push({
    time: new Date().toISOString(),
    event: eventName,
    details
  });
  if (debugEntries.length > 300) debugEntries = debugEntries.slice(-300);
  scheduleDebugPersist();
}

function scheduleDebugPersist() {
  if (!debugEnabled && debugEntries.length === 0) return;
  if (debugPersistTimer) clearTimeout(debugPersistTimer);
  debugPersistTimer = setTimeout(() => {
    debugPersistTimer = null;
    const payload = {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      startedAt: SESSION_STARTED_AT,
      updatedAt: new Date().toISOString(),
      page: window.location.origin + window.location.pathname,
      entries: debugEntries.slice()
    };
    try {
      chrome.storage.local.set({ [SESSION_LOG_KEY]: payload }).catch(() => {});
    } catch {
      // Diagnostics must never interrupt resizing.
    }
  }, 300);
}

function isVisible(element) {
  if (!element || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    Number(style.opacity || 1) !== 0;
}

function queryElementMatches(root, selectors) {
  const result = [];
  for (const selector of selectors) {
    try {
      if (root.matches && root.matches(selector)) result.push(root);
      root.querySelectorAll(selector).forEach((element) => result.push(element));
    } catch {
      // Invalid/unsupported selectors are ignored so a Twitch DOM change is non-fatal.
    }
  }
  return Array.from(new Set(result));
}

function firstVisibleMatch(root, selectors) {
  return queryElementMatches(root, selectors).find(isVisible) || null;
}

function getThreadCandidates() {
  let matches = queryElementMatches(document, DOM_SELECTORS.primaryThread);
  // The original bug was selecting the deepest matching descendant. On Twitch,
  // that can be an inner wrapper which does not contain its header or composer.
  // Keep the outermost conversation window so all of its controls can be found.
  if (!matches.length) matches = queryElementMatches(document, DOM_SELECTORS.fallbackThread);
  return matches.filter((element) =>
    !matches.some((other) => other !== element && other.contains(element))
  );
}

function isExcludedThread(thread) {
  try {
    return Boolean(thread.closest(EXCLUDED_SELECTOR));
  } catch {
    return false;
  }
}

function findHeader(thread) {
  const match = firstVisibleMatch(thread, DOM_SELECTORS.header);
  if (match) return match;

  // Fallback for an updated Twitch class name: a profile link in the top strip
  // of a conversation often survives class-name changes.
  const threadRect = thread.getBoundingClientRect();
  const links = Array.from(thread.querySelectorAll('a[href]'));
  for (const link of links) {
    let pathname = '';
    try { pathname = new URL(link.getAttribute('href'), location.origin).pathname; } catch {}
    if (!/^\/[a-zA-Z0-9_]{1,25}\/?$/.test(pathname) || !isVisible(link)) continue;
    const linkRect = link.getBoundingClientRect();
    if (linkRect.top > threadRect.top + 120) continue;
    return link.closest('header, [class*="header"], [data-a-target*="header"]') || link.parentElement;
  }
  return null;
}

function isComposerControl(element) {
  if (!element || !isVisible(element) || element.disabled) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    return !['hidden', 'search', 'button', 'submit', 'checkbox', 'radio', 'file'].includes(
      String(element.type || 'text').toLowerCase()
    );
  }
  if (element.isContentEditable || element.getAttribute('role') === 'textbox') return true;
  return (element.getAttribute('data-a-target') || '').toLowerCase().includes('message-input');
}

function findComposer(thread) {
  return queryElementMatches(thread, [DOM_SELECTORS.composerCandidates])
    .find(isComposerControl) || null;
}

function inspectThread(thread) {
  const rect = thread.getBoundingClientRect();
  const header = findHeader(thread);
  const composer = findComposer(thread);
  const excluded = isExcludedThread(thread);
  const sizeOkay = rect.width >= 120 && rect.height >= 90;
  let reason = 'ready';

  if (excluded) reason = 'excluded-notification-or-list-item';
  else if (!isVisible(thread)) reason = 'thread-not-visible';
  else if (!header) reason = 'header-not-found';
  else if (!composer) reason = 'composer-not-found';
  else if (!sizeOkay) reason = 'window-too-small';

  return {
    open: reason === 'ready',
    reason,
    header,
    composer,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    sizeOkay,
    excluded
  };
}

function getUserKey(thread, header) {
  const searchRoot = header || thread;
  const links = Array.from(searchRoot.querySelectorAll('a[href]'));
  for (const anchor of links) {
    try {
      const pathname = new URL(anchor.getAttribute('href'), window.location.origin).pathname;
      const match = pathname.match(/^\/([a-zA-Z0-9_]{1,25})\/?$/);
      const reserved = new Set([
        'directory', 'downloads', 'jobs', 'login', 'p', 'products',
        'search', 'settings', 'signup', 'subscriptions', 'turbo'
      ]);
      if (match && !reserved.has(match[1].toLowerCase())) return match[1].toLowerCase();
    } catch {}
  }

  const title = firstVisibleMatch(searchRoot, DOM_SELECTORS.title) || header;
  const text = ((title && (title.innerText || title.textContent)) || '')
    .replace(/[×✕✖]/g, ' ')
    .replace(/\b(close|minimize|maximize|whisper|conversation)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text && text.length <= 80) return text.toLowerCase();
  return null;
}

function getSelectorCounts() {
  const counts = {};
  for (const selector of [
    ...DOM_SELECTORS.primaryThread,
    ...DOM_SELECTORS.fallbackThread,
    ...DOM_SELECTORS.header,
    ...DOM_SELECTORS.messageList,
    'textarea',
    'input',
    '[contenteditable="true"]',
    '[role="textbox"]'
  ]) {
    try { counts[selector] = document.querySelectorAll(selector).length; }
    catch { counts[selector] = -1; }
  }
  return counts;
}

function describeElement(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || '',
    className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
    dataATarget: element.getAttribute('data-a-target') || '',
    dataTestSelector: element.getAttribute('data-test-selector') || '',
    visible: isVisible(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}

function getNearbyElements() {
  const selector = '[class*="whisper" i], [data-a-target*="whisper" i], [data-test-selector*="thread" i]';
  try {
    return Array.from(document.querySelectorAll(selector))
      .filter((element) => !element.classList.contains('twr-handle'))
      .slice(0, 30)
      .map(describeElement);
  } catch {
    return [];
  }
}

function recordDetectionDiagnostics(candidates) {
  if (!debugEnabled) return;
  const descriptions = candidates.map((thread) => {
    const result = inspectThread(thread);
    const item = {
      element: describeElement(thread),
      matchedSelectors: DOM_SELECTORS.primaryThread.concat(DOM_SELECTORS.fallbackThread)
        .filter((selector) => {
          try { return thread.matches(selector); } catch { return false; }
        }),
      open: result.open,
      reason: result.reason,
      header: describeElement(result.header),
      composer: describeElement(result.composer),
      hasRecipientKey: Boolean(getUserKey(thread, result.header))
    };
    const signature = JSON.stringify(item);
    if (candidateSignatures.get(thread) !== signature) {
      candidateSignatures.set(thread, signature);
      debugLog('thread-detection', item);
    }
    return {
      tag: item.element.tag,
      className: item.element.className,
      open: item.open,
      reason: item.reason,
      rect: item.element.rect
    };
  });

  const snapshot = {
    candidateCount: candidates.length,
    selectorCounts: getSelectorCounts(),
    candidates: descriptions,
    nearbyElements: candidates.length ? [] : getNearbyElements()
  };
  const signature = JSON.stringify(snapshot);
  if (signature !== lastScanSignature) {
    lastScanSignature = signature;
    debugLog('dom-scan', snapshot);
  }
}

function rememberInlineStyles(thread) {
  const saved = {};
  MANAGED_PROPERTIES.forEach((property) => {
    saved[property] = {
      value: thread.style.getPropertyValue(property),
      priority: thread.style.getPropertyPriority(property)
    };
  });
  return saved;
}

function restoreProperties(thread, saved, properties) {
  properties.forEach((property) => {
    const original = saved[property];
    if (!original || !original.value) thread.style.removeProperty(property);
    else thread.style.setProperty(property, original.value, original.priority);
  });
}

function restoreBaseDimensions(record) {
  restoreProperties(record.thread, record.originalStyles, DIMENSION_PROPERTIES);
}

function applyPositioningFallback(thread) {
  if (window.getComputedStyle(thread).position === 'static') {
    thread.style.setProperty('position', 'relative', 'important');
  }
}

function updateHandleAppearance(handle) {
  if (!handle) return;
  handle.style.setProperty('--twr-handle-color', settings.handleColor);
  handle.style.setProperty('--twr-handle-size', settings.handleSize + 'px');
}

function createHandle(record) {
  const handle = document.createElement('div');
  handle.className = 'twr-handle';
  handle.title = 'Потяни для изменения размера';
  handle.setAttribute('role', 'button');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('aria-label', 'Изменить размер окна переписки');
  handle.setAttribute('aria-keyshortcuts', 'Ctrl+Shift+ArrowLeft Ctrl+Shift+ArrowRight Ctrl+Shift+ArrowUp Ctrl+Shift+ArrowDown');
  handle.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
    '<path d="M1 11L11 1M1 6.5L6.5 1M5.5 11L11 5.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/>' +
    '</svg>';

  updateHandleAppearance(handle);
  // Keep the grip outside the Twitch window so it cannot overlap the username
  // or badges and cannot be clipped by the dialog's overflow settings.
  document.body.appendChild(handle);
  record.handle = handle;
  handle.addEventListener('pointerdown', (event) => startDrag(event, record));
  handle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    activeThread = record.thread;
  });
  handle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activeThread = record.thread;
    }
  });
}

function positionHandle(record) {
  const handle = record && record.handle;
  const thread = record && record.thread;
  if (!handle || !handle.isConnected || !thread || !thread.isConnected) return;

  const rect = thread.getBoundingClientRect();
  const size = settings.handleSize;
  // Match the original layout: entirely outside, left of the upper-left corner.
  handle.style.left = Math.round(rect.left - size - 4) + 'px';
  handle.style.top = Math.round(rect.top + 2) + 'px';
}

function positionAllHandles() {
  for (const record of records.values()) positionHandle(record);
}

function getLimits() {
  const maxWidth = Math.max(1, Math.min(settings.maxWidth, Math.floor(window.innerWidth * 0.8)));
  const maxHeight = Math.max(1, Math.min(settings.maxHeight, Math.floor(window.innerHeight * 0.9)));
  const minWidth = Math.min(settings.minWidth, maxWidth);
  const minHeight = Math.min(settings.minHeight, maxHeight);
  return { minWidth, minHeight, maxWidth, maxHeight };
}

function clampSize(width, height) {
  const limits = getLimits();
  return {
    w: Math.round(clampNumber(Number(width), limits.minWidth, limits.maxWidth, limits.minWidth)),
    h: Math.round(clampNumber(Number(height), limits.minHeight, limits.maxHeight, limits.minHeight))
  };
}

function applyThreadSize(record, proposedSize) {
  const size = clampSize(proposedSize.w, proposedSize.h);
  const thread = record.thread;
  thread.style.setProperty('width', size.w + 'px', 'important');
  thread.style.setProperty('min-width', size.w + 'px', 'important');
  thread.style.setProperty('max-width', size.w + 'px', 'important');
  thread.style.setProperty('height', size.h + 'px', 'important');
  thread.style.setProperty('min-height', size.h + 'px', 'important');
  thread.style.setProperty('max-height', size.h + 'px', 'important');
  return size;
}

function getCurrentSize(thread) {
  const rect = thread.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

function persistSize(userKey, size) {
  if (!userKey) return;
  savedSizes[userKey] = { w: Math.round(size.w), h: Math.round(size.h) };
  try { chrome.storage.local.set({ [STORAGE_KEYS.sizes]: savedSizes }); } catch {}
}

function openRecord(thread, inspection) {
  const userKey = getUserKey(thread, inspection.header);
  const record = {
    thread,
    userKey,
    handle: null,
    originalStyles: rememberInlineStyles(thread)
  };
  records.set(thread, record);
  thread.classList.add('twr-managed-thread');
  applyPositioningFallback(thread);
  createHandle(record);

  if (userKey && savedSizes[userKey]) {
    const saved = savedSizes[userKey];
    if (Number.isFinite(Number(saved.w)) && Number.isFinite(Number(saved.h))) {
      const size = applyThreadSize(record, saved);
      if (size.w !== Number(saved.w) || size.h !== Number(saved.h)) persistSize(userKey, size);
    }
  }
  debugLog('handle-created', {
    className: typeof thread.className === 'string' ? thread.className.slice(0, 180) : '',
    reason: inspection.reason,
    hasRecipientKey: Boolean(userKey),
    dimensions: getCurrentSize(thread)
  });
  return record;
}

function closeRecord(thread, commitDrag = false) {
  const record = records.get(thread);
  if (!record) return;
  if (dragState && dragState.thread === thread) finishDrag(commitDrag);
  record.handle?.remove();
  thread.classList.remove('twr-managed-thread', 'twr-being-resized');
  restoreProperties(thread, record.originalStyles, MANAGED_PROPERTIES);
  records.delete(thread);
  if (activeThread === thread) activeThread = null;
  debugLog('handle-removed', { reason: 'thread-no-longer-open-or-removed' });
}

function applySavedSizeIfPresent(record) {
  if (!record.userKey) return;
  const saved = savedSizes[record.userKey];
  if (saved && Number.isFinite(Number(saved.w)) && Number.isFinite(Number(saved.h))) {
    applyThreadSize(record, saved);
  }
}

function scanThreads() {
  if (!initialized) return;
  const candidates = getThreadCandidates();
  recordDetectionDiagnostics(candidates);
  const candidateSet = new Set(candidates);

  for (const thread of Array.from(records.keys())) {
    const inspection = candidateSet.has(thread) ? inspectThread(thread) : null;
    const currentKey = inspection ? getUserKey(thread, inspection.header) : null;
    const currentRecord = records.get(thread);
    if (!inspection || !inspection.open || (currentRecord.userKey && currentKey && currentRecord.userKey !== currentKey)) {
      closeRecord(thread, false);
    } else if (!currentRecord.userKey && currentKey) {
      currentRecord.userKey = currentKey;
      applySavedSizeIfPresent(currentRecord);
    }
  }

  for (const thread of candidates) {
    const existing = records.get(thread);
    if (existing) {
      // React can replace children of the window while keeping the window node.
      if (!existing.handle || !existing.handle.isConnected || existing.handle.parentElement !== document.body) {
        existing.handle?.remove();
        createHandle(existing);
        debugLog('handle-recreated', { reason: 'Twitch-rerendered-window-contents' });
      }
      positionHandle(existing);
      continue;
    }
    const inspection = inspectThread(thread);
    if (!inspection.open) continue;
    const record = openRecord(thread, inspection);
    if (record) positionHandle(record);
  }
  positionAllHandles();
}

function findRecordFromTarget(target) {
  for (const [thread, record] of records) {
    if (thread === target || thread.contains(target)) return record;
  }
  return null;
}

function startDrag(event, record) {
  if (event.button !== 0 || !inspectThread(record.thread).open) return;
  event.preventDefault();
  event.stopPropagation();
  if (dragState) finishDrag(true);

  activeThread = record.thread;
  record.handle.classList.add('twr-active');
  record.thread.classList.add('twr-being-resized');
  const size = getCurrentSize(record.thread);
  const computed = window.getComputedStyle(record.thread);
  const position = computed.position;
  const offsetParent = record.thread.offsetParent;
  const rect = record.thread.getBoundingClientRect();
  let startLeft;
  let startTop;

  if (position === 'fixed' || !offsetParent) {
    startLeft = rect.left;
    startTop = rect.top;
  } else if (position === 'absolute') {
    const parentRect = offsetParent.getBoundingClientRect();
    startLeft = rect.left - parentRect.left - offsetParent.clientLeft + offsetParent.scrollLeft;
    startTop = rect.top - parentRect.top - offsetParent.clientTop + offsetParent.scrollTop;
  } else {
    startLeft = Number.parseFloat(computed.left);
    startTop = Number.parseFloat(computed.top);
    if (!Number.isFinite(startLeft)) startLeft = 0;
    if (!Number.isFinite(startTop)) startTop = 0;
  }

  // Freeze the initial position so the opposite (bottom-right) corner stays put.
  record.thread.style.setProperty('left', startLeft + 'px', 'important');
  record.thread.style.setProperty('top', startTop + 'px', 'important');

  dragState = {
    pointerId: event.pointerId,
    record,
    thread: record.thread,
    startX: event.clientX,
    startY: event.clientY,
    startW: size.w,
    startH: size.h,
    startLeft,
    startTop,
    fixedRight: rect.right,
    fixedBottom: rect.bottom,
    currentSize: size
  };

  try { record.handle.setPointerCapture(event.pointerId); } catch {}
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  debugLog('resize-start', { dimensions: size, pointerType: event.pointerType });
}

function onPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  event.preventDefault();
  // Upper-left grip: moving left/up enlarges the window.
  const width = dragState.startW + dragState.startX - event.clientX;
  const height = dragState.startH + dragState.startY - event.clientY;
  dragState.currentSize = applyThreadSize(dragState.record, { w: width, h: height });

  const thread = dragState.thread;
  const rect = thread.getBoundingClientRect();
  const rightDelta = rect.right - dragState.fixedRight;
  const bottomDelta = rect.bottom - dragState.fixedBottom;
  if (Math.abs(rightDelta) > 1) {
    const left = Number.parseFloat(thread.style.left);
    thread.style.setProperty('left', ((Number.isFinite(left) ? left : dragState.startLeft) - rightDelta) + 'px', 'important');
  }
  if (Math.abs(bottomDelta) > 1) {
    const top = Number.parseFloat(thread.style.top);
    thread.style.setProperty('top', ((Number.isFinite(top) ? top : dragState.startTop) - bottomDelta) + 'px', 'important');
  }
  positionHandle(dragState.record);
}

function onPointerUp(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  finishDrag(true);
}

function onPointerCancel(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  finishDrag(true);
}

function finishDrag(commit) {
  const current = dragState;
  if (!current) return;
  dragState = null;
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  document.removeEventListener('pointercancel', onPointerCancel, true);
  current.record.handle?.classList.remove('twr-active');
  current.thread.classList.remove('twr-being-resized');

  try {
    if (current.record.handle?.hasPointerCapture(current.pointerId)) {
      current.record.handle.releasePointerCapture(current.pointerId);
    }
  } catch {}
  if (commit && records.has(current.thread) && inspectThread(current.thread).open) {
    const finalSize = current.currentSize || getCurrentSize(current.thread);
    persistSize(current.record.userKey, finalSize);
    debugLog('resize-finish', { dimensions: finalSize });
  }
}

function resizeActiveThread(direction) {
  const record = activeThread && records.get(activeThread);
  if (!record || !inspectThread(record.thread).open) return false;
  const current = getCurrentSize(record.thread);
  let width = current.w;
  let height = current.h;
  if (direction === 'ArrowLeft') width -= 10;
  if (direction === 'ArrowRight') width += 10;
  if (direction === 'ArrowUp') height += 10;
  if (direction === 'ArrowDown') height -= 10;
  const size = applyThreadSize(record, { w: width, h: height });
  persistSize(record.userKey, size);
  debugLog('keyboard-resize', { dimensions: size, direction });
  return true;
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}

document.addEventListener('pointerdown', (event) => {
  const record = findRecordFromTarget(event.target);
  if (record) activeThread = record.thread;
}, true);

// Keep the external grip aligned when Twitch moves a window by dragging its header.
document.addEventListener('pointermove', (event) => {
  if (dragState) return;
  if (findRecordFromTarget(event.target)) positionAllHandles();
}, true);

// If Twitch repositions a window while dragging its header, keep the external
// grip anchored to the window's upper-left corner.
document.addEventListener('pointermove', (event) => {
  if (dragState) return;
  if (findRecordFromTarget(event.target)) positionAllHandles();
}, true);

document.addEventListener('focusin', (event) => {
  const record = findRecordFromTarget(event.target);
  if (record) activeThread = record.thread;
}, true);

document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || isEditableTarget(event.target)) return;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  if (resizeActiveThread(event.key)) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

function handleWindowResize() {
  scanThreads();
  for (const record of records.values()) {
    const current = getCurrentSize(record.thread);
    const next = clampSize(current.w, current.h);
    if (Math.abs(current.w - next.w) > 1 || Math.abs(current.h - next.h) > 1) {
      const applied = applyThreadSize(record, next);
      persistSize(record.userKey, applied);
    }
  }
}
window.addEventListener('resize', handleWindowResize);
window.addEventListener('scroll', positionAllHandles, true);

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes[STORAGE_KEYS.settings]) {
      settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);
      for (const record of records.values()) {
        updateHandleAppearance(record.handle);
        positionHandle(record);
        const current = getCurrentSize(record.thread);
        const applied = applyThreadSize(record, current);
        if (Math.abs(current.w - applied.w) > 1 || Math.abs(current.h - applied.h) > 1) {
          persistSize(record.userKey, applied);
        }
      }
      debugLog('settings-updated', { handleSize: settings.handleSize });
    }

    if (areaName === 'local' && changes[STORAGE_KEYS.sizes]) {
      savedSizes = changes[STORAGE_KEYS.sizes].newValue || {};
      for (const record of records.values()) {
        const saved = record.userKey && savedSizes[record.userKey];
        if (saved && Number.isFinite(Number(saved.w)) && Number.isFinite(Number(saved.h))) {
          applyThreadSize(record, saved);
        } else {
          restoreBaseDimensions(record);
          applyPositioningFallback(record.thread);
        }
      }
    }

    if (areaName === 'local' && changes[STORAGE_KEYS.debugEnabled]) {
      const nextEnabled = Boolean(changes[STORAGE_KEYS.debugEnabled].newValue);
      if (nextEnabled && !debugEnabled) {
        debugEnabled = true;
        lastScanSignature = '';
        debugLog('debug-enabled', { page: window.location.origin + window.location.pathname });
        scanThreads();
      } else if (!nextEnabled && debugEnabled) {
        debugLog('debug-disabled');
        debugEnabled = false;
        scheduleDebugPersist();
      }
    }
  });
}

async function initialize() {
  try {
    const [syncData, localData] = await Promise.all([
      chrome.storage.sync.get(STORAGE_KEYS.settings),
      chrome.storage.local.get([STORAGE_KEYS.sizes, STORAGE_KEYS.debugEnabled])
    ]);
    settings = normalizeSettings(syncData[STORAGE_KEYS.settings]);
    savedSizes = localData[STORAGE_KEYS.sizes] || {};
    debugEnabled = Boolean(localData[STORAGE_KEYS.debugEnabled]);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
    savedSizes = {};
    debugEnabled = false;
  }

  initialized = true;
  if (debugEnabled) {
    debugLog('content-script-ready', {
      url: window.location.origin + window.location.pathname,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });
  }
  scanThreads();
}

initialize();

const observer = new MutationObserver(() => scanThreads());
if (document.body) {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-expanded', 'data-a-target', 'data-test-selector']
  });
}
