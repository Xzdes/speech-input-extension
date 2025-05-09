/**
 * @file content.js
 * @description Handles speech recognition, text insertion, translation,
 * auto-replacement, and other core functionalities on web pages.
 */

// --- Глобальные переменные и состояние ---
let recognition;
let currentFocusedInput = null;
let isDictationGloballyActive = true; // Глобальное состояние из storage (вкл/выкл всего расширения)
let isRecognitionActuallyRunning = false; // Флаг, что Web Speech API действительно слушает
let currentLang = 'ru-RU';
let recognitionRestartTimer = null;
let lastActivityTime = Date.now(); // Для отслеживания пауз в речи

// Настройки из chrome.storage
let settings = {
  dictationActive: true, // Это тот же isDictationGloballyActive, но хранится в settings для удобства
  dictationLang: 'ru-RU',
  translationActive: false,
  geminiApiKey: '',
  translationLang: 'en',
  geminiModel: 'gemini-1.5-flash-latest',
  customGeminiModel: '',
  autoReplaceRules: '',
  blacklistSites: ''
};

let parsedAutoReplaceRules = [];
let parsedBlacklistSites = [];

const RECOGNITION_TIMEOUT_MS = 30000; // Таймаут для перезапуска распознавания при тишине (30 секунд)
const GEMINI_API_ENDPOINT_PREFIX = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_API_ENDPOINT_SUFFIX = ":generateContent?key=";


// --- Инициализация ---

/**
 * Проверяет, находится ли текущий URL в черном списке.
 * @returns {boolean} True, если сайт в черном списке, иначе false.
 */
function isOnBlacklist() { // ИСПРАВЛЕНО ЗДЕСЬ
  if (!parsedBlacklistSites || parsedBlacklistSites.length === 0) {
    return false;
  }
  const currentUrl = window.location.href;
  return parsedBlacklistSites.some(sitePattern => currentUrl.includes(sitePattern));
}

/**
 * Загружает все настройки из chrome.storage.sync и инициализирует скрипт.
 */
async function loadSettingsAndInitialize() {
  try {
    const loadedSettings = await new Promise((resolve) => {
      chrome.storage.sync.get(null, (items) => { // null загружает все элементы
        resolve(items);
      });
    });

    // Обновляем локальный объект settings значениями по умолчанию, если что-то отсутствует
    settings = {
        dictationActive: loadedSettings.dictationActive !== undefined ? loadedSettings.dictationActive : true,
        dictationLang: loadedSettings.dictationLang || 'ru-RU',
        translationActive: loadedSettings.translationActive || false,
        geminiApiKey: loadedSettings.geminiApiKey || '',
        translationLang: loadedSettings.translationLang || 'en',
        geminiModel: loadedSettings.geminiModel || 'gemini-1.5-flash-latest',
        customGeminiModel: loadedSettings.customGeminiModel || '',
        autoReplaceRules: loadedSettings.autoReplaceRules || '',
        blacklistSites: loadedSettings.blacklistSites || ''
    };

    isDictationGloballyActive = settings.dictationActive;
    currentLang = settings.dictationLang;

    parseAutoReplaceRules(settings.autoReplaceRules);
    parseBlacklistSites(settings.blacklistSites);

    console.log('Content Script: Settings loaded and parsed:', settings);

    if (isOnBlacklist()) {
      console.log('Content Script: Current site is blacklisted. Dictation disabled for this page.');
      return; // Не продолжаем инициализацию, если сайт в черном списке
    }

    // Если при загрузке скрипта диктовка включена и есть активное поле
    if (isDictationGloballyActive && document.activeElement && isEditable(document.activeElement)) {
      currentFocusedInput = document.activeElement;
      // Не запускаем сразу, дадим focusin обработчику это сделать, чтобы избежать дублирования
      // startRecognition(currentFocusedInput);
    }
    initializeEventListeners(); // Инициализируем слушатели событий один раз

  } catch (error) {
    console.error('Content Script: Error loading settings:', error);
  }
}

/**
 * Парсит правила автозамены из строки в массив объектов.
 * @param {string} rulesString - Строка с правилами.
 */
