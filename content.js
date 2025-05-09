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
  autoReplaceRules: '',
  blacklistSites: ''
};

let parsedAutoReplaceRules = [];
let parsedBlacklistSites = [];

const RECOGNITION_TIMEOUT_MS = 30000;
const GEMINI_API_ENDPOINT_PREFIX = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_API_ENDPOINT_SUFFIX = ":generateContent?key=";

// --- Переменные для индикатора "слушаю" ---
let listeningIndicatorElement = null;
let listeningIndicatorInterval = null;
const listeningChars = ['/', '-', '\\', '|'];
let listeningCharIndex = 0;
const LISTENING_INDICATOR_ID = 'speech-pro-listening-indicator';
let currentTargetForListeningIndicator = null; // Для позиционирования

// --- Переменные для управления обработкой ---
let isProcessingTranscript = false;
let transcriptQueue = [];

// --- Инициализация ---

function isOnBlacklist() {
  if (!parsedBlacklistSites || parsedBlacklistSites.length === 0) { return false; }
  const currentUrl = window.location.href;
  return parsedBlacklistSites.some(sitePattern => currentUrl.includes(sitePattern));
}

async function loadSettingsAndInitialize() {
  try {
    const loadedSettings = await new Promise((resolve) => {
      chrome.storage.sync.get(null, (items) => { resolve(items); });
    });
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
    isDictationGloballyActive = settings.dictationActive; currentLang = settings.dictationLang;
    parseAutoReplaceRules(settings.autoReplaceRules); parseBlacklistSites(settings.blacklistSites);
    console.log('Content Script: Settings loaded and parsed:', settings);
    if (isOnBlacklist()) { console.log('Content Script: Current site is blacklisted.'); return; }
    if (isDictationGloballyActive && document.activeElement && isEditable(document.activeElement)) {
      currentFocusedInput = document.activeElement;
    }
    initializeEventListeners();
  } catch (error) { console.error('Content Script: Error loading settings:', error); }
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
function escapeRegExp(string) { return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// --- Слушатели сообщений и событий ---
let listenersInitialized = false;
function initializeEventListeners() {
    if (listenersInitialized) return;
    chrome.runtime.onMessage.addListener(handleMessages);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true); // Оставим, но будем осторожны
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('scroll', () => positionListeningIndicator(true), true);
    window.addEventListener('resize', () => positionListeningIndicator(true), true);
    listenersInitialized = true;
    console.log("Content Script: Event listeners initialized.");
}

function handleMessages(request, sender, sendResponse) {
  if (isOnBlacklist() && request.command !== "blacklistChanged") {
      if (request.command === "blacklistChanged") {
           settings.blacklistSites = request.blacklist;
           parseBlacklistSites(settings.blacklistSites);
           if (!isOnBlacklist()) { console.log('Content Script: Page is no longer blacklisted.');}
      }
      sendResponse({ status: "ok", info: "Site is blacklisted, command ignored" });
      return true;
  }
  console.log('Content Script: Message received:', request);
  let needsRestart = false;
  switch (request.command) {
    case 'toggleDictation':
      isDictationGloballyActive = request.data;
      settings.dictationActive = request.data;
      console.log(`Content Script: toggleDictation received. isDictationGloballyActive set to ${isDictationGloballyActive}. isRecognitionActuallyRunning: ${isRecognitionActuallyRunning}`);
      if (!isDictationGloballyActive && isRecognitionActuallyRunning) {
        console.log("Content Script: Calling stopRecognition() due to toggleDictation to false.");
        stopRecognition();
      }
      else if (isDictationGloballyActive && currentFocusedInput && !isRecognitionActuallyRunning) {
        console.log("Content Script: Calling startRecognition() due to toggleDictation to true.");
        startRecognition(currentFocusedInput);
      }
      sendResponse({ status: 'ok', newDictationState: isDictationGloballyActive });
      break;
    // ... (остальные case'ы как раньше)
    case 'languageChanged':
      currentLang = request.newLang;
      settings.dictationLang = request.newLang;
      if (isRecognitionActuallyRunning) needsRestart = true;
      sendResponse({ status: 'language update processed' });
      break;
    case 'translationStateChanged':
      settings.translationActive = request.translationActive;
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
    const activeElementForRestart = currentFocusedInput;
    stopRecognition(() => {
        if (activeElementForRestart && isDictationGloballyActive && document.body.contains(activeElementForRestart)) {
            startRecognition(activeElementForRestart);
        }
    });
  }
  return true;
}

let focusTimeout = null; // Для задержки реакции на смену фокуса

function handleFocusIn(event) {
  if (isOnBlacklist()) return;
  const target = event.target;

  clearTimeout(focusTimeout); // Отменяем предыдущий таймер, если есть

  if (isEditable(target)) {
    if (target.type === 'password') {
        if (isRecognitionActuallyRunning && currentFocusedInput === target) { stopRecognition(); }
        currentFocusedInput = null;
        removeListeningIndicator();
        return;
    }
    
    // Если фокус перешел на новый элемент, останавливаем распознавание для старого (если оно шло)
    if (currentFocusedInput && currentFocusedInput !== target && isRecognitionActuallyRunning) {
        console.log("Content Script: Focus moved to a new editable element. Stopping old recognition.");
        stopRecognition(); // Это остановит распознавание и уберет старый индикатор
    }

    console.log('Content Script: Focus on editable element:', target);
    currentFocusedInput = target; // Устанавливаем новый currentFocusedInput

    if (isDictationGloballyActive && !isRecognitionActuallyRunning) {
      // Используем небольшую задержку, чтобы убедиться, что фокус "устоялся"
      focusTimeout = setTimeout(() => {
        if (document.activeElement === target && isDictationGloballyActive && !isRecognitionActuallyRunning) {
          console.log("Content Script: Delayed startRecognition for target:", target);
          startRecognition(target);
        } else {
            console.log("Content Script: Conditions for (re)start not met after focus delay for:", target);
        }
      }, 100); // Уменьшил задержку, можно экспериментировать
    }
  } else { // Фокус ушел на нередактируемый элемент
    // Если распознавание было активно, оно должно остановиться.
    // stopRecognition() вызовется из onend или при попытке перезапуска для невалидного target
    // Но индикатор можно убрать сразу.
    console.log("Content Script: Focus on non-editable element. CurrentFocusedInput was:", currentFocusedInput);
    // currentFocusedInput = null; // Не сбрасываем здесь, чтобы onend мог корректно отработать для предыдущего поля
    removeListeningIndicator();
  }
}

function handleFocusOut(event) {
  const target = event.target;
  console.log('Content Script: Focus lost from element:', target, "Related target (new focus):", event.relatedTarget);

  // Если фокус ушел с элемента, для которого работал индикатор, и новый фокус не на нем же (или вообще не на редактируемом)
  if (target === currentTargetForListeningIndicator && (!event.relatedTarget || !isEditable(event.relatedTarget) || event.relatedTarget !== target) ) {
    // removeListeningIndicator(); // Индикатор должен убираться в onend или onstart нового распознавания
  }
  // Если фокус ушел с текущего `currentFocusedInput` на что-то нередактируемое
  if (target === currentFocusedInput && event.relatedTarget && !isEditable(event.relatedTarget)) {
      console.log("Content Script: Focus truly lost from editable field to non-editable. Recognition should stop via onend if it was running for this target.");
      // stopRecognition(); // Это может быть слишком агрессивно и мешать onend
  }
}

function handleBeforeUnload() {
  if (isRecognitionActuallyRunning) { stopRecognition(); }
  removeListeningIndicator();
}

// --- Логика распознавания речи ---
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

function startRecognition(targetElementArgument) {
  if (isOnBlacklist() || !isDictationGloballyActive || !targetElementArgument || !isEditable(targetElementArgument)) {
    console.warn("Content Script: Recognition prerequisites not met for target:", targetElementArgument);
    removeListeningIndicator(); // Убираем индикатор, если он был и запуск не удался
    return;
  }
  // Если уже идет распознавание, даже для этого же элемента, останавливаем предыдущее полностью
  if (isRecognitionActuallyRunning) {
      console.log("Content Script: Recognition is already running. Stopping previous instance before starting new one.");
      stopRecognition(); // Это вызовет removeListeningIndicator
  }

  clearTimeout(recognitionRestartTimer);
  lastActivityTime = Date.now();
  const localTargetElement = targetElementArgument;
  // currentFocusedInput уже должен быть установлен в handleFocusIn

  recognition = new webkitSpeechRecognition();
  recognition.lang = currentLang;
  recognition.continuous = true;
  recognition.interimResults = true;
  console.log(`Content Script: Attempting to start recognition for lang "${currentLang}" on element:`, localTargetElement);

  recognition.onstart = () => {
    isRecognitionActuallyRunning = true;
    console.log("Content Script: Recognition started for target:", localTargetElement);
    lastActivityTime = Date.now();
    startListeningIndicator(localTargetElement); // << ЗАПУСК ИНДИКАТОРА "СЛУШАЮ"
  };

  recognition.onresult = (event) => {
    // console.log(`Content Script: recognition.onresult FIRED for target: ${localTargetElement.tagName}`); // Можно уменьшить количество логов
    lastActivityTime = Date.now(); // Обновляем активность при любом результате
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const transcriptPart = event.results[i][0].transcript;
      const isFinal = event.results[i].isFinal;
      if (isFinal) {
        finalTranscript += transcriptPart;
      } else {
        interimTranscript += transcriptPart;
      }
    }

    if (finalTranscript.trim()) {
        console.log(`Content Script: FINAL transcript: "`, finalTranscript.trim(), '"');
        if (isProcessingTranscript) {
            console.log("Content Script: Processing already in progress. Queuing text.");
            transcriptQueue.push({ text: finalTranscript.trim(), target: localTargetElement });
        } else {
            processFinalTranscript(finalTranscript.trim(), localTargetElement);
        }
    }
  };

  recognition.onerror = (event) => {
    console.error(`Content Script: Recognition error for target ${localTargetElement.tagName}:`, event.error, event.message);
    // Не сбрасываем isRecognitionActuallyRunning здесь, onend это сделает
    removeListeningIndicator(); // Убираем индикатор при ошибке
    // isRecognitionActuallyRunning = false; // Это сделает onend
    if (event.error === 'no-speech') { console.warn("Content Script: No speech detected."); }
    else if (event.error === 'audio-capture') { console.warn("Content Script: Audio capture error."); }
    else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        console.warn("Content Script: Microphone access denied.");
        isDictationGloballyActive = false; settings.dictationActive = false;
        chrome.storage.sync.set({ dictationActive: false });
    } else if (event.error === 'network') { console.warn("Content Script: Network error."); }
  };

  recognition.onend = () => {
    console.log(`Content Script: Recognition ended for target ${localTargetElement.tagName}. isDictationGloballyActive: ${isDictationGloballyActive}`);
    const wasActuallyRunning = isRecognitionActuallyRunning;
    isRecognitionActuallyRunning = false; // Сбрасываем флаг здесь
    removeListeningIndicator(); // << УБИРАЕМ ИНДИКАТОР "СЛУШАЮ"

    if (currentFocusedInput !== localTargetElement && recognition === event.target) {
        console.log("Content Script: Focus shifted or different instance. Not restarting for old target:", localTargetElement);
        if (recognition === event.target) recognition = null;
        return;
    }
    const lastErrorOccurred = event.error;
    if (isDictationGloballyActive && wasActuallyRunning && // Проверяем wasActuallyRunning (мог быть сброшен в onerror)
        (!lastErrorOccurred || (lastErrorOccurred !== 'not-allowed' && lastErrorOccurred !== 'service-not-allowed'))) {
      const timeSinceLastActivity = Date.now() - lastActivityTime;
      if (timeSinceLastActivity < RECOGNITION_TIMEOUT_MS) {
        console.log("Content Script: Re-starting recognition for target:", localTargetElement);
        clearTimeout(recognitionRestartTimer);
        recognitionRestartTimer = setTimeout(() => {
          // Перед перезапуском еще раз проверяем, что фокус на том же элементе и диктовка все еще нужна
          if (document.activeElement === localTargetElement && isDictationGloballyActive && !isRecognitionActuallyRunning) {
            startRecognition(localTargetElement);
          } else {
            console.log("Content Script: Conditions for restart no longer met for:", localTargetElement);
          }
        }, 50); // Короткая задержка перед перезапуском
      } else { console.log("Content Script: Recognition timed out for target:", localTargetElement); }
    } else {
        console.log(`Content Script: Not restarting for ${localTargetElement.tagName}. isGlobal: ${isDictationGloballyActive}, wasRun: ${wasActuallyRunning}, error: ${lastErrorOccurred}`);
    }
    if (recognition === event.target) {
        recognition = null;
    }
  };
  try { recognition.start(); }
  catch (e) {
    console.error("Content Script: Failed to start recognition for target:", localTargetElement, e);
    isRecognitionActuallyRunning = false; // Убедимся, что сброшен
    removeListeningIndicator();
    if (recognition) { recognition = null; }
  }
}

