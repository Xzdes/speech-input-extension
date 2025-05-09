/**
 * @file popup.js
 * @description Handles the logic for the extension's popup window,
 * managing user settings and interactions.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Основные элементы управления
  const toggleDictationCheckbox = document.getElementById('toggleDictation');
  const languageSelect = document.getElementById('languageSelect');
  const hotkeyDisplay = document.getElementById('hotkeyDisplay');

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
    translationActive: false,
    geminiApiKey: '',
    translationLang: 'en',
    geminiModel: 'gemini-1.5-flash-latest',
    customGeminiModel: '',
    autoReplaceRules: '', // Пример: "запятая : ,\nточка : ."
    blacklistSites: ''   // Пример: "example.com\nanothersite.org"
  };

  /**
   * Загружает настройки из chrome.storage.sync и обновляет UI.
   */
  function loadSettings() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
      // Основные настройки
      toggleDictationCheckbox.checked = settings.dictationActive;
      languageSelect.value = settings.dictationLang;

      // Настройки перевода
      toggleTranslationCheckbox.checked = settings.translationActive;
      geminiApiKeyInput.value = settings.geminiApiKey;
      translationLanguageSelect.value = settings.translationLang;
      geminiModelSelect.value = settings.geminiModel;
      customGeminiModelInput.value = settings.customGeminiModel;

      updateTranslationFieldsState(settings.translationActive);
      updateCustomGeminiModelFieldState(settings.geminiModel);


      // Настройки автозамены
      autoReplaceRulesTextarea.value = settings.autoReplaceRules;

      // Настройки черного списка
      blacklistSitesTextarea.value = settings.blacklistSites;

      // Загрузка и отображение горячей клавиши
      loadHotkey();
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
        console.error('Popup: Error saving settings:', chrome.runtime.lastError);
      } else {
        console.log('Popup: Settings saved:', settingsToSave);
        if (callback) callback();
      }
    });
  }

  /**
   * Загружает и отображает назначенную горячую клавишу.
   */
  function loadHotkey() {
    if (chrome.commands) {
      chrome.commands.getAll((commands) => {
        const toggleCommand = commands.find(command => command.name === 'toggle-dictation');
        if (toggleCommand && toggleCommand.shortcut) {
          hotkeyDisplay.textContent = toggleCommand.shortcut;
        } else {
          hotkeyDisplay.textContent = 'Не назначена';
        }
      });
    } else {
      hotkeyDisplay.textContent = 'API команд недоступно';
    }
  }

  /**
   * Обновляет состояние полей, связанных с переводом, в зависимости от того, включен ли перевод.
   * @param {boolean} isTranslationActive - Активен ли перевод.
   */
  function updateTranslationFieldsState(isTranslationActive) {
    geminiApiKeyInput.disabled = !isTranslationActive;
    translationLanguageSelect.disabled = !isTranslationActive;
    geminiModelSelect.disabled = !isTranslationActive;
    if (isTranslationActive) {
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
    if (toggleTranslationCheckbox.checked && selectedModel === 'custom') {
        customModelLabel.style.display = 'flex';
        customGeminiModelInput.disabled = false;
    } else {
        customModelLabel.style.display = 'none';
        customGeminiModelInput.disabled = true;
    }
  }


  /**
   * Отправляет сообщение активной вкладке.
   * @param {object} message - Сообщение для отправки.
   */
  function sendMessageToContentScript(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          if (chrome.runtime.lastError) {
            // Ошибки типа "Receiving end does not exist" ожидаемы, если content_script не внедрен
            // на текущей странице (например, chrome://extensions) или еще не загрузился.
            if (chrome.runtime.lastError.message !== "Could not establish connection. Receiving end does not exist.") {
                 console.warn(`Popup: Error sending message ${message.command}:`, chrome.runtime.lastError.message);
            } else {
                console.log(`Popup: Message ${message.command} sent, but no content script on this page or not ready.`);
            }
          } else {
            console.log(`Popup: Message ${message.command} response:`, response);
          }
        });
      } else {
        console.warn('Popup: No active tab found to send message.');
      }
    });
  }

  // --- Инициализация ---
  loadSettings();

  // --- Обработчики событий для основных настроек ---
  toggleDictationCheckbox.addEventListener('change', () => {
    const isActive = toggleDictationCheckbox.checked;
    saveSettings({ dictationActive: isActive });
    // Сообщение в background.js (для обновления иконки) управляется через storage.onChanged.
    // Сообщение в content.js для немедленного применения:
    sendMessageToContentScript({ command: "toggleDictation", data: isActive });
  });

  languageSelect.addEventListener('change', () => {
    const lang = languageSelect.value;
    saveSettings({ dictationLang: lang });
    sendMessageToContentScript({ command: "languageChanged", newLang: lang });
  });

  // --- Обработчики событий для настроек перевода ---
  toggleTranslationCheckbox.addEventListener('change', () => {
    const isActive = toggleTranslationCheckbox.checked;
    saveSettings({ translationActive: isActive });
    updateTranslationFieldsState(isActive);
    // Сообщаем content script об изменении статуса перевода
    sendMessageToContentScript({ command: "translationStateChanged", translationActive: isActive });
  });

  geminiApiKeyInput.addEventListener('input', () => { // 'input' для немедленного сохранения при вводе
    saveSettings({ geminiApiKey: geminiApiKeyInput.value });
    // Можно добавить задержку (debounce), если не хотим сохранять на каждое нажатие
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
        // Если выбрана не "custom", очищаем и сохраняем поле customGeminiModel
        customGeminiModelInput.value = '';
        saveSettings({ customGeminiModel: '' });
    }
    sendMessageToContentScript({ command: "geminiModelChanged", model: model, customModel: customGeminiModelInput.value });
  });

  customGeminiModelInput.addEventListener('input', () => {
    if (geminiModelSelect.value === 'custom') {
        saveSettings({ customGeminiModel: customGeminiModelInput.value });
        sendMessageToContentScript({ command: "geminiModelChanged", model: 'custom', customModel: customGeminiModelInput.value });
    }
  });


  // --- Обработчики событий для автозамены ---
  autoReplaceRulesTextarea.addEventListener('input', () => {
    saveSettings({ autoReplaceRules: autoReplaceRulesTextarea.value });
    // Отправляем обновленные правила в content.js
    sendMessageToContentScript({ command: "autoReplaceRulesChanged", rules: autoReplaceRulesTextarea.value });
  });

  // --- Обработчики событий для черного списка ---
  blacklistSitesTextarea.addEventListener('input', () => {
    // Сохраняем, но это изменение в основном будет обрабатываться в background или content при следующей загрузке/проверке URL
    saveSettings({ blacklistSites: blacklistSitesTextarea.value });
    // Можно отправить сообщение для немедленного действия, если content.js может это обработать
    sendMessageToContentScript({ command: "blacklistChanged", blacklist: blacklistSitesTextarea.value });
  });
});