function parseAutoReplaceRules(rulesString) {
  parsedAutoReplaceRules = [];
  if (rulesString && typeof rulesString === 'string') {
    const lines = rulesString.split('\n');
    lines.forEach(line => {
      const parts = line.split(':');
      if (parts.length === 2) {
        const key = parts[0].trim();
        const value = parts[1].trim().replace(/\\n/g, '\n'); // Поддержка \n для новой строки
        if (key) { // Ключ не должен быть пустым
          parsedAutoReplaceRules.push({ key, value, regex: new RegExp(escapeRegExp(key), 'gi') });
        }
      }
    });
  }
}

/**
 * Парсит черный список сайтов из строки в массив строк.
 * @param {string} blacklistString - Строка с сайтами.
 */
function parseBlacklistSites(blacklistString) {
  parsedBlacklistSites = [];
  if (blacklistString && typeof blacklistString === 'string') {
    parsedBlacklistSites = blacklistString.split('\n')
      .map(site => site.trim())
      .filter(site => site.length > 0);
  }
}

/**
 * Экранирует специальные символы для использования в RegExp.
 * @param {string} string - Исходная строка.
 * @returns {string} Экранированная строка.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& означает всю совпавшую строку
}

// --- Слушатели сообщений и событий ---

let listenersInitialized = false;
function initializeEventListeners() {
    if (listenersInitialized) return;

    chrome.runtime.onMessage.addListener(handleMessages);
    document.addEventListener('focusin', handleFocusIn, true); // Используем capturing phase
    document.addEventListener('focusout', handleFocusOut, true); // Используем capturing phase
    window.addEventListener('beforeunload', handleBeforeUnload);

    listenersInitialized = true;
    console.log("Content Script: Event listeners initialized.");
}


/**
 * Обрабатывает сообщения от других частей расширения (popup, background).
 */
function handleMessages(request, sender, sendResponse) {
  if (isOnBlacklist() && request.command !== "blacklistChanged") { // Если сайт в ЧС, игнорируем почти все команды
      // Однако, если пришло обновление ЧС, его нужно обработать, чтобы сайт мог выйти из ЧС
      if (request.command === "blacklistChanged") {
           settings.blacklistSites = request.blacklist;
           parseBlacklistSites(settings.blacklistSites);
           console.log('Content Script: Blacklist updated on a currently blacklisted page. Re-evaluating...');
           if (!isOnBlacklist()) {
               console.log('Content Script: Page is no longer blacklisted. Re-initializing (manual refresh might be needed for full effect).');
               // Тут можно попробовать перезапустить логику, если это безопасно,
               // но обычно проще попросить пользователя обновить страницу.
               // Для простоты, не будем автоматически перезапускать все.
           }
      }
      sendResponse({ status: "ok", info: "Site is blacklisted, command ignored (except blacklistChanged)" });
      return true;
  }

  console.log('Content Script: Message received:', request);
  let needsRestart = false;

  switch (request.command) {
    case 'toggleDictation':
      isDictationGloballyActive = request.data;
      settings.dictationActive = request.data;
      if (!isDictationGloballyActive && isRecognitionActuallyRunning) {
        stopRecognition();
      } else if (isDictationGloballyActive && currentFocusedInput && !isRecognitionActuallyRunning) {
        startRecognition(currentFocusedInput);
      }
      sendResponse({ status: 'ok', newDictationState: isDictationGloballyActive });
      break;

    case 'languageChanged':
      currentLang = request.newLang;
      settings.dictationLang = request.newLang;
      if (isRecognitionActuallyRunning) needsRestart = true;
      sendResponse({ status: 'language update processed' });
      break;

    case 'translationStateChanged':
      settings.translationActive = request.translationActive;
      // Не требует немедленного перезапуска, применится при следующем распознавании
      sendResponse({ status: 'translation state updated' });
      break;

    case 'translationLangChanged':
      settings.translationLang = request.newLang;
      sendResponse({ status: 'translation language updated' });
      break;

    case 'geminiModelChanged':
      settings.geminiModel = request.model;
      settings.customGeminiModel = request.customModel;
      sendResponse({ status: 'gemini model updated'});
      break;

    case 'autoReplaceRulesChanged':
      settings.autoReplaceRules = request.rules;
      parseAutoReplaceRules(settings.autoReplaceRules);
      sendResponse({ status: 'auto replace rules updated' });
      break;

    case 'blacklistChanged':
      settings.blacklistSites = request.blacklist;
      parseBlacklistSites(settings.blacklistSites);
      sendResponse({ status: 'blacklist updated' });
      // Если текущий сайт только что попал в черный список, останавливаем диктовку
      if (isOnBlacklist() && isRecognitionActuallyRunning) {
        stopRecognition();
        console.log('Content Script: Current site added to blacklist. Dictation stopped.');
      }
      break;

    default:
      sendResponse({ status: 'unknown command' });
      break;
  }

  if (needsRestart && currentFocusedInput && isDictationGloballyActive) {
    console.log('Content Script: Restarting recognition due to settings change.');
    stopRecognition(() => { // Передаем колбэк для старта после полной остановки
        startRecognition(currentFocusedInput);
    });
  }
  return true; // Для асинхронного sendResponse
}