function stopRecognition(callback) {
  console.log(`Content Script: stopRecognition called. Current recognition object:`, recognition);
  clearTimeout(recognitionRestartTimer); // Отменяем любой запланированный перезапуск
  if (recognition) {
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = () => { // Системный onend все равно сработает, но наш код в нем не выполнится
        console.log("Content Script: System onend after explicit stop/abort for instance that was:", recognition);
        // isRecognitionActuallyRunning = false; // Уже должно быть false
        // if (recognition === ???) recognition = null; // Сложно отследить тот же инстанс здесь
    };
    recognition.continuous = false; // Важно, чтобы предотвратить авто-рестарт из системного onend
    try {
        recognition.abort();
        console.log("Content Script: Recognition abort() called.");
    } catch (e) {
        console.warn("Content Script: Error trying to abort recognition:", e);
    }
    // Не обнуляем recognition здесь сразу, дадим abort() и системному onend отработать.
    // Флаг isRecognitionActuallyRunning сбросим немедленно.
  } else {
    console.log("Content Script: No active recognition object to stop.");
  }
  isRecognitionActuallyRunning = false; // Гарантированно сбрасываем флаг
  removeListeningIndicator(); // Убираем индикатор при явной остановке

  if (callback) { setTimeout(callback, 50); }
}

