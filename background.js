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
  autoReplaceRules:
`вопросительный знак : ?
восклицательный знак : !
точка : .
запятая : ,
двоеточие : :
точка с запятой : ;
тире : -
дефис : -
открыть скобку : (
закрыть скобку : )
новая строка : \\n
абзац : \\n\\n`,
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
    // или если это первая установка.
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
      if (typeof currentSettings[key] === 'undefined') {
        newSettings[key] = DEFAULT_SETTINGS[key];
      }
    });
    // Если при обновлении мы хотим принудительно установить новые дефолтные правила автозамены,
    // ТОЛЬКО если пользователь их не менял (или это первая установка),
    // то можно добавить специальную логику. Но обычно {...DEFAULT_SETTINGS, ...currentSettings}
    // корректно обрабатывает новые ключи и не перезаписывает измененные пользователем.
    // Для autoReplaceRules: если details.reason === 'install', то newSettings.autoReplaceRules будет из DEFAULT_SETTINGS.
    // Если details.reason === 'update' и currentSettings.autoReplaceRules уже существует, он останется.
    // Если это первое добавление autoReplaceRules в DEFAULT_SETTINGS и пользователь обновляется со старой версии,
    // где этого ключа не было, то currentSettings.autoReplaceRules будет undefined, и применится DEFAULT_SETTINGS.autoReplaceRules.

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

// Функция sendMessageToActiveContentScript удалена, так как не используется.

// Убеждаемся, что иконка установлена правильно при старте/рестарте Service Worker
console.log("Background service worker starting/restarting...");
chrome.storage.sync.get('dictationActive', (result) => {
    // Проверяем, существует ли значение dictationActive в хранилище,
    // иначе используем значение из DEFAULT_SETTINGS.
    let isActive;
    if (typeof result.dictationActive === 'undefined') {
        console.log('Background: dictationActive not found in storage on SW start, using default.');
        isActive = DEFAULT_SETTINGS.dictationActive;
        // Сохраняем значение по умолчанию в хранилище, если его там нет.
        // Это важно, чтобы при следующем запуске оно уже было.
        chrome.storage.sync.set({ dictationActive: isActive });
    } else {
        isActive = result.dictationActive;
    }
    console.log('Background: Initial check/set of icon state on SW start. Active:', isActive);
    updateActionState(isActive);
});