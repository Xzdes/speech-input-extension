/**
 * @file background.js (Service Worker)
 * @description Handles background tasks for the extension, such as
 * managing extension state and icon updates.
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

  console.log(`Background: Updating action state. Active: ${isActive}, IconPrefix: ${iconPathPrefix}`);

  chrome.action.setIcon({
    path: {
      '16': `${iconPathPrefix}16.png`,
      '32': `${iconPathPrefix}32.png`,
      '48': `${iconPathPrefix}48.png`,
      '128': `${iconPathPrefix}128.png`
    }
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Background: Error setting icon:', chrome.runtime.lastError.message, 'Path prefix used:', iconPathPrefix);
    } else {
      console.log('Background: Icon set successfully for state:', isActive);
    }
  });

  chrome.action.setTitle({ title: title }, () => {
     if (chrome.runtime.lastError) {
      console.warn('Background: Error setting title:', chrome.runtime.lastError.message);
    } else {
      console.log('Background: Title set successfully for state:', isActive);
    }
  });
}

// 1. Инициализация/обновление настроек при установке/обновлении расширения
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Background: onInstalled event, reason:', details.reason);
  // Загружаем все настройки, чтобы не затереть существующие пользовательские настройки при обновлении,
  // а только добавить новые ключи из DEFAULT_SETTINGS, если их нет.
  chrome.storage.sync.get(null, (currentSettings) => {
    const newSettings = { ...DEFAULT_SETTINGS, ...currentSettings };

    // Явно устанавливаем значения по умолчанию для ключевых настроек, если они отсутствуют
    if (typeof currentSettings.dictationActive === 'undefined') {
      newSettings.dictationActive = DEFAULT_SETTINGS.dictationActive;
    }
    if (typeof currentSettings.dictationLang === 'undefined') {
      newSettings.dictationLang = DEFAULT_SETTINGS.dictationLang;
    }
    // Добавьте сюда другие настройки из DEFAULT_SETTINGS, если для них критично иметь значение по умолчанию

    chrome.storage.sync.set(newSettings, () => {
      console.log('Background: Extension installed/updated. Initial/updated settings applied:', newSettings);
      updateActionState(newSettings.dictationActive);
    });
  });
});

// 2. Слушаем изменения в chrome.storage для обновления иконки
//    (например, если состояние dictationActive изменено из popup.js)
chrome.storage.onChanged.addListener((changes, namespace) => {
  console.log('Background: storage.onChanged event. Namespace:', namespace, 'Changes:', changes);
  if (namespace === 'sync') {
    if (changes.dictationActive) {
      const isActive = changes.dictationActive.newValue;
      console.log('Background: dictationActive changed in storage. New value:', isActive);
      updateActionState(isActive);
    }
  }
});

// 3. При запуске браузера, убедимся, что иконка соответствует сохраненному состоянию
chrome.runtime.onStartup.addListener(() => {
  console.log('Background: onStartup event.');
  chrome.storage.sync.get('dictationActive', (result) => {
    const isActive = result.dictationActive !== undefined ? result.dictationActive : DEFAULT_SETTINGS.dictationActive;
    console.log('Background: Browser startup, retrieved dictationActive:', isActive);
    updateActionState(isActive);
  });
});

// Примечание: sendMessageToActiveContentScript была связана с обработкой команд,
// если она больше нигде не используется, её можно удалить.
// В текущем сценарии, когда popup.js напрямую общается с content.js,
// а background.js только реагирует на storage, эта функция может быть не нужна.
// Оставим её на случай, если в будущем понадобится фоновая отправка сообщений.
/**
 * Sends a message to the content script in the active tab.
 * @param {object} message - The message object to send.
 */
// function sendMessageToActiveContentScript(message) { // Если не используется, можно удалить
//   chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
//     if (tabs[0] && tabs[0].id) {
//       chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
//         if (chrome.runtime.lastError) {
//           if (chrome.runtime.lastError.message !== "Could not establish connection. Receiving end does not exist.") {
//             console.warn(`Background: Error sending message ${message.command}:`, chrome.runtime.lastError.message);
//           }
//         } else {
//           console.log(`Background: Message ${message.command} response:`, response);
//         }
//       });
//     } else {
//       console.log('Background: No active tab found to send message.');
//     }
//   });
// }


// Убеждаемся, что иконка установлена правильно при старте/рестарте Service Worker
console.log("Background service worker starting/restarting...");
chrome.storage.sync.get('dictationActive', (result) => {
    const isActive = result.dictationActive !== undefined ? result.dictationActive : DEFAULT_SETTINGS.dictationActive;
    console.log('Background: Initial check/set of icon state on SW start. Active:', isActive);
    updateActionState(isActive);
});