/**
 * Обработчик события фокуса на элементе.
 */
function handleFocusIn(event) {
  if (isOnBlacklist()) return;

  const target = event.target;
  if (isEditable(target)) {
    if (target.type === 'password') {
        if (isRecognitionActuallyRunning && currentFocusedInput === target) {
            stopRecognition(); // Остановить если случайно запустилось на поле пароля
        }
        currentFocusedInput = null; // Не работаем с полями пароля
        return;
    }

    console.log('Content Script: Focus on editable element:', target);
    currentFocusedInput = target;
    // Улучшенный индикатор фокуса (более заметный)
    target.style.outline = '2px solid #4CAF50'; // Ярко-зеленый контур
    target.style.outlineOffset = '2px';

    if (isDictationGloballyActive && !isRecognitionActuallyRunning) {
      // Небольшая задержка перед стартом, чтобы избежать ложных срабатываний при быстрой смене фокуса
      setTimeout(() => {
        // Проверяем, что фокус все еще здесь и диктовка все еще активна
        if (currentFocusedInput === target && isDictationGloballyActive && !isRecognitionActuallyRunning) {
          startRecognition(target);
        }
      }, 150);
    }
  }
}

/**
 * Обработчик события потери фокуса элементом.
 */
function handleFocusOut(event) {
  // Не проверяем isOnBlacklist здесь, т.к. нужно убрать стиль в любом случае
  const target = event.target;
  if (target === currentFocusedInput) {
    console.log('Content Script: Focus lost from:', target);
    target.style.outline = ''; // Убираем контур
    target.style.boxShadow = ''; // Убираем и старый boxShadow на всякий случай

    // Не останавливаем распознавание немедленно, если continuous=true,
    // API может сам справиться с короткой потерей фокуса или перезапуститься.
    // Но если пользователь явно ушел с поля надолго, то onend должен сработать.
    // Однако, если мы хотим более агрессивно останавливать, можно раскомментировать:
    /*
    if (isRecognitionActuallyRunning) {
      stopRecognition();
    }
    currentFocusedInput = null; // Сбрасываем, только если реально ушли
    */
    // Вместо этого, позволим onend обработать остановку, если она не была вызвана переключением на другой input
  }
}

/**
 * Обработчик события закрытия/перезагрузки страницы.
 */
function handleBeforeUnload() {
  if (isRecognitionActuallyRunning) {
    stopRecognition();
  }
}

// --- Логика распознавания речи ---

/**
 * Проверяет, является ли элемент редактируемым.
 * @param {HTMLElement} element - Элемент для проверки.
 * @returns {boolean} True, если элемент редактируемый.
 */