// --- Независимый индикатор "слушаю" ---
function createListeningIndicator() {
    if (document.getElementById(LISTENING_INDICATOR_ID)) {
        listeningIndicatorElement = document.getElementById(LISTENING_INDICATOR_ID);
        return;
    }
    listeningIndicatorElement = document.createElement('div');
    listeningIndicatorElement.id = LISTENING_INDICATOR_ID;
    // Стили как раньше, но можно сделать его менее навязчивым
    listeningIndicatorElement.style.position = 'fixed';
    listeningIndicatorElement.style.zIndex = '2147483647';
    listeningIndicatorElement.style.padding = '1px 3px'; // Меньше
    listeningIndicatorElement.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
    listeningIndicatorElement.style.color = '#0f0'; // Ярко-зеленый
    listeningIndicatorElement.style.fontSize = '10px'; // Меньше
    listeningIndicatorElement.style.borderRadius = '2px';
    listeningIndicatorElement.style.fontFamily = 'monospace';
    listeningIndicatorElement.style.pointerEvents = 'none';
    listeningIndicatorElement.style.visibility = 'hidden';
    document.body.appendChild(listeningIndicatorElement);
}

function positionListeningIndicator(checkFocus = false) {
    const targetForPositioning = currentTargetForListeningIndicator || currentFocusedInput;
    if (!listeningIndicatorElement) createListeningIndicator();
    if (!listeningIndicatorElement || !targetForPositioning) {
        if (listeningIndicatorElement) listeningIndicatorElement.style.visibility = 'hidden';
        return;
    }
    if (checkFocus && document.activeElement !== targetForPositioning) {
        if (listeningIndicatorElement) listeningIndicatorElement.style.visibility = 'hidden';
        return;
    }
    if (!document.body.contains(targetForPositioning)){ // Если элемент удален из DOM
        removeListeningIndicator();
        return;
    }

    const rect = targetForPositioning.getBoundingClientRect();
    let top = rect.top + (rect.height / 2) - (listeningIndicatorElement.offsetHeight / 2); // По центру высоты
    let left = rect.right + 3; // Чуть правее

    if (!listeningIndicatorElement) return;
    if (left + listeningIndicatorElement.offsetWidth + 5 > window.innerWidth) { // +5 для отступа
        left = rect.left - listeningIndicatorElement.offsetWidth - 3;
    }
    if (left < 0) left = 3;
    if (top < 0) top = 3;
    if (top + listeningIndicatorElement.offsetHeight > window.innerHeight) {
        top = window.innerHeight - listeningIndicatorElement.offsetHeight - 3;
    }

    listeningIndicatorElement.style.top = `${top}px`;
    listeningIndicatorElement.style.left = `${left}px`;
}

