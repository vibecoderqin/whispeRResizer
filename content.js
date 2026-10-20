'use strict';

// Keep Twitch DOM heuristics together so they are easy to adjust if the site changes.
const DOM_SELECTORS = Object.freeze({
  thread: [
    '.whispers-thread',
    '[data-a-target="whisper-thread"]',
    '[data-test-selector="thread__wrapper"]'
  ],
  header: [
    '.thread-header__title-bar-container',
    '.thread-header',
    '[data-a-target="whisper-thread-header"]'
  ],
  title: [
    '.thread-header__title',
    '[data-a-target="whisper-thread-header"]',
    '[data-test-selector="thread-header__username"]'
  ],
  composer: [
    'textarea[data-a-target="whisper-message-input"]',
    'input[data-a-target="whisper-message-input"]',
    '[data-a-target="whisper-message-input"] textarea',
    '[contenteditable="true"][data-a-target*="whisper"]',
    '.thread-input textarea',
    'textarea[placeholder*="Send a message" i]'
  ],
  excludedAncestors: [
    '.whispers-list-item',
    '[data-test-selector*="notification"]',
    '[data-a-target="whisper-notification"]',
    '[role="alert"]',
    '.toast'
  ]
});

const STORAGE_KEYS = Object.freeze({
  settings: 'twrSettings',
  sizes: 'twrSizes'
});

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
const MANAGED_PROPERTIES = DIMENSION_PROPERTIES.concat('position');
const THREAD_SELECTOR = DOM_SELECTORS.thread.join(',');
const HEADER_SELECTOR = DOM_SELECTORS.header.join(',');
const TITLE_SELECTOR = DOM_SELECTORS.title.join(',');
const COMPOSER_SELECTOR = DOM_SELECTORS.composer.join(',');
const EXCLUDED_SELECTOR = DOM_SELECTORS.excludedAncestors.join(',');

let settings = { ...DEFAULT_SETTINGS };
let savedSizes = {};
const records = new Map();
let activeThread = null;
let dragState = null;
let initialized = false;

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
  result.handleColor = typeof input.handleColor === 'string' &&
    /^#[0-9a-f]{6}$/i.test(input.handleColor)
    ? input.handleColor
    : DEFAULT_SETTINGS.handleColor;

  return result;
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
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

function firstMatch(root, selectors) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function getThreadCandidates() {
  const matches = Array.from(document.querySelectorAll(THREAD_SELECTOR));
  // Some fallback selectors can match a wrapper around the real thread. Prefer
  // the deepest matching node so one conversation never receives two handles.
  return matches.filter((element) =>
    !matches.some((other) => other !== element && element.contains(other))
  );
}

function isExcludedThread(thread) {
  try {
    return Boolean(thread.closest(EXCLUDED_SELECTOR));
  } catch {
    return false;
  }
}

function isOpenThread(thread) {
  if (!thread || !thread.isConnected || isExcludedThread(thread)) return false;

  const header = firstMatch(thread, DOM_SELECTORS.header);
  const composer = firstMatch(thread, DOM_SELECTORS.composer);
  if (!isVisible(header) || !isVisible(composer)) return false;

  // Twitch uses a separate compact notification/preview state. Requiring a
  // visible message composer, a header, and a full-window-sized bounding box
  // avoids resizing those previews even when they reuse a thread class.
  const rect = thread.getBoundingClientRect();
  return rect.width >= DEFAULT_SETTINGS.minWidth &&
    rect.height >= DEFAULT_SETTINGS.minHeight;
}

