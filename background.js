/**
 * @file background.js (Service Worker)
 * @description Handles background tasks for the extension, such as
 * managing extension state, icon updates, and inter-script communication including API calls.
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
  blacklistSites: '',
  promptGeneratorModeActive: false,
  autoInsertGeneratedPrompt: false,
  disableBrowserAutoPunctuation: true,
  interimResultsEnabled: true // Добавим сюда, чтобы было консистентно, хотя background напрямую не использует
};

const ICON_PATHS = {
  ON: { '16': 'icons/icon-on-16.png', '32': 'icons/icon-on-32.png', '48': 'icons/icon-on-48.png', '128': 'icons/icon-on-128.png' },
  OFF: { '16': 'icons/icon-off-16.png', '32': 'icons/icon-off-32.png', '48': 'icons/icon-off-48.png', '128': 'icons/icon-off-128.png' },
  ERROR: { '16': 'icons/icon-error-16.png', '32': 'icons/icon-error-32.png', '48': 'icons/icon-error-48.png', '128': 'icons/icon-error-128.png' }
};

const GEMINI_API_ENDPOINT_PREFIX = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_API_ENDPOINT_SUFFIX = ":generateContent?key=";


let isMicErrorActive = false;
let errorTabId = null;

function updateActionState(isActive) {
  if (isMicErrorActive && errorTabId !== null) { // Показываем ошибку только если она привязана к активной вкладке или глобальна
    // Чтобы проверить, активна ли вкладка с ошибкой:
    // chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    //   if (tabs.length > 0 && tabs[0].id === errorTabId) {
    //     setActionErrorState(true);
    //   } else {
    //     // Если активна другая вкладка, сбрасываем ошибку и показываем нормальное состояние
    //     setActionErrorState(false); // Это вызовет updateActionState снова
    //   }
    // });
    // Пока что упрощенно: если isMicErrorActive true, то ошибка показывается.
    // Сброс происходит при смене вкладки.
     setActionErrorState(true); // Просто переустанавливаем состояние ошибки
    return;
  }

  const icons = isActive ? ICON_PATHS.ON : ICON_PATHS.OFF;
  const title = isActive ? 'Smart Voice Input (Включено)' : 'Smart Voice Input (Выключено)';
  chrome.action.setIcon({ path: icons }, () => { if (chrome.runtime.lastError) console.warn('SVI BG: ErrSetIcon:', chrome.runtime.lastError.message); });
  chrome.action.setTitle({ title: title }, () => { if (chrome.runtime.lastError) console.warn('SVI BG: ErrSetTitle:', chrome.runtime.lastError.message); });
}

function setActionErrorState(showError, errorMessage = null) {
  if (showError) {
    isMicErrorActive = true; // Устанавливаем флаг ошибки
    chrome.action.setIcon({ path: ICON_PATHS.ERROR }, () => { if (chrome.runtime.lastError) console.warn('SVI BG: ErrSetErrIcon:', chrome.runtime.lastError.message); });
    chrome.action.setTitle({ title: errorMessage || 'Smart Voice Input: Ошибка доступа к микрофону!' }, () => { if (chrome.runtime.lastError) console.warn('SVI BG: ErrSetErrTitle:', chrome.runtime.lastError.message); });
  } else {
    // Сбрасываем флаг только если он был установлен для текущей логики сброса
    // Это предотвращает случайный сброс, если ошибка все еще актуальна для другой вкладки (хотя errorTabId сейчас один)
    isMicErrorActive = false;
    errorTabId = null; // Сбрасываем ID вкладки с ошибкой
    chrome.storage.sync.get('dictationActive', (result) => {
      const isActive = typeof result.dictationActive !== 'undefined' ? result.dictationActive : DEFAULT_SETTINGS.dictationActive;
      // updateActionState сама проверит isMicErrorActive (который теперь false) и установит нужную иконку
      const currentIcons = isActive ? ICON_PATHS.ON : ICON_PATHS.OFF;
      const currentTitle = isActive ? 'Smart Voice Input (Включено)' : 'Smart Voice Input (Выключено)';
      chrome.action.setIcon({ path: currentIcons }, () => { if (chrome.runtime.lastError) console.warn('SVI BG: ErrSetIconOnReset:', chrome.runtime.lastError.message); });
      chrome.action.setTitle({ title: currentTitle }, () => { if (chrome.runtime.lastError) console.warn('SVI BG: ErrSetTitleOnReset:', chrome.runtime.lastError.message); });
    });
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.sync.get(null, (currentSettings) => {
    const newSettings = { ...DEFAULT_SETTINGS, ...currentSettings };
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
      if (typeof currentSettings[key] === 'undefined') newSettings[key] = DEFAULT_SETTINGS[key];
    });
    chrome.storage.sync.set(newSettings, () => {
        if (details.reason === "install") {
            // Можно открыть страницу настроек или приветствия при первой установке
            // chrome.runtime.openOptionsPage();
        }
        updateActionState(newSettings.dictationActive);
    });
  });
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') {
    let newDictationActiveState = null;
    if (changes.dictationActive) {
        newDictationActiveState = changes.dictationActive.newValue;
    }

    // Обновляем локальную копию настроек (DEFAULT_SETTINGS используется как кэш)
    for (let key in changes) {
        if (DEFAULT_SETTINGS.hasOwnProperty(key)) {
            DEFAULT_SETTINGS[key] = changes[key].newValue;
        }
    }

    if (newDictationActiveState !== null) {
        if (!newDictationActiveState && isMicErrorActive) { // Если диктовку выключили, а была ошибка микрофона
            setActionErrorState(false); // Сбрасываем состояние ошибки
        } else {
            updateActionState(newDictationActiveState); // Обновляем по новому состоянию диктовки
        }
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.sync.get('dictationActive', (result) => {
    const isActive = typeof result.dictationActive !== 'undefined' ? result.dictationActive : DEFAULT_SETTINGS.dictationActive;
    updateActionState(isActive);
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  // При смене активной вкладки, мы должны переоценить состояние иконки.
  // Если на новой вкладке нет ошибки микрофона (или мы не знаем о ней),
  // иконка должна вернуться в нормальное состояние ON/OFF.
  // Если ошибка была привязана к предыдущей вкладке (errorTabId), то она сбросится.
  if (isMicErrorActive) {
      if (!errorTabId || (errorTabId && activeInfo.tabId !== errorTabId)) {
          setActionErrorState(false); // Сбрасываем, если ошибка не для этой вкладки или была общей
      } else {
          // Ошибка для текущей активной вкладки, оставляем иконку ошибки
          setActionErrorState(true);
      }
  } else {
      // Если ошибки не было, просто обновляем по текущему состоянию dictationActive
      // Это важно, т.к. dictationActive может быть разным (хотя у нас он глобальный)
      // или если service worker перезапускался.
      chrome.storage.sync.get('dictationActive', (result) => {
        const isActive = typeof result.dictationActive !== 'undefined' ? result.dictationActive : DEFAULT_SETTINGS.dictationActive;
        updateActionState(isActive);
      });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Если URL обновился на вкладке, где была зафиксирована ошибка микрофона,
    // есть шанс, что пользователь перешел на другой сайт или обновил разрешения.
    // Сбрасываем состояние ошибки, чтобы content script мог снова его проверить.
    if (isMicErrorActive && tabId === errorTabId && changeInfo.url) {
        setActionErrorState(false);
    }
});

// Слушатель сообщений от других частей расширения
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.command === "micPermissionDenied") {
    // console.log("SVI BG: Received micPermissionDenied", sender.tab); // DEBUG
    if (sender.tab && sender.tab.id) {
        errorTabId = sender.tab.id; // Запоминаем ID вкладки с ошибкой
        // Устанавливаем иконку ошибки, только если это активная вкладка
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0 && tabs[0].id === sender.tab.id) {
                 setActionErrorState(true, `Smart Voice Input: Нет доступа к микрофону на ${request.site || 'сайте'}`);
            }
        });
    } else { // Если не из вкладки (например, popup без активной вкладки) - маловероятно для этой ошибки
        setActionErrorState(true, `Smart Voice Input: Нет доступа к микрофону`);
    }
    sendResponse({ status: "error_state_set_by_background" });
    return false;
  }
  else if (request.command === "generatePromptViaGemini") {
    const { apiKey, model, userContentForPrompt } = request;
    if (!apiKey || !model || !userContentForPrompt) {
      sendResponse({ success: false, error: "Отсутствуют данные для генерации промпта." }); return false;
    }
    const apiUrl = `${GEMINI_API_ENDPOINT_PREFIX}${model}${GEMINI_API_ENDPOINT_SUFFIX}${apiKey}`;
    fetch(apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: userContentForPrompt }] }] }),
    })
    .then(response => {
      if (!response.ok) {
        return response.json().then(errData => { throw new Error(errData?.error?.message || `HTTP error ${response.status}`); })
                           .catch(() => { throw new Error(`Gemini API request failed (prompt gen): ${response.status} ${response.statusText}`); });
      } return response.json();
    })
    .then(data => {
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        sendResponse({ success: true, generatedText: data.candidates[0].content.parts[0].text.trim() });
      } else if (data.promptFeedback?.blockReason) {
        sendResponse({ success: false, error: `Промпт заблокирован API: ${data.promptFeedback.blockReason}` });
      } else { sendResponse({ success: false, error: "Не удалось извлечь текст из ответа Gemini API (prompt gen)." }); }
    })
    .catch(error => { sendResponse({ success: false, error: error.message || "Ошибка при генерации промпта." }); });
    return true; // Асинхронный ответ
  }
  else if (request.command === "translateTextViaGemini") {
    const { textToTranslate, sourceLang, targetLang, apiKey, model } = request;
    if (!apiKey || !model || !textToTranslate || !sourceLang || !targetLang) {
      sendResponse({ success: false, error: "Отсутствуют данные для перевода." }); return false;
    }
    const prompt = `Translate the following text from ${getLanguageNameForPrompt(sourceLang)} to ${getLanguageNameForPrompt(targetLang)}. Return ONLY the translated text, without any introductory phrases, explanations, or quotation marks around the translation itself.\n\nOriginal text:\n"${textToTranslate}"`;
    const apiUrl = `${GEMINI_API_ENDPOINT_PREFIX}${model}${GEMINI_API_ENDPOINT_SUFFIX}${apiKey}`;
    fetch(apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    })
    .then(response => {
      if (!response.ok) {
        return response.json().then(errData => { throw new Error(errData?.error?.message || `HTTP error ${response.status}`); })
                           .catch(() => { throw new Error(`Gemini API request failed (translate): ${response.status} ${response.statusText}`); });
      } return response.json();
    })
    .then(data => {
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        sendResponse({ success: true, translatedText: data.candidates[0].content.parts[0].text.trim() });
      } else if (data.promptFeedback?.blockReason) {
        sendResponse({ success: false, error: `Перевод заблокирован API: ${data.promptFeedback.blockReason}` });
      } else { sendResponse({ success: false, error: "Не удалось извлечь переведенный текст из ответа Gemini API (translate)." }); }
    })
    .catch(error => { sendResponse({ success: false, error: error.message || "Ошибка при переводе." }); });
    return true; // Асинхронный ответ
  }
  return false; // Для синхронных обработчиков или если команда не найдена
});

function getLanguageNameForPrompt(langCode) {
  const lang = langCode.split('-')[0].toLowerCase();
  switch (lang) {
    case 'ru': return 'Russian'; case 'en': return 'English'; case 'de': return 'German';
    case 'fr': return 'French'; case 'es': return 'Spanish'; default: return langCode;
  }
}

// Инициализация состояния иконки при старте/рестарте Service Worker
chrome.storage.sync.get('dictationActive', (result) => {
    let isActive;
    if (typeof result.dictationActive === 'undefined') {
        isActive = DEFAULT_SETTINGS.dictationActive;
        chrome.storage.sync.set({ dictationActive: isActive });
    } else {
        isActive = result.dictationActive;
    }
    isMicErrorActive = false; errorTabId = null;
    updateActionState(isActive);
});