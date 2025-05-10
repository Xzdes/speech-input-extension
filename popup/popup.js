/**
 * @file popup.js
 * @description Handles the logic for the extension's popup window,
 * managing user settings and interactions.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Основные элементы управления
  const toggleDictationCheckbox = document.getElementById('toggleDictation');
  const languageSelect = document.getElementById('languageSelect');
  const disableBrowserAutoPunctuationCheckbox = document.getElementById('disableBrowserAutoPunctuation'); // Новый элемент

  // Элементы настроек генератора промптов
  const togglePromptGeneratorModeCheckbox = document.getElementById('togglePromptGeneratorMode');
  const generatedPromptTextarea = document.getElementById('generatedPromptTextarea');
  const copyPromptButton = document.getElementById('copyPromptButton');
  const autoInsertGeneratedPromptCheckbox = document.getElementById('autoInsertGeneratedPrompt');

  // Элементы настроек перевода
  const toggleTranslationCheckbox = document.getElementById('toggleTranslation');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const translationLanguageSelect = document.getElementById('translationLanguageSelect');
  const geminiModelSelect = document.getElementById('geminiModelSelect');
  const customModelLabel = document.getElementById('customModelLabel');
  const customGeminiModelInput = document.getElementById('customGeminiModel');

  // Элементы настроек автозамены
  const autoReplaceRulesTextarea = document.getElementById('autoReplaceRules');

  // Элементы настроек черного списка
  const blacklistSitesTextarea = document.getElementById('blacklistSites');

  const DEFAULT_SETTINGS = {
    dictationActive: true,
    dictationLang: 'ru-RU',
    disableBrowserAutoPunctuation: true, // Новая настройка по умолчанию
    promptGeneratorModeActive: false, // Новая настройка
    autoInsertGeneratedPrompt: false, // Новая настройка
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
   * Загружает настройки из chrome.storage.sync и обновляет UI.
   */
  function loadSettings() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
      // Основные настройки
      toggleDictationCheckbox.checked = settings.dictationActive;
      languageSelect.value = settings.dictationLang;
      disableBrowserAutoPunctuationCheckbox.checked = settings.disableBrowserAutoPunctuation;

      // Настройки генератора промптов
      togglePromptGeneratorModeCheckbox.checked = settings.promptGeneratorModeActive;
      autoInsertGeneratedPromptCheckbox.checked = settings.autoInsertGeneratedPrompt;
      // generatedPromptTextarea.value - будет обновляться при получении промпта

      // Настройки перевода
      toggleTranslationCheckbox.checked = settings.translationActive;
      geminiApiKeyInput.value = settings.geminiApiKey;
      translationLanguageSelect.value = settings.translationLang;
      geminiModelSelect.value = settings.geminiModel;
      customGeminiModelInput.value = settings.customGeminiModel;

      updateTranslationFieldsState(settings.translationActive || settings.promptGeneratorModeActive); // Поля Gemini активны если включен перевод ИЛИ генератор
      updateCustomGeminiModelFieldState(settings.geminiModel);

      // Настройки автозамены
      autoReplaceRulesTextarea.value = settings.autoReplaceRules;

      // Настройки черного списка
      blacklistSitesTextarea.value = settings.blacklistSites;
    });
  }

  /**
   * Сохраняет одну или несколько настроек в chrome.storage.sync.
   * @param {object} settingsToSave - Объект с настройками для сохранения.
   * @param {function} [callback] - Опциональный колбэк после сохранения.
   */
  function saveSettings(settingsToSave, callback) {
    chrome.storage.sync.set(settingsToSave, () => {
      if (chrome.runtime.lastError) {
        console.error('Smart Voice Input Popup: Error saving settings:', chrome.runtime.lastError);
      } else {
        // console.log('Smart Voice Input Popup: Settings saved:', settingsToSave); // DEBUG
        if (callback) callback();
      }
    });
  }

  /**
   * Обновляет состояние полей, связанных с Gemini API.
   * @param {boolean} isGeminiNeeded - Нужен ли Gemini (для перевода или генератора).
   */
  function updateTranslationFieldsState(isGeminiNeeded) {
    // Ключ API и выбор модели нужны, если активен перевод ИЛИ генератор промптов
    const geminiRequired = toggleTranslationCheckbox.checked || togglePromptGeneratorModeCheckbox.checked;

    geminiApiKeyInput.disabled = !geminiRequired;
    geminiModelSelect.disabled = !geminiRequired;
    // Язык перевода нужен только если активен перевод
    translationLanguageSelect.disabled = !toggleTranslationCheckbox.checked;


    if (geminiRequired) {
        updateCustomGeminiModelFieldState(geminiModelSelect.value);
    } else {
        customGeminiModelInput.disabled = true;
        customModelLabel.style.display = 'none';
    }
  }

  /**
   * Обновляет состояние поля для своей модели Gemini.
   * @param {string} selectedModel - Выбранная модель из списка.
   */
  function updateCustomGeminiModelFieldState(selectedModel) {
    const geminiRequired = toggleTranslationCheckbox.checked || togglePromptGeneratorModeCheckbox.checked;
    if (geminiRequired && selectedModel === 'custom') {
        customModelLabel.style.display = 'flex';
        customGeminiModelInput.disabled = false;
    } else {
        customModelLabel.style.display = 'none';
        customGeminiModelInput.disabled = true;
    }
  }

  /**
   * Отправляет сообщение активной вкладке (content script).
   * @param {object} message - Сообщение для отправки.
   */
  function sendMessageToContentScript(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          if (chrome.runtime.lastError) {
            if (chrome.runtime.lastError.message !== "Could not establish connection. Receiving end does not exist.") {
                 console.warn(`SVI Popup: Error sending msg ${message.command}:`, chrome.runtime.lastError.message);
            }
          } else {
            // console.log(`SVI Popup: Msg ${message.command} response:`, response); // DEBUG
          }
        });
      } else {
        console.warn('SVI Popup: No active tab found to send message.');
      }
    });
  }

  // --- Инициализация ---
  loadSettings();

  // --- Обработчики событий для основных настроек ---
  toggleDictationCheckbox.addEventListener('change', () => {
    const isActive = toggleDictationCheckbox.checked;
    saveSettings({ dictationActive: isActive });
    sendMessageToContentScript({ command: "toggleDictation", data: isActive });
  });

  languageSelect.addEventListener('change', () => {
    const lang = languageSelect.value;
    saveSettings({ dictationLang: lang });
    sendMessageToContentScript({ command: "languageChanged", newLang: lang });
  });

  disableBrowserAutoPunctuationCheckbox.addEventListener('change', () => {
    const isDisabled = disableBrowserAutoPunctuationCheckbox.checked;
    saveSettings({ disableBrowserAutoPunctuation: isDisabled });
    sendMessageToContentScript({ command: "disableBrowserAutoPunctuationChanged", disableBrowserAutoPunctuation: isDisabled });
  });


  // --- Обработчики событий для генератора промптов ---
  togglePromptGeneratorModeCheckbox.addEventListener('change', () => {
    const isActive = togglePromptGeneratorModeCheckbox.checked;
    saveSettings({ promptGeneratorModeActive: isActive });
    sendMessageToContentScript({ command: "setPromptGeneratorMode", isActive: isActive });
    updateTranslationFieldsState(isActive || toggleTranslationCheckbox.checked); // Обновить состояние полей Gemini
    if (isActive) {
        // Если режим генератора промптов включен, режим диктовки должен быть активен, но content script будет обрабатывать его иначе.
        // Можно также автоматически включать основную диктовку, если она выключена,
        // но это может быть неожиданно для пользователя. Пока оставим так.
        // Возможно, при включении этого режима, обычный toggleDictationCheckbox должен становиться неактивным (disabled)
        // и принудительно считаться включенным для этого режима.
    }
  });

  copyPromptButton.addEventListener('click', () => {
    generatedPromptTextarea.select();
    document.execCommand('copy');
    // Можно добавить уведомление "Скопировано!"
    copyPromptButton.textContent = 'Скопировано!';
    setTimeout(() => { copyPromptButton.textContent = 'Копировать промпт'; }, 1500);
  });

  autoInsertGeneratedPromptCheckbox.addEventListener('change', () => {
    saveSettings({ autoInsertGeneratedPrompt: autoInsertGeneratedPromptCheckbox.checked });
    // Сообщение в content.js об этой настройке пока не требуется,
    // т.к. content.js будет получать команду на вставку уже с учетом этой настройки из popup.
  });


  // --- Обработчики событий для настроек перевода ---
  toggleTranslationCheckbox.addEventListener('change', () => {
    const isActive = toggleTranslationCheckbox.checked;
    saveSettings({ translationActive: isActive });
    updateTranslationFieldsState(isActive || togglePromptGeneratorModeCheckbox.checked);
    sendMessageToContentScript({ command: "translationStateChanged", translationActive: isActive });
  });

  geminiApiKeyInput.addEventListener('input', () => {
    saveSettings({ geminiApiKey: geminiApiKeyInput.value });
  });

  translationLanguageSelect.addEventListener('change', () => {
    saveSettings({ translationLang: translationLanguageSelect.value });
    sendMessageToContentScript({ command: "translationLangChanged", newLang: translationLanguageSelect.value });
  });

  geminiModelSelect.addEventListener('change', () => {
    const model = geminiModelSelect.value;
    saveSettings({ geminiModel: model });
    updateCustomGeminiModelFieldState(model);
    if (model !== 'custom') {
        customGeminiModelInput.value = '';
        saveSettings({ customGeminiModel: '' });
    }
    // Сообщаем content script, если это важно для него (сейчас не используется напрямую content script'ом)
    // sendMessageToContentScript({ command: "geminiModelChanged", model: model, customModel: customGeminiModelInput.value });
  });

  customGeminiModelInput.addEventListener('input', () => {
    if (geminiModelSelect.value === 'custom') {
        saveSettings({ customGeminiModel: customGeminiModelInput.value });
        // sendMessageToContentScript({ command: "geminiModelChanged", model: 'custom', customModel: customGeminiModelInput.value });
    }
  });

  // --- Обработчики событий для автозамены ---
  autoReplaceRulesTextarea.addEventListener('input', () => {
    saveSettings({ autoReplaceRules: autoReplaceRulesTextarea.value });
    sendMessageToContentScript({ command: "autoReplaceRulesChanged", rules: autoReplaceRulesTextarea.value });
  });

  // --- Обработчики событий для черного списка ---
  blacklistSitesTextarea.addEventListener('input', () => {
    saveSettings({ blacklistSites: blacklistSitesTextarea.value });
    sendMessageToContentScript({ command: "blacklistChanged", blacklist: blacklistSitesTextarea.value });
  });


  // --- Слушатель сообщений от других частей расширения (например, от background или content) ---
  // Это понадобится, когда content.js будет отправлять текст для генерации промпта,
  // или когда background.js вернет сгенерированный промпт.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // console.log("SVI Popup: Message received in popup", request); // DEBUG
    if (request.command === "displayGeneratedPrompt") {
      if (request.prompt) {
        generatedPromptTextarea.value = request.prompt;
        // Если включена авто-вставка, отправляем команду в content script
        if (autoInsertGeneratedPromptCheckbox.checked) {
          sendMessageToContentScript({
            command: "insertGeneratedPrompt",
            promptToInsert: request.prompt
          });
        }
      } else if (request.error) {
        generatedPromptTextarea.value = `Ошибка генерации промпта: ${request.error}`;
      }
      sendResponse({status: "prompt_displayed_or_error"});
    } else if (request.command === "userIdeasForPromptCollected") {
        // Это сообщение придет от content.js с текстом пользователя
        // console.log("SVI Popup: User ideas collected by content script:", request.userText); // DEBUG
        if (request.userText && request.userText.trim()) {
            generatePromptWithGemini(request.userText.trim());
        }
        sendResponse({status: "ideas_received_by_popup"});
    }
    return true; // Для асинхронного sendResponse, если понадобится
  });

  /**
   * Отправляет текст пользователя в Gemini для генерации улучшенного промпта.
   * @param {string} userText - Текст, надиктованный пользователем.
   */
  async function generatePromptWithGemini(userText) {
    generatedPromptTextarea.value = "Генерация промпта..."; // Индикация процесса
    const apiKey = geminiApiKeyInput.value;
    if (!apiKey) {
      generatedPromptTextarea.value = "Ошибка: API ключ Gemini не указан в настройках.";
      updateIndicatorState(IndicatorState.IDLE); // Используем наш индикатор из content.js, если бы он был здесь
      return;
    }

    const currentModel = geminiModelSelect.value === 'custom' && customGeminiModelInput.value.trim()
                       ? customGeminiModelInput.value.trim()
                       : geminiModelSelect.value;

    const metaPrompt = `Ты — эксперт по составлению эффективных промптов для больших языковых моделей. Пользователь предоставит тебе набор идей, ключевых слов или сырое описание задачи. Твоя задача — преобразовать этот ввод в четкий, структурированный, подробный и оптимизированный промпт, который можно будет использовать для получения наилучшего результата от языковой модели (например, от тебя же или другой модели Gemini/GPT). Промпт должен быть сформулирован так, чтобы максимально раскрыть возможности модели для решения исходной задачи пользователя. Учитывай возможные неясности во вводе пользователя и старайся их прояснить в генерируемом промпте, предлагая конкретику. Выведи только сгенерированный промпт, без каких-либо дополнительных комментариев или объяснений с твоей стороны.

Вот ввод пользователя:
"${userText}"`;

    // console.log("SVI Popup: Sending to Gemini for prompt generation. Model:", currentModel, "MetaPrompt:", metaPrompt); // DEBUG

    // ВАЖНО: Прямой fetch из popup может быть заблокирован Content Security Policy (CSP)
    // Для API вызовов лучше использовать background script.
    // Пока что делаем прямой вызов для простоты, но это нужно будет перенести.
    // Для этого popup отправит сообщение в background, а background вернет результат.

    try {
        // Сообщение в background для выполнения API запроса
        chrome.runtime.sendMessage(
            {
                command: "generatePromptViaGemini",
                apiKey: apiKey,
                model: currentModel,
                userContentForPrompt: metaPrompt // Это уже мета-промпт с текстом пользователя
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error("SVI Popup: Error sending message to background for Gemini:", chrome.runtime.lastError.message);
                    generatedPromptTextarea.value = `Ошибка связи с background: ${chrome.runtime.lastError.message}`;
                    return;
                }
                if (response) {
                    if (response.success && response.generatedText) {
                        generatedPromptTextarea.value = response.generatedText;
                        if (autoInsertGeneratedPromptCheckbox.checked) {
                            sendMessageToContentScript({
                                command: "insertGeneratedPrompt",
                                promptToInsert: response.generatedText
                            });
                        }
                    } else {
                        generatedPromptTextarea.value = `Ошибка от Gemini: ${response.error || 'Неизвестная ошибка'}`;
                    }
                } else {
                     generatedPromptTextarea.value = "Не получен ответ от background script.";
                }
            }
        );

    } catch (error) {
        console.error("SVI Popup: Error in generatePromptWithGemini (catch):", error);
        generatedPromptTextarea.value = `Внутренняя ошибка popup: ${error.message}`;
    }
  }
});