function isEditable(element) {
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  const type = element.type ? element.type.toLowerCase() : '';

  return (
    (tagName === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit', 'password'].includes(type)) ||
    tagName === 'textarea' ||
    element.isContentEditable
  ) && !element.disabled && !element.readOnly;
}

/**
 * Запускает распознавание речи.
 * @param {HTMLElement} targetElement - Элемент, в который будет вставляться текст.
 */
function startRecognition(targetElement) {
  if (isOnBlacklist() || !isDictationGloballyActive || !targetElement || isRecognitionActuallyRunning) {
    if (isRecognitionActuallyRunning) console.warn("Content Script: Recognition already running.");
    return;
  }

  if (!('webkitSpeechRecognition' in window)) {
    console.error("Content Script: Speech Recognition API не поддерживается.");
    // Можно уведомить пользователя, но alert может быть навязчивым
    // chrome.runtime.sendMessage({ command: "showNotification", message: "Голосовой ввод не поддерживается в вашем браузере." });
    return;
  }

  clearTimeout(recognitionRestartTimer);
  lastActivityTime = Date.now();

  recognition = new webkitSpeechRecognition();
  recognition.lang = currentLang;
  recognition.continuous = true; // Важно для длительной диктовки
  recognition.interimResults = true; // Включаем промежуточные результаты

  console.log(`Content Script: Starting recognition for lang "${currentLang}" on element:`, targetElement);

  recognition.onstart = () => {
    isRecognitionActuallyRunning = true;
    console.log("Content Script: Recognition started.");
    if (currentFocusedInput) { // Убедимся, что элемент еще существует
        currentFocusedInput.style.boxShadow = "0 0 8px 3px rgba(76, 175, 80, 0.7)"; // Более заметный индикатор (зеленый)
    }
    lastActivityTime = Date.now();
  };

  recognition.onresult = async (event) => {
    lastActivityTime = Date.now();
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const transcriptPart = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcriptPart;
      } else {
        interimTranscript += transcriptPart;
      }
    }

    // Отображение промежуточных результатов (опционально, можно сделать более аккуратно)
    // Например, показывать их в отдельном временном элементе над полем ввода.
    // Пока просто логируем.
    if (interimTranscript.trim()) {
        // console.log('Interim:', interimTranscript);
        // Можно добавить визуальный эффект для interim, например, изменение цвета рамки
        if (currentFocusedInput) currentFocusedInput.style.boxShadow = "0 0 8px 3px rgba(255, 165, 0, 0.7)"; // Оранжевый для interim
    }


    if (finalTranscript.trim()) {
        if (currentFocusedInput) currentFocusedInput.style.boxShadow = "0 0 8px 3px rgba(76, 175, 80, 0.7)"; // Возвращаем зеленый
        console.log('Content Script: Final transcript:', finalTranscript);
        await processFinalTranscript(finalTranscript.trim(), targetElement);
    }
  };

  recognition.onerror = (event) => {
    isRecognitionActuallyRunning = false;
    console.error("Content Script: Recognition error:", event.error, event.message);
    if (currentFocusedInput) currentFocusedInput.style.boxShadow = "0 0 8px 3px rgba(255, 0, 0, 0.7)"; // Красный индикатор ошибки

    if (event.error === 'no-speech') {
        console.warn("Content Script: No speech detected.");
        // Перезапуск будет обработан в onend, если continuous=true
    } else if (event.error === 'audio-capture') {
        console.warn("Content Script: Audio capture error. Microphone issue?");
        // Возможно, стоит уведомить пользователя
    } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        console.warn("Content Script: Microphone access denied or service not allowed.");
        isDictationGloballyActive = false; // Выключаем, чтобы не пытаться снова
        settings.dictationActive = false;
        chrome.storage.sync.set({ dictationActive: false }); // Обновит иконку и popup
        // Здесь можно также отправить сообщение в popup, если он открыт, или показать уведомление
        // alert("Доступ к микрофону запрещен. Пожалуйста, разрешите доступ и перезагрузите страницу или расширение.");
    } else if (event.error === 'network') {
        console.warn("Content Script: Network error during recognition.");
    }
    // onend будет вызван после onerror, он обработает перезапуск, если нужно
  };

  recognition.onend = () => {
    console.log("Content Script: Recognition ended.");
    const wasActuallyRunning = isRecognitionActuallyRunning; // Сохраняем состояние перед сбросом
    isRecognitionActuallyRunning = false;
    if (currentFocusedInput) currentFocusedInput.style.boxShadow = ""; // Снять любой индикатор

    // Логика перезапуска:
    // Перезапускаем, если:
    // 1. Диктовка глобально активна (isDictationGloballyActive).
    // 2. Распознавание было действительно запущено (wasActuallyRunning), а не просто вызов onend после stopRecognition().
    // 3. Свойство `recognition.continuous` было true (оно устанавливается в true при старте).
    //    `recognition` объект может быть уже null, если stopRecognition был вызван с коллбеком.
    //    Поэтому проверяем wasActuallyRunning и isDictationGloballyActive.
    // 4. Текущий элемент ввода все еще в фокусе.
    // 5. Ошибка не была 'not-allowed' или 'service-not-allowed', которые отключают диктовку.
    // 6. Не было явного вызова stopRecognition(), который бы сбросил `recognition.continuous = false` (но мы не можем это проверить здесь напрямую после того как recognition.stop() отработал)

    const lastError = recognition ? recognition.lastError : null; // Гипотетическое свойство, в стандарте нет
                                                                // Лучше ориентироваться на флаги, установленные в onerror

    if (isDictationGloballyActive && wasActuallyRunning && currentFocusedInput &&
        (lastError !== 'not-allowed' && lastError !== 'service-not-allowed')) { // Упрощенная проверка

      const timeSinceLastActivity = Date.now() - lastActivityTime;
      if (timeSinceLastActivity < RECOGNITION_TIMEOUT_MS) { // Если была активность недавно
        console.log("Content Script: Continuous mode: Re-starting recognition after short delay.");
        clearTimeout(recognitionRestartTimer);
        recognitionRestartTimer = setTimeout(() => {
          // Дополнительная проверка состояния перед перезапуском
          if (isDictationGloballyActive && currentFocusedInput && !isRecognitionActuallyRunning) {
            startRecognition(currentFocusedInput);
          }
        }, 250); // Короткая задержка
      } else {
        console.log("Content Script: Recognition timed out due to inactivity. Not restarting automatically.");
        // Можно показать пользователю сообщение о таймауте
      }
    } else {
      console.log("Content Script: Recognition will not be restarted automatically.");
    }
    recognition = null; // Освобождаем объект
  };

  try {
    recognition.start();
  } catch (e) {
    isRecognitionActuallyRunning = false;
    console.error("Content Script: Failed to start recognition:", e);
    if (currentFocusedInput) currentFocusedInput.style.boxShadow = "0 0 8px 3px rgba(255, 0, 0, 0.7)";
  }
}