function startListeningIndicator(targetInputElement) {
    if (!targetInputElement || !document.body.contains(targetInputElement) || !isEditable(targetInputElement)) {
        console.warn("Content Script: Cannot start listening indicator, target is invalid.", targetInputElement);
        return;
    }
    currentTargetForListeningIndicator = targetInputElement;
    if (listeningIndicatorInterval) { clearInterval(listeningIndicatorInterval); }

    console.log("Content Script: Starting listening indicator for target:", targetInputElement);
    createListeningIndicator();
    if (!listeningIndicatorElement) { console.error("Content Script: Failed to create listening indicator."); return; }

    listeningCharIndex = 0;
    listeningIndicatorElement.textContent = listeningChars[listeningCharIndex];
    listeningIndicatorElement.style.visibility = 'visible';
    positionListeningIndicator();

    listeningIndicatorInterval = setInterval(() => {
        if (!listeningIndicatorElement || listeningIndicatorElement.style.visibility === 'hidden' || !isRecognitionActuallyRunning) {
            removeListeningIndicator(); // Также останавливаем, если распознавание уже неактивно
            return;
        }
        listeningCharIndex = (listeningCharIndex + 1) % listeningChars.length;
        listeningIndicatorElement.textContent = listeningChars[listeningCharIndex];
    }, 250); // Немного медленнее
}

