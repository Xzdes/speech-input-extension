/**
 * @file background.js (Service Worker)
 * @description Handles background tasks for the extension, such as
 * managing extension state, icon updates, and command listeners.
 */

const DEFAULT_SETTINGS = {
  dictationActive: true,
  dictationLang: 'ru-RU',
  translationActive: false,
  geminiApiKey: '',
  translationLang: 'en',
  geminiModel: 'gemini-1.5-flash-latest',
  customGeminiModel: '',
  autoReplaceRules: '',
  blacklistSites: ''
};

/**
 * Updates the browser action icon and title based on the dictation state.
 * @param {boolean} isActive - Whether dictation is currently active.
 */
function updateActionState(isActive) {
  const iconPathPrefix = isActive ? 'icons/icon-on-' : 'icons/icon-off-';
  const title = isActive ? 'Голосовой Ввод Pro (Включено)' : 'Голосовой Ввод Pro (Выключено)';

  chrome.action.setIcon({
    path: {
      '16': `${iconPathPrefix}16.png`,
      '32': `${iconPathPrefix}32.png`,
      '48': `${iconPathPrefix}48.png`,
      '128': `${iconPathPrefix}128.png`
    }
  }, () => {
    if (chrome.runtime.lastError) {
      // Эта ошибка может возникать, если иконки не найдены. Убедитесь, что пути верны.
      console.warn('Background: Error setting icon:', chrome.runtime.lastError.message);
    }
  });
  chrome.action.setTitle({ title });
}

/**
 * Sends a message to the content script in the active tab.
 * @param {object} message - The message object to send.
 */
function sendMessageToActiveContentScript(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        if (chrome.runtime.lastError) {
          // Ожидаемо, если на странице нет content script или он не готов
          if (chrome.runtime.lastError.message !== "Could not establish connection. Receiving end does not exist.") {
            console.warn(`Background: Error sending message ${message.command}:`, chrome.runtime.lastError.message);
          }
        } else {
          console.log(`Background: Message ${message.command} response:`, response);
        }
      });
    } else {
      console.log('Background: No active tab found to send message.');
    }
  });
}


// 1. Инициализация/обновление настроек при установке/обновлении расширения
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (currentSettings) => {
      // Устанавливаем только те значения по умолчанию, которые еще не определены
      // или если мы хотим принудительно обновить структуру настроек.
      // Для простоты, мы просто объединим с текущими, отдавая приоритет существующим.
      const newSettings = { ...DEFAULT_SETTINGS, ...currentSettings };

      // Особый случай: если dictationActive не был определен, устанавливаем его в true (из DEFAULT_SETTINGS)
      if (typeof currentSettings.dictationActive === 'undefined') {
        newSettings.dictationActive = DEFAULT_SETTINGS.dictationActive;
      }
      // Аналогично для других ключевых настроек, если нужно
      if (typeof currentSettings.dictationLang === 'undefined') {
        newSettings.dictationLang = DEFAULT_SETTINGS.dictationLang;
      }


      chrome.storage.sync.set(newSettings, () => {
        console.log('Background: Extension installed/updated. Initial/updated settings applied.');
        updateActionState(newSettings.dictationActive);
      });
    });
  }
});

// 2. Слушаем изменения в chrome.storage для обновления иконки
//    (например, если состояние dictationActive изменено из popup.js)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') {
    if (changes.dictationActive) {
      const isActive = changes.dictationActive.newValue;
      updateActionState(isActive);
      console.log('Background: dictationActive changed in storage, icon updated to:', isActive);
    }
    // Другие настройки, если они влияют на background логику (сейчас нет таких)
  }
});

// 3. При запуске браузера, убедимся, что иконка соответствует сохраненному состоянию
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.sync.get('dictationActive', (result) => {
    const isActive = result.dictationActive !== undefined ? result.dictationActive : DEFAULT_SETTINGS.dictationActive;
    updateActionState(isActive);
    console.log('Background: Browser startup, icon state set to:', isActive);
  });
});

// 4. Слушаем команды (например, горячие клавиши)
chrome.commands.onCommand.addListener((command) => {
  console.log(`Background: Command received: ${command}`);
  if (command === 'toggle-dictation') {
    chrome.storage.sync.get('dictationActive', (result) => {
      const currentActiveState = result.dictationActive !== undefined ? result.dictationActive : DEFAULT_SETTINGS.dictationActive;
      const newActiveState = !currentActiveState;
      chrome.storage.sync.set({ dictationActive: newActiveState }, () => {
        // Иконка обновится через storage.onChanged.
        // Отправим прямое сообщение в content script для немедленной реакции.
        sendMessageToActiveContentScript({ command: "toggleDictation", data: newActiveState });
        console.log(`Background: 'toggle-dictation' command processed. New state: ${newActiveState}`);
      });
    });
  }
});

// Проверка при запуске service worker (полезно для отладки)
console.log("Background service worker started.");
// Установим иконку сразу при запуске service worker, не дожидаясь onStartup или onInstalled.
// Это помогает, если service worker перезапускается во время работы браузера.
chrome.storage.sync.get('dictationActive', (result) => {
    const isActive = result.dictationActive !== undefined ? result.dictationActive : DEFAULT_SETTINGS.dictationActive;
    updateActionState(isActive);
});