function getUserKey(thread) {
  const header = firstMatch(thread, DOM_SELECTORS.header);
  if (!header) return null;

  // A profile link is the most reliable identifier; it is independent of
  // display-name changes and localized header text.
  for (const anchor of header.querySelectorAll('a[href]')) {
    try {
      const url = new URL(anchor.getAttribute('href'), window.location.origin);
      const match = url.pathname.match(/^\/([a-zA-Z0-9_]{1,25})\/?$/);
      const reserved = new Set([
        'directory', 'downloads', 'jobs', 'login', 'p', 'products',
        'search', 'settings', 'signup', 'subscriptions', 'turbo'
      ]);
      if (match && !reserved.has(match[1].toLowerCase())) {
        return match[1].toLowerCase();
      }
    } catch {
      // Ignore malformed or non-profile links in the header.
    }
  }

  const title = firstMatch(header, DOM_SELECTORS.title) || header;
  const text = (title.innerText || title.textContent || '')
    .replace(/[×✕✖]/g, ' ')
    .replace(/\b(close|minimize|maximize|whisper|conversation)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || text.length > 100) return null;
  return text.toLowerCase();
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
    if (!original || !original.value) {
      thread.style.removeProperty(property);
    } else {
      thread.style.setProperty(property, original.value, original.priority);
    }
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
  record.thread.appendChild(handle);
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

function getLimits() {
  const minWidth = settings.minWidth;
  const minHeight = settings.minHeight;
  // A little breathing room is left around the dialog. User settings are still
  // respected, but the current viewport can lower the effective maximum.
  const maxWidth = Math.max(minWidth, Math.min(settings.maxWidth, Math.floor(window.innerWidth * 0.8)));
  const maxHeight = Math.max(minHeight, Math.min(settings.maxHeight, Math.floor(window.innerHeight * 0.9)));
  return { minWidth, minHeight, maxWidth, maxHeight };
}

function clampSize(width, height) {
  const limits = getLimits();
  const proposedWidth = Number(width);
  const proposedHeight = Number(height);
  return {
    w: Math.round(clampNumber(proposedWidth, limits.minWidth, limits.maxWidth, limits.minWidth)),
    h: Math.round(clampNumber(proposedHeight, limits.minHeight, limits.maxHeight, limits.minHeight))
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
  try {
    chrome.storage.local.set({ [STORAGE_KEYS.sizes]: savedSizes });
  } catch {
    // Resizing should still work if storage is temporarily unavailable.
  }
}

function openRecord(thread) {
  const userKey = getUserKey(thread);
  // Without an identifiable recipient, don't risk sharing dimensions between
  // unrelated chats.
  if (!userKey) return null;

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

  const saved = savedSizes[userKey];
  if (saved && Number.isFinite(Number(saved.w)) && Number.isFinite(Number(saved.h))) {
    const size = applyThreadSize(record, saved);
    if (size.w !== Number(saved.w) || size.h !== Number(saved.h)) {
      persistSize(userKey, size);
    }
  }
  return record;
}

function closeRecord(thread, commitDrag = false) {
  const record = records.get(thread);
  if (!record) return;

  if (dragState && dragState.thread === thread) finishDrag(commitDrag);
  if (record.handle) record.handle.remove();
  thread.classList.remove('twr-managed-thread', 'twr-being-resized');
  restoreProperties(thread, record.originalStyles, MANAGED_PROPERTIES);
  records.delete(thread);
  if (activeThread === thread) activeThread = null;
}

function scanThreads() {
  if (!initialized) return;
  const candidates = getThreadCandidates();
  const candidateSet = new Set(candidates);

  for (const thread of Array.from(records.keys())) {
    if (!candidateSet.has(thread) || !isOpenThread(thread) || getUserKey(thread) !== records.get(thread).userKey) {
      closeRecord(thread, false);
    }
  }

  for (const thread of candidates) {
    const existing = records.get(thread);
    if (existing) {
      // Twitch may rerender a thread's children without replacing the thread node.
      // Recreate our handle if React removed it during that update.
      if (!existing.handle || !existing.handle.isConnected || existing.handle.parentElement !== thread) {
        existing.handle?.remove();
        createHandle(existing);
        updateHandleAppearance(existing.handle);
      }
      continue;
    }
    if (!isOpenThread(thread)) continue;
    openRecord(thread);
  }
}

function findRecordFromTarget(target) {
  for (const [thread, record] of records) {
    if (thread === target || thread.contains(target)) return record;
  }
  return null;
}

function startDrag(event, record) {
  if (event.button !== 0 || !isOpenThread(record.thread)) return;

  event.preventDefault();
  event.stopPropagation();
  if (dragState) finishDrag(true);

  activeThread = record.thread;
  record.handle.classList.add('twr-active');
  record.thread.classList.add('twr-being-resized');

  const size = getCurrentSize(record.thread);
  dragState = {
    pointerId: event.pointerId,
    record,
    thread: record.thread,
    startX: event.clientX,
    startY: event.clientY,
    startW: size.w,
    startH: size.h,
    currentSize: size
  };

  try {
    record.handle.setPointerCapture(event.pointerId);
  } catch {
    // Document-level Pointer Events remain as a fallback.
  }

  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
}

function onPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  event.preventDefault();

  const width = dragState.startW + dragState.startX - event.clientX;
  const height = dragState.startH + dragState.startY - event.clientY;
  dragState.currentSize = applyThreadSize(dragState.record, { w: width, h: height });
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
  } catch {
    // Pointer capture may already have been released by the browser.
  }

  if (commit && records.has(current.thread) && isOpenThread(current.thread)) {
    persistSize(current.record.userKey, current.currentSize || getCurrentSize(current.thread));
  }
}

