/**
 * @file content.js
 * @description Handles speech recognition, text insertion, translation,
 * auto-replacement, and other core functionalities on web pages.
 */

// --- Глобальные переменные и состояние ---
let recognition;
let currentFocusedInput = null;
let isDictationGloballyActive = true;
let isRecognitionActuallyRunning = false;
let currentLang = 'ru-RU';
let recognitionRestartTimer = null;
let lastActivityTime = Date.now();

let settings = {
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

let parsedAutoReplaceRules = [];
let parsedBlacklistSites = [];

const RECOGNITION_TIMEOUT_MS = 30000;
const RESTART_DELAY_MS = 50;
const FOCUS_DEBOUNCE_MS = 50;
const SCROLL_RESIZE_DEBOUNCE_MS = 150; // Для debounce позиционирования индикатора

const GEMINI_API_ENDPOINT_PREFIX = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_API_ENDPOINT_SUFFIX = ":generateContent?key=";

// --- Индикатор состояния ---
const INDICATOR_ID = 'speech-pro-indicator';
let indicatorElement = null;
const IndicatorState = {
  IDLE: 'IDLE', // Скрыт
  LISTENING: 'LISTENING', // Слушаю... 🎤
  PROCESSING: 'PROCESSING', // Обработка... ⚙️
  TRANSLATING: 'TRANSLATING', // Перевод... 🌍
};
let currentIndicatorState = IndicatorState.IDLE;
let indicatorUpdateTimer = null; // Для анимации точек
let dotCount = 0; // <--- ОБЪЯВЛЕНИЕ ПЕРЕМЕННОЙ

// --- Переменные для управления обработкой ---
let isProcessingTranscript = false;
let transcriptQueue = [];

// --- Утилита debounce ---
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}


// --- Инициализация ---
async function loadSettingsAndInitialize() {
  try {
    const loadedSettings = await new Promise((resolve) => {
      chrome.storage.sync.get(settings, (items) => { resolve(items); });
    });
    settings = { ...settings, ...loadedSettings };

    isDictationGloballyActive = settings.dictationActive;
    currentLang = settings.dictationLang;
    parseAutoReplaceRules(settings.autoReplaceRules);
    parseBlacklistSites(settings.blacklistSites);
    // console.log('Content Script: Settings loaded and parsed:', settings); // DEBUG

    if (isOnBlacklist()) {
      // console.log('Content Script: Current site is blacklisted. Extension inactive.'); // DEBUG
      return;
    }

    if (document.activeElement && isEditable(document.activeElement)) {
      currentFocusedInput = document.activeElement;
      if (isDictationGloballyActive && !isRecognitionActuallyRunning) {
        startRecognition(currentFocusedInput);
      }
    }
    initializeEventListeners();
  } catch (error) {
    console.error('Content Script: Error loading settings:', error);
  }
}

function isOnBlacklist() {
  if (!parsedBlacklistSites || parsedBlacklistSites.length === 0) { return false; }
  const currentUrl = window.location.href;
  return parsedBlacklistSites.some(sitePattern => currentUrl.includes(sitePattern));
}

function parseAutoReplaceRules(rulesString) {
  parsedAutoReplaceRules = [];
  if (rulesString && typeof rulesString === 'string') {
    const lines = rulesString.split('\n');
    lines.forEach(line => {
      const parts = line.split(':');
      if (parts.length === 2) {
        const key = parts[0].trim();
        const value = parts[1].trim().replace(/\\n/g, '\n');
        if (key) {
          parsedAutoReplaceRules.push({ key, value, regex: new RegExp(escapeRegExp(key), 'gi') });
        }
      }
    });
  }
}