/**
 * Останавливает распознавание речи.
 * @param {function} [callback] - Функция, которая будет вызвана после фактической остановки распознавания (в onend).
 */
function stopRecognition(callback) {
  clearTimeout(recognitionRestartTimer);
  if (recognition) {
    recognition.continuous = false; // Предотвращаем автоматический перезапуск в onend
    try {
      recognition.stop(); // onend будет вызван асинхронно
      console.log("Content Script: Recognition stop requested.");
      // isRecognitionActuallyRunning будет сброшен в onend
      // recognition = null; // Не здесь, а в onend, чтобы обработчик отработал
    } catch (e) {
        console.warn("Content Script: Error trying to stop recognition (already stopped?):", e);
        isRecognitionActuallyRunning = false;
        if (currentFocusedInput) currentFocusedInput.style.boxShadow = "";
        recognition = null;
    }
  } else {
    console.log("Content Script: No active recognition to stop.");
  }
  // Если есть коллбэк, он будет вызван после того, как onend отработает,
  // но в данном случае нет простого способа передать коллбэк в onend из этой функции.
  // Поэтому, если коллбэк нужен, его следует вызывать сразу или предусмотреть более сложную логику.
  // Для перезапуска после смены языка, мы делаем это из handleMessages.
  if (callback) {
      // Даем немного времени для асинхронной остановки
      setTimeout(callback, 100); // Не очень надежно, но просто для примера
  }
}


// --- Обработка и вставка текста ---

/**
 * Обрабатывает финальный распознанный текст: применяет автозамену, команды, перевод.
 * @param {string} text - Распознанный текст.
 * @param {HTMLElement} targetElement - Элемент для вставки.
 */