function resizeActiveThread(direction) {
  const record = activeThread && records.get(activeThread);
  if (!record || !isOpenThread(record.thread)) return false;

  const current = getCurrentSize(record.thread);
  let width = current.w;
  let height = current.h;

  if (direction === 'ArrowLeft') width -= 10;
  if (direction === 'ArrowRight') width += 10;
  if (direction === 'ArrowUp') height += 10;
  if (direction === 'ArrowDown') height -= 10;

  const size = applyThreadSize(record, { w: width, h: height });
  persistSize(record.userKey, size);
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

document.addEventListener('focusin', (event) => {
  const record = findRecordFromTarget(event.target);
  if (record) activeThread = record.thread;
}, true);

document.addEventListener('keydown', (event) => {
  // Ctrl+Shift avoids consuming the more common Ctrl+Arrow text/navigation
  // shortcuts. Editable fields are left entirely to Twitch/the browser.
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

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes[STORAGE_KEYS.settings]) {
      settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);
      for (const record of records.values()) {
        updateHandleAppearance(record.handle);
        const current = getCurrentSize(record.thread);
        const bounded = clampSize(current.w, current.h);
        const applied = applyThreadSize(record, bounded);
        if (Math.abs(current.w - applied.w) > 1 || Math.abs(current.h - applied.h) > 1) {
          persistSize(record.userKey, applied);
        }
      }
    }

    if (areaName === 'local' && changes[STORAGE_KEYS.sizes]) {
      savedSizes = changes[STORAGE_KEYS.sizes].newValue || {};
      for (const record of records.values()) {
        const saved = savedSizes[record.userKey];
        if (saved && Number.isFinite(Number(saved.w)) && Number.isFinite(Number(saved.h))) {
          applyThreadSize(record, saved);
        } else {
          restoreBaseDimensions(record);
          applyPositioningFallback(record.thread);
        }
      }
    }
  });
}

async function initialize() {
  try {
    const [syncData, localData] = await Promise.all([
      chrome.storage.sync.get(STORAGE_KEYS.settings),
      chrome.storage.local.get(STORAGE_KEYS.sizes)
    ]);
    settings = normalizeSettings(syncData[STORAGE_KEYS.settings]);
    savedSizes = localData[STORAGE_KEYS.sizes] || {};
  } catch {
    settings = { ...DEFAULT_SETTINGS };
    savedSizes = {};
  }

  initialized = true;
  scanThreads();
}

initialize();

// Twitch is a client-rendered SPA. Watch subtree changes and class state changes
// so opening, closing, and preview-to-conversation transitions are detected.
const observer = new MutationObserver(() => scanThreads());
if (document.body) {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-expanded']
  });
}
