'use strict';

const SETTINGS_KEY = 'twrSettings';
const SIZES_KEY = 'twrSizes';
const DEFAULTS = {
  minWidth: 200,
  minHeight: 150,
  maxWidth: 1600,
  maxHeight: 1200,
  handleColor: '#9146ff',
  handleSize: 24
};

const form = document.getElementById('settings-form');
const status = document.getElementById('status');
const resetButton = document.getElementById('reset');

function readSettings() {
  const formData = new FormData(form);
  return {
    minWidth: Number(formData.get('minWidth')),
    minHeight: Number(formData.get('minHeight')),
    maxWidth: Number(formData.get('maxWidth')),
    maxHeight: Number(formData.get('maxHeight')),
    handleColor: String(formData.get('handleColor')),
    handleSize: Number(formData.get('handleSize'))
  };
}

function showStatus(message, isWarning = false) {
  status.textContent = message;
  status.classList.toggle('warning', isWarning);
}

function populate(settings) {
  const values = { ...DEFAULTS, ...(settings || {}) };
  Object.entries(values).forEach(([key, value]) => {
    const field = document.getElementById(key);
    if (field) field.value = value;
  });
}

async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(SETTINGS_KEY);
    populate(result[SETTINGS_KEY]);
  } catch {
    populate(DEFAULTS);
    showStatus('Не удалось прочитать синхронизированные настройки.', true);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = readSettings();

  if (values.minWidth > values.maxWidth || values.minHeight > values.maxHeight) {
    showStatus('Максимальная ширина и высота должны быть не меньше соответствующих минимальных значений.', true);
    return;
  }
  if (
    values.minWidth < 100 || values.minWidth > 2400 ||
    values.minHeight < 100 || values.minHeight > 2000 ||
    values.maxWidth < 100 || values.maxWidth > 3000 ||
    values.maxHeight < 100 || values.maxHeight > 2400 ||
    values.handleSize < 12 || values.handleSize > 48 ||
    !/^#[0-9a-f]{6}$/i.test(values.handleColor)
  ) {
    showStatus('Проверьте числовые значения и диапазоны полей.', true);
    return;
  }

  try {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: values });
    showStatus('Настройки сохранены.');
  } catch {
    showStatus('Не удалось сохранить настройки в chrome.storage.sync.', true);
  }
});

resetButton.addEventListener('click', async () => {
  const confirmed = window.confirm('Удалить все сохранённые размеры переписок? Окна вернутся к штатным размерам Twitch.');
  if (!confirmed) return;

  try {
    await chrome.storage.local.remove(SIZES_KEY);
    showStatus('Все сохранённые размеры сброшены.');
  } catch {
    showStatus('Не удалось сбросить размеры.', true);
  }
});

loadSettings();


const DEBUG_ENABLED_KEY = 'twrDebugEnabled';
const DEBUG_LOG_PREFIX = 'twrDebugLog_';
const debugCheckbox = document.getElementById('debug-enabled');
const exportDebugButton = document.getElementById('export-debug');
const clearDebugButton = document.getElementById('clear-debug');

async function loadDebugState() {
  try {
    const data = await chrome.storage.local.get(DEBUG_ENABLED_KEY);
    debugCheckbox.checked = Boolean(data[DEBUG_ENABLED_KEY]);
  } catch {
    showStatus('Не удалось прочитать состояние диагностики.', true);
  }
}

debugCheckbox.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ [DEBUG_ENABLED_KEY]: debugCheckbox.checked });
    showStatus(debugCheckbox.checked
      ? 'Диагностика включена. Воспроизведите проблему, затем экспортируйте JSON.'
      : 'Диагностика выключена. Уже собранные логи можно экспортировать.');
  } catch {
    showStatus('Не удалось изменить состояние диагностики.', true);
    debugCheckbox.checked = !debugCheckbox.checked;
  }
});

exportDebugButton.addEventListener('click', async () => {
  try {
    // Allow a final throttled write from a content script to reach storage.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const localData = await chrome.storage.local.get(null);
    const syncData = await chrome.storage.sync.get(SETTINGS_KEY);
    const sessions = Object.entries(localData)
      .filter(([key, value]) => key.startsWith(DEBUG_LOG_PREFIX) && value && Array.isArray(value.entries))
      .map(([key, value]) => ({ storageKey: key, ...value }));

    const report = {
      reportVersion: 1,
      exportedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      debugEnabled: Boolean(localData[DEBUG_ENABLED_KEY]),
      settings: syncData[SETTINGS_KEY] || DEFAULTS,
      sessionCount: sessions.length,
      sessions
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'twitch-whisper-resizer-debug-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    showStatus('Экспорт готов: найдено сессий диагностики — ' + sessions.length + '.');
  } catch (error) {
    showStatus('Экспорт не удался: ' + (error && error.message ? error.message : String(error)), true);
  }
});

clearDebugButton.addEventListener('click', async () => {
  try {
    const localData = await chrome.storage.local.get(null);
    const keys = Object.keys(localData).filter((key) => key.startsWith(DEBUG_LOG_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
    showStatus('Удалено debug-сессий: ' + keys.length + '.');
  } catch {
    showStatus('Не удалось удалить debug-логи.', true);
  }
});

loadDebugState();