async function processFinalTranscript(text, targetElement) {
  let processedText = text;

  // 1. Проверка на команды форматирования
  const commandProcessed = processFormattingCommands(processedText.toLowerCase(), targetElement);
  if (commandProcessed) {
    return; // Команда выполнена, текст не вставляем
  }

  // 2. Автозамена
  processedText = applyAutoReplace(processedText);

  // 3. Перевод (если активен и API ключ есть)
  if (settings.translationActive && settings.geminiApiKey) {
    try {
      if (currentFocusedInput) currentFocusedInput.style.boxShadow = "0 0 8px 3px rgba(0, 0, 255, 0.7)"; // Синий - перевод
      processedText = await translateTextGemini(processedText, settings.dictationLang, settings.translationLang, settings.geminiApiKey);
      if (currentFocusedInput) currentFocusedInput.style.boxShadow = "0 0 8px 3px rgba(76, 175, 80, 0.7)"; // Зеленый после перевода
    } catch (error) {
      console.error("Content Script: Translation error:", error);
      // Можно показать уведомление пользователю
      if (currentFocusedInput) currentFocusedInput.style.boxShadow = "0 0 8px 3px rgba(255, 100, 0, 0.7)"; // Оранжево-красный - ошибка перевода
      // Вставляем оригинальный текст в случае ошибки перевода
    }
  }

  // 4. Вставка текста
  if (processedText.trim()) { // Убедимся, что есть что вставлять
    insertText(targetElement, processedText + ' '); // Добавляем пробел для удобства
  }
}

/**
 * Применяет правила автозамены к тексту.
 * @param {string} text - Исходный текст.
 * @returns {string} Текст после автозамены.
 */
function applyAutoReplace(text) {
  if (!parsedAutoReplaceRules || parsedAutoReplaceRules.length === 0) {
    return text;
  }
  let resultText = text;
  parsedAutoReplaceRules.forEach(rule => {
    // Заменяем все вхождения (с учетом регистра из-за флага 'i' в regex)
    resultText = resultText.replace(rule.regex, rule.value);
  });
  if (text !== resultText) console.log(`Content Script: Auto-replaced "${text}" -> "${resultText}"`);
  return resultText;
}

/**
 * Обрабатывает команды форматирования.
 * @param {string} textLC - Распознанный текст в нижнем регистре.
 * @param {HTMLElement} targetElement - Элемент, к которому применяется команда.
 * @returns {boolean} True, если команда была распознана и обработана.
 */
function processFormattingCommands(textLC, targetElement) {
  // Простые команды. Можно расширить список.
  // Ключевые слова должны быть уникальны и не пересекаться с обычными словами.
  const commands = {
    "новая строка": () => insertText(targetElement, '\n'),
    "абзац": () => insertText(targetElement, '\n\n'), // Для примера
    "удалить слово": () => deleteLastWord(targetElement),
    "удалить всё": () => clearInput(targetElement),
    // "стоп диктовка": () => { // Эту команду лучше через горячую клавишу или UI
    //   isDictationGloballyActive = false;
    //   settings.dictationActive = false;
    //   chrome.storage.sync.set({ dictationActive: false });
    //   stopRecognition();
    // }
  };

  for (const commandPhrase in commands) {
    // Ищем точное совпадение фразы (можно сделать более гибко)
    if (textLC === commandPhrase) {
      console.log(`Content Script: Executing command: "${commandPhrase}"`);
      commands[commandPhrase]();
      return true;
    }
  }
  return false;
}

/**
 * Удаляет последнее слово из поля ввода.
 * @param {HTMLElement} element - Поле ввода.
 */
