'use strict';

const STORAGE_KEY = 'twr_v7';
const MIN_W = 200, MIN_H = 150;

function loadSize() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}
function saveSize(obj) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch {}
}

// Из реального HTML:
// .whispers-thread — само диалоговое окно (может быть несколько)
// .thread-header   — заголовок с именем пользователя и кнопкой ×
// Задача: найти .whispers-thread, узнать его реальный rect, 
// поставить ручку в левый верхний угол, и при drag менять 
// width/height именно этого элемента.

let handles = new Map(); // thread el → handle el

function getThreads() {
  return [...document.querySelectorAll('.whispers-thread')];
}

function createHandleFor(thread) {
  if (handles.has(thread)) return;

  const handle = document.createElement('div');
  handle.className = 'twr-handle';
  handle.title = 'Потяни для изменения размера';
  handle.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M1 11L11 1M1 6.5L6.5 1M5.5 11L11 5.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
  document.body.appendChild(handle);
  handles.set(thread, handle);

  handle.addEventListener('mousedown', e => onDragStart(e, thread, handle));
}

function positionAllHandles() {
  handles.forEach((handle, thread) => {
    // Проверяем что тред ещё в DOM
    if (!document.contains(thread)) {
      handle.remove();
      handles.delete(thread);
      return;
    }
    const rect = thread.getBoundingClientRect();
    if (rect.width === 0) {
      handle.style.display = 'none';
      return;
    }
    handle.style.display = 'flex';
    // Левый верхний угол треда
    handle.style.left = `${rect.left - 28}px`;
    handle.style.top  = `${rect.top + 2}px`;
  });
}

function onDragStart(e, thread, handle) {
  e.preventDefault();
  e.stopPropagation();

  handle.classList.add('twr-active');
  document.body.classList.add('twr-resizing');

  const startX = e.clientX;
  const startY = e.clientY;
  const startW = thread.offsetWidth;
  const startH = thread.offsetHeight;

  // Позиция правого и нижнего краёв — они должны оставаться на месте
  const rect = thread.getBoundingClientRect();
  const fixedRight  = rect.right;   // правый край не двигается
  const fixedBottom = rect.bottom;  // нижний край не двигается

  // Убеждаемся что тред позиционирован
  const cs = window.getComputedStyle(thread);
  if (cs.position === 'static') {
    thread.style.position = 'relative';
  }

  function onMove(e) {
    const dx = startX - e.clientX; // влево → шире
    const dy = startY - e.clientY; // вверх → выше

    const maxW = window.innerWidth  * 0.8;
    const maxH = window.innerHeight * 0.9;
    const newW = Math.min(maxW, Math.max(MIN_W, startW + dx));
    const newH = Math.min(maxH, Math.max(MIN_H, startH + dy));

    thread.style.setProperty('width',     `${newW}px`, 'important');
    thread.style.setProperty('min-width', `${newW}px`, 'important');
    thread.style.setProperty('max-width', `${newW}px`, 'important');
    thread.style.setProperty('height',    `${newH}px`, 'important');
    thread.style.setProperty('min-height',`${newH}px`, 'important');
    thread.style.setProperty('max-height',`${newH}px`, 'important');

    // Корректируем позицию: двигаем left/top так чтобы правый/нижний край стоял на месте
    const newRect = thread.getBoundingClientRect();
    const dRight  = newRect.right  - fixedRight;
    const dBottom = newRect.bottom - fixedBottom;

    if (Math.abs(dRight) > 1) {
      const curLeft = parseFloat(thread.style.left) || 0;
      thread.style.setProperty('left', `${curLeft - dRight}px`, 'important');
    }
    if (Math.abs(dBottom) > 1) {
      const curTop = parseFloat(thread.style.top) || 0;
      thread.style.setProperty('top', `${curTop - dBottom}px`, 'important');
    }

    saveSize({ w: newW, h: newH });
    positionAllHandles();
  }

  function onUp() {
    handle.classList.remove('twr-active');
    document.body.classList.remove('twr-resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function restoreSize(thread) {
  const { w, h } = loadSize();
  if (w) {
    thread.style.setProperty('width',     `${w}px`, 'important');
    thread.style.setProperty('min-width', `${w}px`, 'important');
    thread.style.setProperty('max-width', `${w}px`, 'important');
  }
  if (h) {
    thread.style.setProperty('height',    `${h}px`, 'important');
    thread.style.setProperty('min-height',`${h}px`, 'important');
    thread.style.setProperty('max-height',`${h}px`, 'important');
  }
}

function scan() {
  getThreads().forEach(thread => {
    createHandleFor(thread);
    restoreSize(thread);
  });
  positionAllHandles();
}

window.addEventListener('resize', positionAllHandles);

new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
scan();
setTimeout(scan, 500);
setTimeout(scan, 1500);
setTimeout(scan, 4000);