function removeListeningIndicator() {
    if (listeningIndicatorInterval) { clearInterval(listeningIndicatorInterval); listeningIndicatorInterval = null; }
    if (listeningIndicatorElement) { listeningIndicatorElement.style.visibility = 'hidden'; }
    currentTargetForListeningIndicator = null;
    console.log("Content Script: Listening indicator hidden.");
}

// --- Обработка и вставка текста ---
async function processFinalTranscript(text, targetElement) {
  if (!targetElement || !document.body.contains(targetElement) || !isEditable(targetElement)) {
      console.warn("Content Script: Target for processFinalTranscript is invalid.", targetElement);
      isProcessingTranscript = false;
      return;
  }

  isProcessingTranscript = true;
  console.log("Content Script: SET isProcessingTranscript = true for:", text, "on", targetElement);
  // Индикатор "слушаю" уже должен быть активен. Индикатор "обработки" (если бы он был отдельный) здесь бы запускался.

  try {
    let processedText = text;
    const commandProcessed = processFormattingCommands(processedText.toLowerCase(), targetElement);
    if (commandProcessed) { return; } // finally сбросит флаг

    processedText = applyAutoReplace(processedText);

    if (settings.translationActive && settings.geminiApiKey) {
      // Если нужен ОТДЕЛЬНЫЙ индикатор "перевожу", он бы запускался здесь,
      // а индикатор "слушаю" можно было бы временно скрыть/изменить.
      // Пока что индикатор "слушаю" просто продолжает работать.
      console.log("Content Script: Translation active, attempting translation.");
      try {
        processedText = await translateTextGemini(processedText, settings.dictationLang, settings.translationLang, settings.geminiApiKey);
        console.log("Content Script: Translation successful, text:", processedText);
      } catch (error) {
        console.error("Content Script: Translation error:", error);
      }
    }

    if (processedText.trim()) {
      if (document.activeElement === targetElement || (targetElement && document.body.contains(targetElement))) {
          insertText(targetElement, processedText + ' ');
      } else {
          console.warn("Content Script: Focus shifted or target invalid. Text not inserted to original target:", targetElement);
          if (currentFocusedInput && isEditable(currentFocusedInput) && document.body.contains(currentFocusedInput)) {
              insertText(currentFocusedInput, processedText + ' ');
          }
      }
    }
  } catch (e) {
      console.error("Content Script: Error during processFinalTranscript:", e);
  } finally {
    isProcessingTranscript = false;
    console.log("Content Script: RESET isProcessingTranscript = false. Queue:", transcriptQueue.length);
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
  if (text !== resultText) console.log(`Content Script: Auto-replaced "${text}" -> "${resultText}"`);
  return resultText;
}
function processFormattingCommands(textLC, targetElement) {
  const commands = {
    "новая строка": () => insertText(targetElement, '\n'), "абзац": () => insertText(targetElement, '\n\n'),
    "удалить слово": () => deleteLastWord(targetElement), "удалить всё": () => clearInput(targetElement),
  };
  for (const commandPhrase in commands) {
    if (textLC === commandPhrase) {
      commands[commandPhrase](); return true;
    }
  } return false;
}
function deleteLastWord(element) {
    const isContentEditable = element.isContentEditable;
    let value = isContentEditable ? element.textContent : element.value;
    if (isContentEditable) {
        const selection = window.getSelection();
        if (selection.rangeCount > 0 && (element.contains(selection.anchorNode) || selection.anchorNode === element) ) {
            let currentText = element.textContent;
            if (currentText.length > 0) {
                let textBeforeCursor = currentText.substring(0, selection.anchorOffset);
                let textAfterCursor = currentText.substring(selection.focusOffset);
                textBeforeCursor = textBeforeCursor.trimEnd();
                const lastSpace = textBeforeCursor.lastIndexOf(' ');
                if (lastSpace !== -1) { textBeforeCursor = textBeforeCursor.substring(0, lastSpace + 1); }
                else { textBeforeCursor = ''; }
                element.textContent = textBeforeCursor + textAfterCursor;
                const newOffset = textBeforeCursor.length;
                const range = document.createRange(); const sel = window.getSelection();
                try {
                    if (element.firstChild && element.firstChild.nodeType === Node.TEXT_NODE) {
                         range.setStart(element.firstChild, Math.min(newOffset, element.firstChild.length));
                    } else if (element.nodeType === Node.TEXT_NODE) {
                         range.setStart(element, Math.min(newOffset, element.length));
                    } else if (element.childNodes.length > 0) {
                        let charCount = 0; let foundNode = null; let foundOffset = 0;
                        function findTextNode(node) {
                            if (node.nodeType === Node.TEXT_NODE) {
                                if (charCount + node.length >= newOffset) {
                                    foundNode = node; foundOffset = newOffset - charCount; return true;
                                } charCount += node.length;
                            } else { for (let i = 0; i < node.childNodes.length; i++) { if (findTextNode(node.childNodes[i])) return true; } }
                            return false;
                        }
                        findTextNode(element);
                        if (foundNode) { range.setStart(foundNode, Math.min(foundOffset, foundNode.length)); }
                        else { range.selectNodeContents(element); range.collapse(true); }
                    } else { range.selectNodeContents(element); range.collapse(true); }
                    range.collapse(true); sel.removeAllRanges(); sel.addRange(range);
                } catch (e) { console.warn("Error setting range for cursor:", e); }
            }
        } else { element.textContent = value.trimEnd().substring(0, value.trimEnd().lastIndexOf(' ') + 1); }
    } else {
        const currentVal = element.value; const selStart = element.selectionStart;
        let textBeforeSelection = currentVal.substring(0, selStart);
        const textAfterSelection = currentVal.substring(element.selectionEnd);
        textBeforeSelection = textBeforeSelection.trimEnd();
        const lastSpace = textBeforeSelection.lastIndexOf(' ');
        if (lastSpace !== -1) { textBeforeSelection = textBeforeSelection.substring(0, lastSpace + 1); }
        else { textBeforeSelection = ''; }
        element.value = textBeforeSelection + textAfterSelection;
        element.selectionStart = element.selectionEnd = textBeforeSelection.length;
    }
    const event = new Event('input', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
}
function clearInput(element) {
    if (element.isContentEditable) { element.innerHTML = ''; } else { element.value = ''; }
    const event = new Event('input', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
}
function insertText(element, textToInsert) {
  if (!element) return;
  if (element.isContentEditable) { document.execCommand('insertText', false, textToInsert); }
  else if (typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
    const start = element.selectionStart; const end = element.selectionEnd;
    element.value = element.value.substring(0, start) + textToInsert + element.value.substring(end);
    element.selectionStart = element.selectionEnd = start + textToInsert.length;
  } else { element.value += textToInsert; }
  const event = new Event('input', { bubbles: true, cancelable: true });
  element.dispatchEvent(event); element.focus();
}

// --- Интеграция с Gemini API для перевода ---
async function translateTextGemini(text, sourceLang, targetLang, apiKey) {
  if (!text || !apiKey) { return Promise.reject("Текст или API ключ отсутствуют для перевода."); }
  const sourceLangName = getLanguageNameForPrompt(sourceLang);
  const targetLangName = getLanguageNameForPrompt(targetLang);
  const modelToUse = (settings.geminiModel === 'custom' && settings.customGeminiModel) ? settings.customGeminiModel : settings.geminiModel;
  const apiUrl = `${GEMINI_API_ENDPOINT_PREFIX}${modelToUse}${GEMINI_API_ENDPOINT_SUFFIX}${apiKey}`;
  const prompt = `Переведи следующий текст с ${sourceLangName} языка на ${targetLangName} язык. Выведи только переведенный текст, без каких-либо дополнительных комментариев или объяснений.\n\nТекст для перевода:\n"${text}"`;
  // console.log("Content Script: Gemini API Prompt:", prompt); // Можно закомментировать для уменьшения логов
  try {
    const response = await fetch(apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: "Failed to parse error response" } }));
      console.error("Content Script: Gemini API Error Response:", errorData);
      throw new Error(`Gemini API request failed: ${response.status} ${response.statusText}. ${errorData.error?.message || ''}`);
    }
    const data = await response.json(); // console.log("Content Script: Gemini API Success Response:", data);
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) { return data.candidates[0].content.parts[0].text.trim(); }
    else if (data.promptFeedback?.blockReason) {
        console.error("Content Script: Gemini API - Prompt blocked:", data.promptFeedback.blockReason, data.promptFeedback.safetyRatings);
        throw new Error(`Gemini API: Prompt was blocked due to ${data.promptFeedback.blockReason}.`);
    } else {
      console.warn("Content Script: Gemini API - Unexpected response structure:", data);
      throw new Error("Не удалось извлечь переведенный текст из ответа Gemini API.");
    }
  } catch (error) { console.error("Content Script: Error during Gemini API call:", error); throw error; }
}
function getLanguageNameForPrompt(langCode) {
  const lang = langCode.split('-')[0].toLowerCase();
  switch (lang) {
    case 'ru': return 'русского'; case 'en': return 'английского'; case 'de': return 'немецкого';
    case 'fr': return 'французского'; case 'es': return 'испанского'; default: return langCode;
  }
}

// --- Запуск ---
loadSettingsAndInitialize();
console.log("Content script loaded and potentially active.");