function parseBlacklistSites(blacklistString) {
  parsedBlacklistSites = [];
  if (blacklistString && typeof blacklistString === 'string') {
    parsedBlacklistSites = blacklistString.split('\n')
      .map(site => site.trim())
      .filter(site => site.length > 0);
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Слушатели сообщений и событий ---
let listenersInitialized = false;
const debouncedPositionIndicator = debounce(() => positionIndicator(true), SCROLL_RESIZE_DEBOUNCE_MS);

function initializeEventListeners() {
    if (listenersInitialized) return;
    if (isOnBlacklist()) return;

    chrome.runtime.onMessage.addListener(handleMessages);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('scroll', debouncedPositionIndicator, true);
    window.addEventListener('resize', debouncedPositionIndicator, true);

    listenersInitialized = true;
    // console.log("Content Script: Event listeners initialized."); // DEBUG
}

function handleMessages(request, sender, sendResponse) {
  let initialBlacklistStatus = isOnBlacklist();
  if (initialBlacklistStatus && request.command !== "blacklistChanged") {
      sendResponse({ status: "ok", info: "Site is blacklisted" });
      return true;
  }
  // console.log('Content Script: Message received:', request); // DEBUG
  let needsRecognitionRestart = false;

  switch (request.command) {
    case 'toggleDictation':
      isDictationGloballyActive = request.data;
      settings.dictationActive = request.data;
      if (!isDictationGloballyActive && isRecognitionActuallyRunning) {
        stopRecognition();
      } else if (isDictationGloballyActive && currentFocusedInput && !isRecognitionActuallyRunning) {
        if (document.activeElement === currentFocusedInput && isEditable(currentFocusedInput)) {
           startRecognition(currentFocusedInput);
        } else if (document.activeElement && isEditable(document.activeElement)) {
            currentFocusedInput = document.activeElement;
            startRecognition(currentFocusedInput);
        } else { currentFocusedInput = null; }
      }
      sendResponse({ status: 'ok', newDictationState: isDictationGloballyActive });
      break;
    case 'languageChanged':
      currentLang = request.newLang;
      settings.dictationLang = request.newLang;
      if (isRecognitionActuallyRunning) needsRecognitionRestart = true;
      sendResponse({ status: 'language update processed' });
      break;
    case 'translationStateChanged': settings.translationActive = request.translationActive; sendResponse({ status: 'translation state updated' }); break;
    case 'translationLangChanged': settings.translationLang = request.newLang; sendResponse({ status: 'translation language updated' }); break;
    case 'geminiModelChanged': settings.geminiModel = request.model; settings.customGeminiModel = request.customModel; sendResponse({ status: 'gemini model updated'}); break;
    case 'autoReplaceRulesChanged': settings.autoReplaceRules = request.rules; parseAutoReplaceRules(settings.autoReplaceRules); sendResponse({ status: 'rules updated' }); break;
    case 'blacklistChanged':
      settings.blacklistSites = request.blacklist;
      parseBlacklistSites(settings.blacklistSites);
      const nowOnBlacklist = isOnBlacklist();
      sendResponse({ status: 'blacklist updated', isOnBlacklist: nowOnBlacklist });
      if (nowOnBlacklist && isRecognitionActuallyRunning) {
        stopRecognition();
      } else if (!nowOnBlacklist && initialBlacklistStatus) {
        if (!listenersInitialized) { loadSettingsAndInitialize(); }
        else if (isDictationGloballyActive && currentFocusedInput && !isRecognitionActuallyRunning) {
            if (document.activeElement === currentFocusedInput && isEditable(currentFocusedInput)) startRecognition(currentFocusedInput);
            else if (document.activeElement && isEditable(document.activeElement)) { currentFocusedInput = document.activeElement; startRecognition(currentFocusedInput); }
        }
      }
      break;
    default: sendResponse({ status: 'unknown command' }); break;
  }

  if (needsRecognitionRestart && currentFocusedInput && isDictationGloballyActive) {
    const activeElementForRestart = currentFocusedInput;
    stopRecognition(() => {
        if (isDictationGloballyActive && document.body.contains(activeElementForRestart) &&
            document.activeElement === activeElementForRestart && !isRecognitionActuallyRunning) {
            startRecognition(activeElementForRestart);
        }
    });
  }
  return true;
}

let focusTimeout = null;
function handleFocusIn(event) {
  if (isOnBlacklist()) return;
  const target = event.target;
  clearTimeout(focusTimeout);

  if (isEditable(target)) {
    if (target.type === 'password') {
        if (isRecognitionActuallyRunning && currentFocusedInput === target) { stopRecognition(); }
        currentFocusedInput = null; updateIndicatorState(IndicatorState.IDLE); return;
    }
    currentFocusedInput = target;
    if (isDictationGloballyActive && !isRecognitionActuallyRunning) {
      focusTimeout = setTimeout(() => {
        if (document.activeElement === target && isDictationGloballyActive && !isRecognitionActuallyRunning) {
          startRecognition(target);
        }
      }, FOCUS_DEBOUNCE_MS);
    }
  } else {
    // Фокус на нередактируемом элементе. Если распознавание шло, оно остановится через onend.
    // Индикатор должен скрыться, если currentFocusedInput больше не валиден для распознавания.
    // updateIndicatorState(IndicatorState.IDLE); // Может быть слишком агрессивно, onend обработает
  }
}

function handleFocusOut(event) {
  if (isOnBlacklist()) return;
  const target = event.target;
  // Если фокус уходит с currentFocusedInput на что-то нередактируемое или из окна,
  // onend должен корректно завершить распознавание.
  // Если currentFocusedInput был тем, для кого показывался индикатор, и фокус ушел,
  // onend должен скрыть индикатор.
  if (target === currentFocusedInput && (!event.relatedTarget || !isEditable(event.relatedTarget))) {
     // console.log("Focus lost from editable field to non-editable or outside window."); // DEBUG
     // Не останавливаем принудительно, даем onend отработать
  }
}

function handleBeforeUnload() {
  if (isRecognitionActuallyRunning) stopRecognition();
  updateIndicatorState(IndicatorState.IDLE);
}

function isEditable(element) {
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  return ((tagName === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit', 'password'].includes(element.type?.toLowerCase())) ||
    tagName === 'textarea' || element.isContentEditable) && !element.disabled && !element.readOnly;
}

// --- Логика распознавания речи ---
function startRecognition(targetElement) {
  if (isOnBlacklist() || !isDictationGloballyActive || !targetElement || !isEditable(targetElement)) {
    updateIndicatorState(IndicatorState.IDLE); return;
  }
  if (isRecognitionActuallyRunning) {
    if (recognition && recognition.targetElement !== targetElement) stopRecognition();
    else return; // Уже идет для этого элемента
  }

  clearTimeout(recognitionRestartTimer);
  lastActivityTime = Date.now();
  recognition = new webkitSpeechRecognition();
  recognition.lang = currentLang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.targetElement = targetElement; // Сохраняем цель

  recognition.onstart = () => {
    if (recognition !== recognition.targetElement.recognitionInstance) return; // Старый инстанс
    isRecognitionActuallyRunning = true;
    lastActivityTime = Date.now();
    updateIndicatorState(IndicatorState.LISTENING, targetElement);
  };
  targetElement.recognitionInstance = recognition; // Привязываем инстанс к элементу

  recognition.onresult = (event) => {
    if (!isRecognitionActuallyRunning || recognition !== targetElement.recognitionInstance) return;
    lastActivityTime = Date.now();
    let finalTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
    }
    if (finalTranscript.trim()) {
      if (isProcessingTranscript) {
        transcriptQueue.push({ text: finalTranscript.trim(), target: targetElement });
      } else {
        if (document.body.contains(targetElement) && isEditable(targetElement)) {
            processFinalTranscript(finalTranscript.trim(), targetElement);
        }
      }
    }
  };

  recognition.onerror = (event) => {
    if (recognition !== targetElement.recognitionInstance) return;
    console.error(`Recognition.onerror: ${event.error}`, event.message);
    recognition.errorObject = event.error; // Для onend
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      isDictationGloballyActive = false; settings.dictationActive = false;
      chrome.storage.sync.set({ dictationActive: false });
      stopRecognition(); // Останавливаем полностью
    }
    // onend обработает перезапуск или полную остановку и обновление индикатора
  };

  recognition.onend = () => {
    if (recognition !== targetElement.recognitionInstance && targetElement.recognitionInstance !== undefined) { // undefined если stopRecognition уже обнулил
        // console.log("onend from an old/stopped instance for target:", targetElement); // DEBUG
        // Если индикатор был для этого элемента, но инстанс уже не тот, убираем
        if (indicatorElement && indicatorElement.targetElement === targetElement && currentIndicatorState !== IndicatorState.IDLE) {
            updateIndicatorState(IndicatorState.IDLE);
        }
        return;
    }
    
    const wasRunning = isRecognitionActuallyRunning;
    isRecognitionActuallyRunning = false;
    targetElement.recognitionInstance = undefined; // Отвязываем инстанс

    const lastError = recognition ? recognition.errorObject : null;

    if (isDictationGloballyActive && wasRunning &&
        (!lastError || (lastError !== 'not-allowed' && lastError !== 'service-not-allowed')) &&
        currentFocusedInput === targetElement && document.body.contains(targetElement) && isEditable(targetElement)) {
      if (Date.now() - lastActivityTime < RECOGNITION_TIMEOUT_MS) {
        recognitionRestartTimer = setTimeout(() => {
          if (isDictationGloballyActive && currentFocusedInput === targetElement &&
              document.activeElement === targetElement && !isRecognitionActuallyRunning) {
            startRecognition(targetElement);
          } else { updateIndicatorState(IndicatorState.IDLE); }
        }, RESTART_DELAY_MS);
      } else { updateIndicatorState(IndicatorState.IDLE); /* console.log("Recognition timed out."); */ } // DEBUG
    } else {
      updateIndicatorState(IndicatorState.IDLE);
      // console.log(`Not restarting. Global: ${isDictationGloballyActive}, WasRun: ${wasRunning}, Err: ${lastError}, Focus: ${currentFocusedInput === targetElement}`); // DEBUG
    }
    if (recognition === targetElement.recognitionInstance) recognition = null; // Обнуляем глобальный, если это был он
  };

  try { recognition.start(); }
  catch (e) {
    console.error("Failed to start recognition (exception):", e);
    isRecognitionActuallyRunning = false; updateIndicatorState(IndicatorState.IDLE);
    if (recognition === targetElement.recognitionInstance) recognition = null;
    targetElement.recognitionInstance = undefined;
  }
}

function stopRecognition(callback) {
  clearTimeout(recognitionRestartTimer);
  const recToStop = recognition;
  const targetOfRecToStop = recToStop ? recToStop.targetElement : null;

  isRecognitionActuallyRunning = false; // Сразу
  if (recToStop) {
      recToStop.onstart = null; recToStop.onresult = null; recToStop.onerror = null; recToStop.onend = null;
      try { recToStop.abort(); } catch (e) { /* console.warn("Error aborting:", e); */ } // DEBUG
      if (targetOfRecToStop) targetOfRecToStop.recognitionInstance = undefined;
  }
  recognition = null; // Обнуляем глобальную ссылку
  updateIndicatorState(IndicatorState.IDLE); // Скрываем индикатор
  if (callback) setTimeout(callback, RESTART_DELAY_MS / 2);
}


// --- Индикатор состояния ---
function createIndicator() {
    if (document.getElementById(INDICATOR_ID)) {
        indicatorElement = document.getElementById(INDICATOR_ID);
        return;
    }
    indicatorElement = document.createElement('div');
    indicatorElement.id = INDICATOR_ID;
    Object.assign(indicatorElement.style, {
        position: 'fixed', zIndex: '2147483647', padding: '2px 6px',
        backgroundColor: 'rgba(0, 0, 0, 0.7)', color: '#fff', fontSize: '12px',
        borderRadius: '4px', fontFamily: 'system-ui, sans-serif', pointerEvents: 'none',
        visibility: 'hidden', lineHeight: '1.2', whiteSpace: 'nowrap',
        transition: 'opacity 0.2s ease-in-out, background-color 0.2s ease-in-out' // Плавность
    });
    document.body.appendChild(indicatorElement);
}

function updateIndicatorState(newState, targetForPositioning = null) {
    if (!indicatorElement) createIndicator();
    if (!indicatorElement) return;

    clearTimeout(indicatorUpdateTimer); // Останавливаем предыдущую анимацию точек
    currentIndicatorState = newState;
    indicatorElement.targetElement = targetForPositioning || currentFocusedInput; // Привязываем к цели для позиционирования

    let text = '';
    let bgColor = 'rgba(0, 0, 0, 0.7)';

    switch (newState) {
        case IndicatorState.IDLE:
            indicatorElement.style.visibility = 'hidden';
            indicatorElement.style.opacity = '0';
            return;
        case IndicatorState.LISTENING:
            text = "Слушаю"; // 🎤
            bgColor = 'rgba(0, 128, 0, 0.7)'; // Зеленый
            animateDots(text);
            break;
        case IndicatorState.PROCESSING:
            text = "Обработка"; // ⚙️
            bgColor = 'rgba(255, 165, 0, 0.8)'; // Оранжевый
            animateDots(text);
            break;
        case IndicatorState.TRANSLATING:
            text = "Перевод"; // 🌍
            bgColor = 'rgba(0, 100, 255, 0.8)'; // Синий
            animateDots(text);
            break;
        default:
            indicatorElement.style.visibility = 'hidden';
            indicatorElement.style.opacity = '0';
            return;
    }

    indicatorElement.style.backgroundColor = bgColor;
    indicatorElement.style.visibility = 'visible';
    indicatorElement.style.opacity = '1';
    positionIndicator();
}

function animateDots(baseText) {
    if (!indicatorElement || currentIndicatorState === IndicatorState.IDLE) return;
    dotCount = (dotCount + 1) % 4; // <--- ИСПОЛЬЗОВАНИЕ dotCount
    indicatorElement.textContent = baseText + '.'.repeat(dotCount); // <--- ИСПОЛЬЗОВАНИЕ dotCount
    indicatorUpdateTimer = setTimeout(() => animateDots(baseText), 350);
}


function positionIndicator(checkFocusAndVisibility = false) {
    if (!indicatorElement || indicatorElement.style.visibility === 'hidden') return;

    const target = indicatorElement.targetElement;
    if (!target || !document.body.contains(target)) {
        updateIndicatorState(IndicatorState.IDLE); return;
    }

    if (checkFocusAndVisibility) {
        const style = window.getComputedStyle(target);
        if (document.activeElement !== target || style.display === 'none' || style.visibility === 'hidden') {
            updateIndicatorState(IndicatorState.IDLE); return;
        }
    }

    const rect = target.getBoundingClientRect();
    let top = rect.top + (rect.height / 2) - (indicatorElement.offsetHeight / 2);
    let left = rect.left + 5;

    if (rect.width < (indicatorElement.offsetWidth + 15)) { // Если поле узкое
        left = rect.left - indicatorElement.offsetWidth - 5;
        if (left < 5) left = rect.right + 5;
    }

    // Коррекция выхода за экран
    if (left < 5) left = 5;
    if (top < 5) top = 5;
    if (left + indicatorElement.offsetWidth > window.innerWidth - 5) {
      left = window.innerWidth - indicatorElement.offsetWidth - 5;
    }
    if (top + indicatorElement.offsetHeight > window.innerHeight - 5) {
      top = window.innerHeight - indicatorElement.offsetHeight - 5;
    }

    indicatorElement.style.top = `${Math.round(top)}px`;
    indicatorElement.style.left = `${Math.round(left)}px`;
}


// --- Обработка и вставка текста ---
async function processFinalTranscript(text, targetElement) {
  if (!targetElement || !document.body.contains(targetElement) || !isEditable(targetElement)) {
    isProcessingTranscript = false; // Сброс, если начато, но цель невалидна
    updateIndicatorState(IndicatorState.IDLE); // Гарантированно скрыть индикатор
    return;
  }

  isProcessingTranscript = true;
  updateIndicatorState(IndicatorState.PROCESSING, targetElement);

  try {
    let processedText = text;
    const commandProcessed = processFormattingCommands(processedText.toLowerCase(), targetElement);
    if (commandProcessed) { return; } // finally сбросит флаг и обновит индикатор

    processedText = applyAutoReplace(processedText);

    if (settings.translationActive && settings.geminiApiKey && processedText.trim()) {
      updateIndicatorState(IndicatorState.TRANSLATING, targetElement);
      try {
        processedText = await translateTextGemini(processedText, settings.dictationLang, settings.translationLang, settings.geminiApiKey);
      } catch (error) { console.error("Translation error in pipeline:", error.message); }
      // После перевода (или ошибки) индикатор вернется к LISTENING, если распознавание еще идет,
      // или IDLE, если это была последняя операция. Это обработает onend.
    }

    if (processedText.trim()) {
      if (document.activeElement === targetElement) {
          insertText(targetElement, processedText + ' ');
      } else if (currentFocusedInput && isEditable(currentFocusedInput) && document.activeElement === currentFocusedInput) {
          insertText(currentFocusedInput, processedText + ' ');
      }
    }
  } catch (e) {
      console.error("Error in processFinalTranscript pipeline:", e);
  } finally {
    isProcessingTranscript = false;
    // Если распознавание все еще должно быть активно для этого элемента, возвращаем индикатор в LISTENING.
    // Иначе onend сам переведет в IDLE.
    if (isRecognitionActuallyRunning && recognition && recognition.targetElement === targetElement) {
        updateIndicatorState(IndicatorState.LISTENING, targetElement);
    } else if (currentIndicatorState !== IndicatorState.IDLE) { // Если не слушаем, но и не IDLE, значит обработка завершена
        updateIndicatorState(IndicatorState.IDLE);
    }

    if (transcriptQueue.length > 0) {
        const nextJob = transcriptQueue.shift();
        setTimeout(() => processFinalTranscript(nextJob.text, nextJob.target), 0);
    }
  }
}

function applyAutoReplace(text) {
  if (!parsedAutoReplaceRules || parsedAutoReplaceRules.length === 0) { return text; }
  let resultText = text;
  parsedAutoReplaceRules.forEach(rule => { resultText = resultText.replace(rule.regex, rule.value); });
  return resultText;
}
function processFormattingCommands(textLC, targetElement) {
  const commands = {
    "удалить слово": () => deleteLastWord(targetElement), "удалить всё": () => clearInput(targetElement),
    "стереть всё": () => clearInput(targetElement), "новая строка": () => insertText(targetElement, '\n'),
    "новый абзац": () => insertText(targetElement, '\n\n'), "абзац": () => insertText(targetElement, '\n\n')
  };
  if (commands[textLC]) { commands[textLC](); return true; } return false;
}
function deleteLastWord(element) {
    const isContentEditable = element.isContentEditable;
    if (isContentEditable) { // Упрощенная версия для contentEditable
        document.execCommand('undo'); // Пытаемся отменить последнее действие (может удалить слово)
                                      // Это не всегда "удалить слово", но часто ближайшее.
                                      // Для более точного нужно сложное манипулирование Range.
    } else {
        let value = element.value; let selStart = element.selectionStart;
        let textBefore = value.substring(0, selStart);
        if (element.selectionStart !== element.selectionEnd) { // Если есть выделение, удаляем его
            element.value = textBefore.substring(0, element.selectionStart) + value.substring(element.selectionEnd);
            element.selectionStart = element.selectionEnd = element.selectionStart;
        } else { // Нет выделения, удаляем слово перед курсором
            const trimmedTextBefore = textBefore.trimEnd();
            const lastSpace = trimmedTextBefore.lastIndexOf(' ');
            textBefore = (lastSpace !== -1) ? trimmedTextBefore.substring(0, lastSpace + 1) : '';
            element.value = textBefore + value.substring(selStart);
            element.selectionStart = element.selectionEnd = textBefore.length;
        }
    }
    const event = new Event('input', { bubbles: true, cancelable: true }); element.dispatchEvent(event);
}
function clearInput(element) {
    if (element.isContentEditable) { element.innerHTML = ''; } else { element.value = ''; }
    const event = new Event('input', { bubbles: true, cancelable: true }); element.dispatchEvent(event);
}
function insertText(element, textToInsert) {
  if (!element || !document.body.contains(element)) return;
  element.focus();
  if (element.isContentEditable) { document.execCommand('insertText', false, textToInsert); }
  else if (typeof element.selectionStart === 'number') {
    const start = element.selectionStart, end = element.selectionEnd;
    element.value = element.value.substring(0, start) + textToInsert + element.value.substring(end);
    element.selectionStart = element.selectionEnd = start + textToInsert.length;
  } else { element.value += textToInsert; }
  const event = new Event('input', { bubbles: true, cancelable: true }); element.dispatchEvent(event);
}

// --- Интеграция с Gemini API ---
async function translateTextGemini(text, sourceLang, targetLang, apiKey) {
  if (!text.trim() || !apiKey) return Promise.resolve(text);
  const modelToUse = (settings.geminiModel === 'custom' && settings.customGeminiModel) ? settings.customGeminiModel : settings.geminiModel;
  const apiUrl = `${GEMINI_API_ENDPOINT_PREFIX}${modelToUse}${GEMINI_API_ENDPOINT_SUFFIX}${apiKey}`;
  const prompt = `Translate from ${getLanguageNameForPrompt(sourceLang)} to ${getLanguageNameForPrompt(targetLang)}. Return ONLY the translated text.\nOriginal: "${text}"`;
  try {
    const response = await fetch(apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: "Failed to parse error" }}));
      throw new Error(`Gemini API: ${response.status} ${errorData.error?.message || ''}`);
    }
    const data = await response.json();
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) return data.candidates[0].content.parts[0].text.trim();
    if (data.promptFeedback?.blockReason) throw new Error(`Translation blocked: ${data.promptFeedback.blockReason}`);
    throw new Error("Could not extract translated text.");
  } catch (error) { console.error("Gemini API call error:", error); return text; } // Возврат исходного текста при ошибке
}
function getLanguageNameForPrompt(langCode) {
  const lang = langCode.split('-')[0].toLowerCase();
  switch (lang) {
    case 'ru': return 'Russian'; case 'en': return 'English'; case 'de': return 'German';
    case 'fr': return 'French'; case 'es': return 'Spanish'; default: return langCode;
  }
}

// --- Запуск ---
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(loadSettingsAndInitialize, 150));
} else {
    setTimeout(loadSettingsAndInitialize, 150); // Небольшая задержка для SPA и тяжелых сайтов
}
// console.log("Content script (v2.2 - informative indicator) loaded."); // DEBUG