function deleteLastWord(element) {
    const isContentEditable = element.isContentEditable;
    let value = isContentEditable ? element.textContent : element.value;
    const originalLength = value.length;

    // Удаляем пробелы в конце, чтобы найти реальное последнее слово
    value = value.replace(/\s+$/, '');
    const lastSpaceIndex = value.lastIndexOf(' ');

    if (lastSpaceIndex !== -1) {
        value = value.substring(0, lastSpaceIndex + 1); // Оставляем пробел после предыдущего слова
    } else {
        value = ''; // Если это единственное слово или нет пробелов
    }

    const charsToRemove = originalLength - value.length;

    if (isContentEditable) {
        // Для contentEditable это сложнее, т.к. нужно управлять Selection API
        // Простой вариант: выделить и удалить
        // document.execCommand('selectAll', false, null); // Это может быть слишком грубо, если текст большой
        // Более точный вариант:
        const selection = window.getSelection();
        if (selection.rangeCount > 0 && (element.contains(selection.anchorNode) || selection.anchorNode === element) ) {
             // Пытаемся удалить символы с конца текущей позиции курсора или выделения
             // Это очень упрощенно и может работать не всегда корректно
             // Для contentEditable лучше работать с selection.modify или Range.deleteContents
            let currentText = element.textContent;
            if (currentText.length > 0) {
                let textBeforeCursor = currentText.substring(0, selection.anchorOffset); // текст до курсора
                let textAfterCursor = currentText.substring(selection.focusOffset); // текст после курсора (или после выделения)

                textBeforeCursor = textBeforeCursor.trimEnd(); // убираем пробелы в конце
                const lastSpace = textBeforeCursor.lastIndexOf(' ');
                if (lastSpace !== -1) {
                    textBeforeCursor = textBeforeCursor.substring(0, lastSpace + 1);
                } else {
                    textBeforeCursor = '';
                }
                element.textContent = textBeforeCursor + textAfterCursor;
                // Попытка восстановить курсор (очень приблизительно)
                const newOffset = textBeforeCursor.length;
                const range = document.createRange();
                const sel = window.getSelection();
                // Убедимся, что у узла есть дочерние текстовые узлы или сам он текстовый узел
                if (element.firstChild && element.firstChild.nodeType === Node.TEXT_NODE) {
                     range.setStart(element.firstChild, Math.min(newOffset, element.firstChild.length));
                } else if (element.nodeType === Node.TEXT_NODE) {
                     range.setStart(element, Math.min(newOffset, element.length));
                } else {
                    // Если нет текстовых узлов, или они вложены глубже, это усложняется
                    // Пока оставляем как есть, пользователь может кликнуть для установки курсора
                    range.selectNodeContents(element); // Выделит все, если не удалось точно
                    range.collapse(true); // Схлопнуть в начало
                }
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }

        } else {
            // Если нет выделения внутри элемента, просто заменяем текст
            element.textContent = value;
        }

    } else { // input или textarea
        const currentVal = element.value;
        const selStart = element.selectionStart;
        const selEnd = element.selectionEnd;

        let textBeforeSelection = currentVal.substring(0, selStart);
        const textAfterSelection = currentVal.substring(selEnd);

        textBeforeSelection = textBeforeSelection.trimEnd();
        const lastSpace = textBeforeSelection.lastIndexOf(' ');

        if (lastSpace !== -1) {
            textBeforeSelection = textBeforeSelection.substring(0, lastSpace + 1);
        } else {
            textBeforeSelection = '';
        }
        element.value = textBeforeSelection + textAfterSelection;
        element.selectionStart = element.selectionEnd = textBeforeSelection.length;
    }

    // Инициировать событие input
    const event = new Event('input', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
}


/**
 * Очищает поле ввода.
 * @param {HTMLElement} element - Поле ввода.
 */
function clearInput(element) {
    if (element.isContentEditable) {
        element.innerHTML = '';
    } else {
        element.value = '';
    }
    const event = new Event('input', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
}


/**
 * Вставляет текст в указанный элемент.
 * @param {HTMLElement} element - Целевой элемент (input, textarea, contentEditable).
 * @param {string} textToInsert - Текст для вставки.
 */
function insertText(element, textToInsert) {
  if (!element) return;

  if (element.isContentEditable) {
    // Для contentEditable используем execCommand или Selection API для лучшей интеграции с WYSIWYG
    document.execCommand('insertText', false, textToInsert);
  } else if (typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
    // Для input/textarea
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const M_val = element.value;
    element.value = M_val.substring(0, start) + textToInsert + M_val.substring(end);
    element.selectionStart = element.selectionEnd = start + textToInsert.length;
  } else { // Fallback, если selectionStart/End не доступны
    element.value += textToInsert;
  }
  // Инициировать событие input, чтобы фреймворки (React, Vue, Angular) среагировали
  const event = new Event('input', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  element.focus(); // Иногда фокус может теряться после программной вставки
}

// --- Интеграция с Gemini API для перевода ---

/**
 * Переводит текст с помощью Gemini API.
 * @param {string} text - Текст для перевода.
 * @param {string} sourceLang - Исходный язык (например, 'ru-RU' или просто 'ru').
 * @param {string} targetLang - Целевой язык (например, 'en').
 * @param {string} apiKey - Gemini API ключ.
 * @returns {Promise<string>} Промис с переведенным текстом.
 */
async function translateTextGemini(text, sourceLang, targetLang, apiKey) {
  if (!text || !apiKey) {
    return Promise.reject("Текст или API ключ отсутствуют для перевода.");
  }

  // Упрощаем код языка (например, 'ru-RU' -> 'русского') для промпта
  const sourceLangName = getLanguageNameForPrompt(sourceLang);
  const targetLangName = getLanguageNameForPrompt(targetLang);

  const modelToUse = (settings.geminiModel === 'custom' && settings.customGeminiModel) ?
                       settings.customGeminiModel :
                       settings.geminiModel;

  const apiUrl = `${GEMINI_API_ENDPOINT_PREFIX}${modelToUse}${GEMINI_API_ENDPOINT_SUFFIX}${apiKey}`;

  // Формируем промпт для Gemini
  // Промпт можно улучшать для более точных переводов
  const prompt = `Переведи следующий текст с ${sourceLangName} языка на ${targetLangName} язык. Выведи только переведенный текст, без каких-либо дополнительных комментариев или объяснений.\n\nТекст для перевода:\n"${text}"`;
  console.log("Content Script: Gemini API Prompt:", prompt);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        // Дополнительные параметры генерации, если нужны (temperature, topK, topP)
        // generationConfig: {
        //   temperature: 0.7,
        //   topK: 1,
        //   topP: 1,
        //   maxOutputTokens: 2048,
        // }
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: "Failed to parse error response" } }));
      console.error("Content Script: Gemini API Error Response:", errorData);
      throw new Error(`Gemini API request failed: ${response.status} ${response.statusText}. ${errorData.error?.message || ''}`);
    }

    const data = await response.json();
    console.log("Content Script: Gemini API Success Response:", data);

    if (data.candidates && data.candidates.length > 0 &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts.length > 0 && data.candidates[0].content.parts[0].text) {
      return data.candidates[0].content.parts[0].text.trim();
    } else if (data.promptFeedback && data.promptFeedback.blockReason) {
        console.error("Content Script: Gemini API - Prompt blocked:", data.promptFeedback.blockReason, data.promptFeedback.safetyRatings);
        throw new Error(`Gemini API: Prompt was blocked due to ${data.promptFeedback.blockReason}.`);
    }
    else {
      console.warn("Content Script: Gemini API - Unexpected response structure:", data);
      throw new Error("Не удалось извлечь переведенный текст из ответа Gemini API.");
    }
  } catch (error) {
    console.error("Content Script: Error during Gemini API call:", error);
    throw error; // Пробрасываем ошибку дальше
  }
}

/**
 * Возвращает имя языка в родительном падеже для использования в промпте.
 * @param {string} langCode - Код языка (например, 'ru-RU', 'en', 'de').
 * @returns {string} Имя языка.
 */
function getLanguageNameForPrompt(langCode) {
  const lang = langCode.split('-')[0].toLowerCase();
  switch (lang) {
    case 'ru': return 'русского';
    case 'en': return 'английского';
    case 'de': return 'немецкого';
    case 'fr': return 'французского';
    case 'es': return 'испанского';
    // Добавьте другие языки по необходимости
    default: return langCode; // Возвращаем код, если имя не найдено
  }
}

// --- Запуск ---
loadSettingsAndInitialize();

console.log("Content script loaded and potentially active.");