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
  blacklistSites: '',
  interimResultsEnabled: true,
  disableBrowserAutoPunctuation: true,
  promptGeneratorModeActive: false,
  autoInsertGeneratedPrompt: false
};

let parsedAutoReplaceRules = [];
let parsedBlacklistSites = [];

let isPromptGeneratorModeActive = false;
let collectedPromptIdeas = "";

const RECOGNITION_TIMEOUT_MS = 30000;
const RESTART_DELAY_MS = 50;
const FOCUS_DEBOUNCE_MS = 50;
const SCROLL_RESIZE_DEBOUNCE_MS = 150;
const USER_EDIT_RESTART_DELAY_MS = 100;

const INDICATOR_ID = 'smart-voice-input-indicator';
let indicatorElement = null;
const IndicatorState = {
  IDLE: 'IDLE', LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', TRANSLATING: 'TRANSLATING',
  BLACKLISTED: 'BLACKLISTED', NO_MIC_ACCESS: 'NO_MIC_ACCESS', PASSWORD_FIELD: 'PASSWORD_FIELD',
  RECOGNITION_ERROR: 'RECOGNITION_ERROR',
  PROMPT_COLLECTING: 'PROMPT_COLLECTING'
};
let currentIndicatorState = IndicatorState.IDLE;
let indicatorUpdateTimer = null;
let dotCount = 0;
let temporaryIndicatorClearTimer = null;

let currentInterimText = '';
let interimPhraseStartPosition = null;
let isDisplayingInterim = false;
let hasUserEditedDuringInterim = false;

let isProcessingTranscript = false;
let transcriptQueue = [];

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => { clearTimeout(timeout); func(...args); };
    clearTimeout(timeout); timeout = setTimeout(later, wait);
  };
}

async function loadSettingsAndInitialize() {
  try {
    const loadedSettings = await new Promise((resolve) => {
      chrome.storage.sync.get(settings, (items) => { resolve(items); });
    });
    settings = { ...settings, ...loadedSettings };
    isDictationGloballyActive = settings.dictationActive;
    currentLang = settings.dictationLang;
    isPromptGeneratorModeActive = settings.promptGeneratorModeActive;
    if (typeof loadedSettings.interimResultsEnabled !== 'undefined') {
        settings.interimResultsEnabled = loadedSettings.interimResultsEnabled;
    }

    parseAutoReplaceRules(settings.autoReplaceRules);
    parseBlacklistSites(settings.blacklistSites);
    if (isOnBlacklist(window.location.href)) return;
    if (document.activeElement && isEditable(document.activeElement)) {
      currentFocusedInput = document.activeElement;
      if (shouldStartRecognitionFor(currentFocusedInput)) {
        startRecognition(currentFocusedInput);
      }
    }
    initializeEventListeners();
  } catch (error) { console.error('SVI: Error loading settings:', error); }
}

function isOnBlacklist(url) {
  if (!parsedBlacklistSites || parsedBlacklistSites.length === 0) return false;
  return parsedBlacklistSites.some(sitePattern => url.includes(sitePattern));
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
        if (key) parsedAutoReplaceRules.push({ key, value, regex: new RegExp(escapeRegExp(key), 'gi') });
      }
    });
  }
}

function parseBlacklistSites(blacklistString) {
  parsedBlacklistSites = [];
  if (blacklistString && typeof blacklistString === 'string') {
    parsedBlacklistSites = blacklistString.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  }
}

function escapeRegExp(string) { return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

let listenersInitialized = false;
const debouncedPositionIndicator = debounce(() => positionIndicator(true), SCROLL_RESIZE_DEBOUNCE_MS);

function initializeEventListeners() {
    if (listenersInitialized || isOnBlacklist(window.location.href)) return;
    chrome.runtime.onMessage.addListener(handleMessages);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('scroll', debouncedPositionIndicator, true);
    window.addEventListener('resize', debouncedPositionIndicator, true);
    listenersInitialized = true;
}

function handleMessages(request, sender, sendResponse) {
  const currentUrl = window.location.href;
  let initialBlacklistStatus = isOnBlacklist(currentUrl);

  if (initialBlacklistStatus &&
      request.command !== "blacklistChanged" &&
      request.command !== "setPromptGeneratorMode" &&
      request.command !== "insertGeneratedPrompt") {
    sendResponse({ status: "ok", info: "Site is blacklisted" }); return true;
  }

  let needsRecognitionRestart = false;
  switch (request.command) {
    case 'toggleDictation':
      isDictationGloballyActive = request.data; settings.dictationActive = request.data;
      if (!isDictationGloballyActive && isRecognitionActuallyRunning) {
        stopRecognition();
      } else if (isDictationGloballyActive && currentFocusedInput && !isRecognitionActuallyRunning && shouldStartRecognitionFor(currentFocusedInput)) {
        startRecognition(currentFocusedInput);
      }
      sendResponse({ status: 'ok', newDictationState: isDictationGloballyActive });
      break;
    case 'setPromptGeneratorMode':
      const oldPromptModeState = isPromptGeneratorModeActive;
      isPromptGeneratorModeActive = request.isActive;
      settings.promptGeneratorModeActive = request.isActive;
      // console.log("SVI Content: Prompt Generator Mode set to", isPromptGeneratorModeActive, "Old mode was:", oldPromptModeState); // DEBUG

      if (isPromptGeneratorModeActive) {
        resetInterimState(); 
        collectedPromptIdeas = "";
        if (isRecognitionActuallyRunning && !oldPromptModeState) {
            needsRecognitionRestart = true;
        } else if (currentFocusedInput && shouldStartRecognitionFor(currentFocusedInput)) {
            startRecognition(currentFocusedInput);
        }
      } else { 
        sendCollectedPromptIdeas();
        resetInterimState();
        if (isRecognitionActuallyRunning && oldPromptModeState) {
             needsRecognitionRestart = true;
        }
      }
      if (isRecognitionActuallyRunning && currentFocusedInput) {
          updateIndicatorState(isPromptGeneratorModeActive ? IndicatorState.PROMPT_COLLECTING : IndicatorState.LISTENING, currentFocusedInput);
      }
      sendResponse({ status: 'ok', newPromptGeneratorMode: isPromptGeneratorModeActive });
      break;
    case 'insertGeneratedPrompt':
        if (request.promptToInsert && currentFocusedInput && isEditable(currentFocusedInput)) {
            clearInput(currentFocusedInput);
            insertText(currentFocusedInput, request.promptToInsert);
            sendResponse({status: "prompt_inserted"});
        } else {
            sendResponse({status: "prompt_not_inserted", reason: "no target or no prompt"});
        }
        break;
    case 'languageChanged':
      currentLang = request.newLang; settings.dictationLang = request.newLang;
      if (isRecognitionActuallyRunning) needsRecognitionRestart = true;
      sendResponse({ status: 'language update processed' });
      break;
    case 'translationStateChanged':
      settings.translationActive = request.translationActive;
      sendResponse({ status: 'ok' });
      break;
    case 'translationLangChanged':
      settings.translationLang = request.newLang;
      sendResponse({ status: 'ok' });
      break;
    case 'geminiModelChanged':
      settings.geminiModel = request.model; settings.customGeminiModel = request.customModel;
      sendResponse({ status: 'ok' });
      break;
    case 'autoReplaceRulesChanged':
      settings.autoReplaceRules = request.rules; parseAutoReplaceRules(settings.autoReplaceRules);
      sendResponse({ status: 'ok' });
      break;
    case 'disableBrowserAutoPunctuationChanged':
        settings.disableBrowserAutoPunctuation = request.disableBrowserAutoPunctuation;
        sendResponse({ status: 'ok' });
        break;
    case 'blacklistChanged':
      settings.blacklistSites = request.blacklist; parseBlacklistSites(settings.blacklistSites);
      const nowOnBlacklist = isOnBlacklist(currentUrl);
      sendResponse({ status: 'ok', isOnBlacklist: nowOnBlacklist });
      if (nowOnBlacklist && isRecognitionActuallyRunning) {
        stopRecognition(); updateIndicatorState(IndicatorState.BLACKLISTED, currentFocusedInput, true);
      } else if (!nowOnBlacklist && initialBlacklistStatus) {
        if (!listenersInitialized) loadSettingsAndInitialize();
        else if (currentFocusedInput && shouldStartRecognitionFor(currentFocusedInput)) startRecognition(currentFocusedInput);
      }
      break;
    default:
      sendResponse({ status: 'unknown command' });
      break;
  }

  if (needsRecognitionRestart && currentFocusedInput && isEditable(currentFocusedInput)) {
    const activeElementForRestart = currentFocusedInput;
    stopRecognition(() => {
      if (shouldStartRecognitionFor(activeElementForRestart) && document.activeElement === activeElementForRestart) {
        startRecognition(activeElementForRestart);
      }
    });
  }
  return true;
}

/**
 * Отправляет накопленные идеи для промпта, если они есть.
 */
function sendCollectedPromptIdeas() {
    if (isPromptGeneratorModeActive && collectedPromptIdeas.trim()) {
        // console.log("SVI Content: Sending collected prompt ideas:", collectedPromptIdeas); // DEBUG
        chrome.runtime.sendMessage({ command: "userIdeasForPromptCollected", userText: collectedPromptIdeas });
        collectedPromptIdeas = ""; // Очищаем после отправки
    }
}

let focusTimeout = null;
function shouldStartRecognitionFor(element) {
    if (!element) return false;
    const canStart = (isDictationGloballyActive || isPromptGeneratorModeActive) &&
           !isRecognitionActuallyRunning && isEditable(element) &&
           element.type !== 'password';
    if (isPromptGeneratorModeActive) return canStart;
    return canStart && !isOnBlacklist(window.location.href);
}

function handleFocusIn(event) {
  const target = event.target;
  clearTimeout(focusTimeout);
  if (isOnBlacklist(window.location.href) && !isPromptGeneratorModeActive) {
    if (isEditable(target)) updateIndicatorState(IndicatorState.BLACKLISTED, target, true);
    return;
  }
  if (isEditable(target)) {
    if (target.type === 'password') {
      if (isRecognitionActuallyRunning && currentFocusedInput === target) stopRecognition();
      currentFocusedInput = target; updateIndicatorState(IndicatorState.PASSWORD_FIELD, target, true); return;
    }
    if (currentFocusedInput && currentFocusedInput !== target && isRecognitionActuallyRunning) stopRecognition();
    currentFocusedInput = target;
    if (settings.interimResultsEnabled && typeof target.addEventListener === 'function') {
        target.removeEventListener('input', handleUserInputDuringInterim);
        target.addEventListener('input', handleUserInputDuringInterim);
    }
    if (shouldStartRecognitionFor(target)) {
      focusTimeout = setTimeout(() => {
        if (document.activeElement === target && shouldStartRecognitionFor(target)) {
          startRecognition(target);
        }
      }, FOCUS_DEBOUNCE_MS);
    }
  } else {
    if (isRecognitionActuallyRunning && currentFocusedInput && isEditable(currentFocusedInput)) stopRecognition();
    updateIndicatorState(IndicatorState.IDLE);
  }
}

function handleFocusOut(event) {
  const target = event.target; const relatedTarget = event.relatedTarget;
  if (target === currentFocusedInput && isRecognitionActuallyRunning) {
    if (!relatedTarget || !isEditable(relatedTarget) || (isOnBlacklist(window.location.href) && !isPromptGeneratorModeActive) || (relatedTarget && relatedTarget.type === 'password')) {
      sendCollectedPromptIdeas(); // Отправляем идеи, если они были и уходим с поля
      stopRecognition();
    }
  }
  if (target === currentFocusedInput && !isRecognitionActuallyRunning) {
      if (!relatedTarget || !isEditable(relatedTarget)) {
          currentFocusedInput = null; updateIndicatorState(IndicatorState.IDLE);
      }
  }
  if (settings.interimResultsEnabled && target && typeof target.removeEventListener === 'function') {
    target.removeEventListener('input', handleUserInputDuringInterim);
  }
}

function handleUserInputDuringInterim() {
    if (settings.interimResultsEnabled && isDisplayingInterim && isRecognitionActuallyRunning) {
        const targetToRestart = currentFocusedInput;
        // console.log("SVI: User edit detected. Stopping current recognition session."); // DEBUG
        stopRecognition(() => {
            setTimeout(() => {
                if (targetToRestart && document.activeElement === targetToRestart && shouldStartRecognitionFor(targetToRestart)) {
                    // console.log("SVI: Restarting recognition after user edit for:", targetToRestart); // DEBUG
                    startRecognition(targetToRestart);
                }
            }, USER_EDIT_RESTART_DELAY_MS);
        });
    }
}

function handleBeforeUnload() {
  sendCollectedPromptIdeas();
  if (isRecognitionActuallyRunning) stopRecognition();
}

function isEditable(element) {
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  return ((tagName === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit', 'password'].includes(element.type?.toLowerCase())) ||
    tagName === 'textarea' || element.isContentEditable) && !element.disabled && !element.readOnly;
}

function triggerInputEvents(element) {
    if (!element) return;
    const eventsToDispatch = [
        { type: 'input', options: { bubbles: true, cancelable: false } },
        { type: 'change', options: { bubbles: true, cancelable: true } },
    ];
    eventsToDispatch.forEach(eventConfig => {
        let event;
        try {
            event = new Event(eventConfig.type, eventConfig.options);
            element.dispatchEvent(event);
        } catch (e) { console.warn(`SVI: Error dispatching ${eventConfig.type} event:`, e); }
    });
}

function startRecognition(targetElement) {
  if (!shouldStartRecognitionFor(targetElement)) {
    if (currentIndicatorState !== IndicatorState.IDLE && (!indicatorElement || indicatorElement.targetElement === targetElement)) {
         updateIndicatorState(IndicatorState.IDLE);
    }
    return;
  }
  clearTimeout(recognitionRestartTimer);
  lastActivityTime = Date.now();
  resetInterimState(); // Сбрасываем перед каждым стартом

  recognition = new webkitSpeechRecognition();
  recognition.lang = currentLang;
  recognition.continuous = true;
  recognition.interimResults = settings.interimResultsEnabled;
  recognition.targetElement = targetElement;
  targetElement.recognitionInstance = recognition;

  recognition.onstart = () => {
    if (recognition !== targetElement.recognitionInstance) return;
    isRecognitionActuallyRunning = true; lastActivityTime = Date.now();
    updateIndicatorState(isPromptGeneratorModeActive ? IndicatorState.PROMPT_COLLECTING : IndicatorState.LISTENING, targetElement);
  };

  recognition.onresult = (event) => {
    if (!isRecognitionActuallyRunning || recognition !== targetElement.recognitionInstance) return;
    lastActivityTime = Date.now();
    let accumulatedFinalTranscript = '';
    let currentFullInterim = ""; // Собирает ПОЛНЫЙ interim для текущего event

    for (let i = event.resultIndex; i < event.results.length; ++i) {
        const result = event.results[i];
        // Собираем все части текущего interim
        if (!result.isFinal && settings.interimResultsEnabled) {
            for (let j = 0; j < result.length; j++) { // Обычно одна альтернатива
                 currentFullInterim += result[j].transcript;
            }
        }
        // Собираем все финальные части
        if (result.isFinal) {
            accumulatedFinalTranscript += result[0].transcript;
        }
    }

    const hasFinalInThisEvent = accumulatedFinalTranscript.trim().length > 0;

    // Отображаем interim, только если он есть, включен, пользователь не редактировал И НЕТ ФИНАЛЬНОГО в этом же событии
    if (settings.interimResultsEnabled && currentFullInterim.trim() && !hasUserEditedDuringInterim && !hasFinalInThisEvent) {
      if (!isPromptGeneratorModeActive) {
        if (!isDisplayingInterim) { // Начало новой interim фразы
          interimPhraseStartPosition = getSelectionStart(targetElement);
          isDisplayingInterim = true;
        }
        // Заменяем текст только если новый полный interim отличается от сохраненного
        if (currentFullInterim !== currentInterimText) {
            replaceTextRange(targetElement, interimPhraseStartPosition, interimPhraseStartPosition + currentInterimText.length, currentFullInterim);
            currentInterimText = currentFullInterim; // Сохраняем новый полный interim
            setCursorPosition(targetElement, interimPhraseStartPosition + currentInterimText.length);
            triggerInputEvents(targetElement);
        }
      }
    }

    if (hasFinalInThisEvent) {
      const rawFinalText = accumulatedFinalTranscript.trim();
      if (isPromptGeneratorModeActive) {
        collectedPromptIdeas += rawFinalText + " ";
        // В режиме сбора идей, interim не отображается, поэтому нечего сбрасывать специально для final
        // resetInterimState(); // Не нужно здесь, т.к. interim не должен влиять на сбор
      } else {
        const wasDisplayingInterimPrior = isDisplayingInterim;
        const userHadEditedPrior = hasUserEditedDuringInterim;
        const savedInterimStartPrior = interimPhraseStartPosition;
        const savedInterimLengthPrior = currentInterimText.length;

        resetInterimState(); // Сбрасываем состояние interim ПЕРЕД обработкой final

        const isReplacingCurrentInterim = settings.interimResultsEnabled && wasDisplayingInterimPrior && !userHadEditedPrior;

        if (isProcessingTranscript) {
            transcriptQueue.push({ text: rawFinalText, target: targetElement, userHasEdited: userHadEditedPrior, isReplacingInterim: isReplacingCurrentInterim, replaceStart: savedInterimStartPrior, replaceLength: savedInterimLengthPrior });
        } else {
            processFinalTranscript(rawFinalText, targetElement, userHadEditedPrior, isReplacingCurrentInterim, savedInterimStartPrior, savedInterimLengthPrior);
        }
      }
    }
  };

  recognition.onerror = (event) => {
    if (recognition !== targetElement.recognitionInstance) return;
    console.error(`SVI: Recognition.onerror: ${event.error}`, event.message);
    recognition.errorObject = event.error;
    if (settings.interimResultsEnabled || !isPromptGeneratorModeActive) resetInterimState();
    let msgState = IndicatorState.RECOGNITION_ERROR;
    if (event.error === 'no-speech') return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      msgState = IndicatorState.NO_MIC_ACCESS; isDictationGloballyActive = false; settings.dictationActive = false;
      chrome.storage.sync.set({ dictationActive: false });
      chrome.runtime.sendMessage({ command: "micPermissionDenied", site: window.location.hostname });
      stopRecognition(); return;
    }
    updateIndicatorState(msgState, targetElement, true);
  };

  recognition.onend = () => {
    if (targetElement.recognitionInstance && recognition !== targetElement.recognitionInstance) return;
    const wasRunning = isRecognitionActuallyRunning; isRecognitionActuallyRunning = false;
    if (targetElement.recognitionInstance === recognition) targetElement.recognitionInstance = undefined;
    
    const oldInterimWasDisplaying = isDisplayingInterim;
    const oldInterimText = currentInterimText;
    const oldInterimStart = interimPhraseStartPosition;
    const oldUserHadEdited = hasUserEditedDuringInterim;

    const lastError = recognition ? recognition.errorObject : null;
    if (settings.interimResultsEnabled || !isPromptGeneratorModeActive) resetInterimState();

    if (isPromptGeneratorModeActive) {
        sendCollectedPromptIdeas(); // Отправляем идеи, если они есть
    } else {
        // Финализация "зависшего" interim, если interim включены
        if (settings.interimResultsEnabled && oldInterimWasDisplaying && oldInterimText.trim() && !oldUserHadEdited && !lastError) {
            if (isProcessingTranscript) {
                transcriptQueue.push({ text: oldInterimText, target: targetElement, userHasEdited: false, isReplacingInterim: true, replaceStart: oldInterimStart, replaceLength: oldInterimText.length });
            } else {
                processFinalTranscript(oldInterimText, targetElement, false, true, oldInterimStart, oldInterimText.length);
            }
        }
    }
    
    if ((isDictationGloballyActive || isPromptGeneratorModeActive) && wasRunning && (!lastError || (lastError !== 'not-allowed' && lastError !== 'service-not-allowed')) &&
        currentFocusedInput === targetElement && document.activeElement === targetElement && document.body.contains(targetElement) &&
        isEditable(targetElement) && !(isOnBlacklist(window.location.href) && !isPromptGeneratorModeActive) ) {
      if (Date.now() - lastActivityTime < RECOGNITION_TIMEOUT_MS) {
        recognitionRestartTimer = setTimeout(() => {
          if (shouldStartRecognitionFor(targetElement) && document.activeElement === targetElement) startRecognition(targetElement);
          else updateIndicatorState(IndicatorState.IDLE);
        }, RESTART_DELAY_MS);
      } else updateIndicatorState(IndicatorState.IDLE);
    } else {
      if (currentIndicatorState !== IndicatorState.NO_MIC_ACCESS && currentIndicatorState !== IndicatorState.RECOGNITION_ERROR &&
          currentIndicatorState !== IndicatorState.BLACKLISTED && currentIndicatorState !== IndicatorState.PASSWORD_FIELD) {
        updateIndicatorState(IndicatorState.IDLE);
      }
    }
    if (recognition && recognition.targetElement === targetElement) recognition = null;
  };

  try { recognition.start(); }
  catch (e) {
    console.error("SVI: Failed to call recognition.start():", e); isRecognitionActuallyRunning = false;
    if (targetElement.recognitionInstance === recognition) targetElement.recognitionInstance = undefined;
    recognition = null; if (settings.interimResultsEnabled || !isPromptGeneratorModeActive) resetInterimState();
    if (e.name !== 'InvalidStateError') updateIndicatorState(IndicatorState.RECOGNITION_ERROR, targetElement, true);
    else updateIndicatorState(IndicatorState.IDLE);
  }
}

function stopRecognition(callback) {
  clearTimeout(recognitionRestartTimer);
  const recToStop = recognition; const targetOfRecToStop = recToStop ? recToStop.targetElement : null;
  
  sendCollectedPromptIdeas(); // Отправляем идеи, если они есть, перед остановкой

  isRecognitionActuallyRunning = false; recognition = null; 
  if (settings.interimResultsEnabled || !isPromptGeneratorModeActive) {
    resetInterimState();
  }
  if (recToStop) {
    recToStop.onstart = null; recToStop.onresult = null; recToStop.onerror = null; recToStop.onend = null;
    try { recToStop.abort(); } catch (e) {}
    if (targetOfRecToStop && targetOfRecToStop.recognitionInstance === recToStop) targetOfRecToStop.recognitionInstance = undefined;
  }
  if (currentIndicatorState !== IndicatorState.NO_MIC_ACCESS) updateIndicatorState(IndicatorState.IDLE);
  if (callback) setTimeout(callback, USER_EDIT_RESTART_DELAY_MS / 2);
}

function resetInterimState() {
    const targetWithListener = (settings.interimResultsEnabled && isDisplayingInterim) ? currentFocusedInput : null;
    isDisplayingInterim = false; currentInterimText = ''; interimPhraseStartPosition = null; hasUserEditedDuringInterim = false;
    if(targetWithListener && typeof targetWithListener.removeEventListener === 'function') {
        targetWithListener.removeEventListener('input', handleUserInputDuringInterim);
    }
    // collectedPromptIdeas здесь не очищаем, это делается в других местах
}

function getSelectionStart(element) {
    if (!element) return 0;
    try {
        if (typeof element.selectionStart === 'number') return element.selectionStart;
        if (element.isContentEditable) {
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0); const preSelectionRange = range.cloneRange();
                preSelectionRange.selectNodeContents(element); preSelectionRange.setEnd(range.startContainer, range.startOffset);
                return preSelectionRange.toString().length;
            }
        }
    } catch (e) { console.warn("SVI: Error in getSelectionStart", e); }
    return element.value ? element.value.length : (element.textContent ? element.textContent.length : 0);
}

function setCursorPosition(element, position) {
    if (!element) return;
    try {
        if (typeof element.selectionStart === 'number') {
            element.selectionStart = element.selectionEnd = position;
        } else if (element.isContentEditable) {
            element.focus(); const selection = window.getSelection(); if (!selection) return;
            const range = document.createRange(); let charCount = 0; let foundNode = null; let foundOffset = 0;
            function findTextNodeAndOffset(parentNode) {
                for (let i = 0; i < parentNode.childNodes.length; i++) {
                    const node = parentNode.childNodes[i];
                    if (node.nodeType === Node.TEXT_NODE) {
                        const nextCharCount = charCount + node.length;
                        if (position <= nextCharCount) { foundNode = node; foundOffset = position - charCount; return true; }
                        charCount = nextCharCount;
                    } else if (node.nodeType === Node.ELEMENT_NODE) { if (findTextNodeAndOffset(node)) return true; }
                } return false;
            }
            if (findTextNodeAndOffset(element)) {
                range.setStart(foundNode, Math.min(foundOffset, foundNode.length));
                range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
            } else { range.selectNodeContents(element); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); }
        }
    } catch (e) { console.warn("SVI: Error setting cursor position", e); }
}

function replaceTextRange(element, start, end, newText) {
    if (!element) return;
    if (element.isContentEditable) {
        element.focus(); const selection = window.getSelection(); if (!selection) return;
        const range = document.createRange(); let charCount = 0;
        let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
        function findNodeAndOffsetForRange(parentNode, targetPosition, assignCallback) {
            for (let i = 0; i < parentNode.childNodes.length; i++) {
                const node = parentNode.childNodes[i];
                if (node.nodeType === Node.TEXT_NODE) {
                    const nodeLength = node.length;
                    if (charCount <= targetPosition && targetPosition <= charCount + nodeLength) {
                         assignCallback(node, targetPosition - charCount); return true;
                    }
                    charCount += nodeLength;
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (findNodeAndOffsetForRange(node, targetPosition, assignCallback)) return true;
                }
            } return false;
        }
        charCount = 0;
        if (!findNodeAndOffsetForRange(element, start, (node, offset) => { startNode = node; startOffset = offset; })) {
            startNode = element; startOffset = 0;
            if(element.firstChild && start === 0) {
                let node = element.firstChild;
                while(node && node.firstChild && node.nodeType !== Node.TEXT_NODE) node = node.firstChild;
                if(node && node.nodeType === Node.TEXT_NODE) startNode = node; else startNode = element;
            } else if (element.childNodes.length > 0 && start > 0) {
                startNode = element.lastChild || element;
                startOffset = startNode.nodeType === Node.TEXT_NODE ? (startNode.nodeValue? startNode.nodeValue.length : 0) : (startNode.childNodes ? startNode.childNodes.length : 0);
            }
        }
        charCount = 0;
        if (!findNodeAndOffsetForRange(element, end, (node, offset) => { endNode = node; endOffset = offset; })) {
            endNode = startNode;
            endOffset = (startNode && startNode.nodeType === Node.TEXT_NODE) ? (startNode.nodeValue? startNode.nodeValue.length : 0) : (startNode ? (startNode.childNodes ? startNode.childNodes.length : 0) : 0);
            if(startNode === element && end > startOffset) endOffset = element.childNodes.length;
             if (startNode && startNode.nodeType === Node.TEXT_NODE && end > startOffset) endOffset = (startNode.nodeValue? startNode.nodeValue.length : 0);
        }

        try {
            startOffset = Math.min(startOffset, startNode.nodeValue ? startNode.nodeValue.length : (startNode.childNodes ? startNode.childNodes.length : 0) );
            endOffset = Math.min(endOffset, endNode.nodeValue ? endNode.nodeValue.length : (endNode.childNodes ? endNode.childNodes.length : 0) );
            if (startNode === endNode && startOffset > endOffset) startOffset = endOffset;

            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset);
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('insertText', false, newText);
        } catch (e) {
             console.warn("SVI: Error replacing contentEditable range.", e, {start, end, newText, sn:startNode, so:startOffset, en:endNode, eo:endOffset});
             document.execCommand('insertText', false, newText);
        }
    } else if (typeof element.selectionStart === 'number') {
        const currentVal = element.value;
        const scrollTop = element.scrollTop;
        element.value = currentVal.substring(0, start) + newText + currentVal.substring(end);
        element.scrollTop = scrollTop;
    }
}

function createIndicator() {
    if (document.getElementById(INDICATOR_ID)) {
        indicatorElement = document.getElementById(INDICATOR_ID); return;
    }
    indicatorElement = document.createElement('div'); indicatorElement.id = INDICATOR_ID;
    Object.assign(indicatorElement.style, {
        position: 'fixed', zIndex: '2147483647', padding: '2px 6px',
        backgroundColor: 'rgba(0, 0, 0, 0.7)', color: '#fff', fontSize: '12px',
        borderRadius: '4px', fontFamily: 'system-ui, sans-serif', pointerEvents: 'none',
        visibility: 'hidden', lineHeight: '1.2', whiteSpace: 'nowrap',
        transition: 'opacity 0.2s ease-in-out, background-color 0.2s ease-in-out, transform 0.1s ease-out'
    });
    if (document.body) { document.body.appendChild(indicatorElement); }
    else { document.addEventListener('DOMContentLoaded', () => { if (!document.getElementById(INDICATOR_ID) && document.body) document.body.appendChild(indicatorElement); }); }
}

function updateIndicatorState(newState, targetForPositioning = null, temporaryMessage = false) {
    if (!document.body) { if (newState !== IndicatorState.IDLE) console.warn("SVI: Indicator update before body. State:", newState); return; }
    if (!indicatorElement) createIndicator(); if (!indicatorElement) return;
    clearTimeout(indicatorUpdateTimer); clearTimeout(temporaryIndicatorClearTimer);
    const effectiveTarget = targetForPositioning || currentFocusedInput || indicatorElement.targetElement;
    indicatorElement.targetElement = effectiveTarget; currentIndicatorState = newState;
    let text = ''; let bgColor = 'rgba(0, 0, 0, 0.7)'; let textColor = '#fff';
    switch (newState) {
        case IndicatorState.IDLE: indicatorElement.style.opacity = '0'; setTimeout(() => { if (currentIndicatorState === IndicatorState.IDLE) indicatorElement.style.visibility = 'hidden'; }, 200); return;
        case IndicatorState.LISTENING: text = "Слушаю"; bgColor = 'rgba(0, 128, 0, 0.75)'; animateDots(text); break;
        case IndicatorState.PROCESSING: text = "Обработка"; bgColor = 'rgba(255, 165, 0, 0.8)'; animateDots(text); break;
        case IndicatorState.TRANSLATING: text = "Перевод"; bgColor = 'rgba(0, 100, 255, 0.8)'; animateDots(text); break;
        case IndicatorState.PROMPT_COLLECTING: text = "Идеи для промпта..."; bgColor = 'rgba(128, 0, 128, 0.75)'; animateDots(text); break;
        case IndicatorState.BLACKLISTED: text = "Сайт в черном списке"; bgColor = 'rgba(100, 100, 100, 0.8)'; textColor = '#eee'; break;
        case IndicatorState.NO_MIC_ACCESS: text = "Нет доступа к микрофону"; bgColor = 'rgba(220, 50, 50, 0.85)'; break;
        case IndicatorState.PASSWORD_FIELD: text = "На полях паролей не работает"; bgColor = 'rgba(100, 100, 100, 0.8)'; textColor = '#eee'; break;
        case IndicatorState.RECOGNITION_ERROR: text = "Ошибка распознавания"; bgColor = 'rgba(255, 100, 0, 0.85)'; break;
        default: indicatorElement.style.visibility = 'hidden'; indicatorElement.style.opacity = '0'; return;
    }
    indicatorElement.textContent = text; indicatorElement.style.backgroundColor = bgColor; indicatorElement.style.color = textColor;
    indicatorElement.style.visibility = 'visible'; indicatorElement.style.opacity = '1';
    if (newState !== IndicatorState.LISTENING && newState !== IndicatorState.PROCESSING && newState !== IndicatorState.TRANSLATING && newState !== IndicatorState.PROMPT_COLLECTING) {
        indicatorElement.textContent = text;
    }
    positionIndicator();
    if (temporaryMessage) {
        temporaryIndicatorClearTimer = setTimeout(() => {
            if (currentIndicatorState === newState && (newState === IndicatorState.BLACKLISTED || newState === IndicatorState.PASSWORD_FIELD || newState === IndicatorState.RECOGNITION_ERROR) && newState !== IndicatorState.NO_MIC_ACCESS) {
                updateIndicatorState(IndicatorState.IDLE);
            }
        }, 3000);
    }
}

function animateDots(baseText) {
    if (!indicatorElement ||
        (currentIndicatorState !== IndicatorState.LISTENING &&
         currentIndicatorState !== IndicatorState.PROCESSING &&
         currentIndicatorState !== IndicatorState.TRANSLATING &&
         currentIndicatorState !== IndicatorState.PROMPT_COLLECTING)
       ) {
        clearTimeout(indicatorUpdateTimer); return;
    }
    dotCount = (dotCount + 1) % 4; indicatorElement.textContent = baseText + '.'.repeat(dotCount);
    indicatorUpdateTimer = setTimeout(() => animateDots(baseText), 350);
}

function positionIndicator(checkFocusAndVisibility = false) {
    if (!indicatorElement || indicatorElement.style.visibility === 'hidden') return;
    const target = indicatorElement.targetElement;
    if (!target || !document.body || !document.body.contains(target)) { updateIndicatorState(IndicatorState.IDLE); return; }
    if (checkFocusAndVisibility && document.activeElement !== target) {
        if (currentIndicatorState === IndicatorState.LISTENING || currentIndicatorState === IndicatorState.PROCESSING ||
            currentIndicatorState === IndicatorState.TRANSLATING || currentIndicatorState === IndicatorState.PROMPT_COLLECTING) {
            updateIndicatorState(IndicatorState.IDLE); return;
        }
    }
    const rect = target.getBoundingClientRect();
    let top = rect.top - indicatorElement.offsetHeight - 3; // Позиция индикатора
    let left = rect.left + 5;
    const safetyMargin = 3;
    if (top < safetyMargin) top = safetyMargin;
    if (left + indicatorElement.offsetWidth > rect.right - 5 && rect.width > indicatorElement.offsetWidth + 10) {}
    else if (rect.width < indicatorElement.offsetWidth + 10) {
        left = rect.left - indicatorElement.offsetWidth - 5; if (left < safetyMargin) left = rect.right + 5;
    }
    if (left < safetyMargin) left = safetyMargin;
    if (left + indicatorElement.offsetWidth > window.innerWidth - safetyMargin) left = window.innerWidth - indicatorElement.offsetWidth - safetyMargin;
    if (top + indicatorElement.offsetHeight > window.innerHeight - safetyMargin) top = window.innerHeight - indicatorElement.offsetHeight - safetyMargin;
    indicatorElement.style.top = `${Math.round(top)}px`; indicatorElement.style.left = `${Math.round(left)}px`;
}

async function processFinalTranscript(rawFinalText, targetElement, userHasEdited, isReplacingInterim, replaceStartPos = 0, replaceLength = 0) {
  if (!targetElement || !document.body.contains(targetElement) || !isEditable(targetElement)) {
    isProcessingTranscript = false;
    if (isRecognitionActuallyRunning && recognition && recognition.targetElement === targetElement) updateIndicatorState(isPromptGeneratorModeActive ? IndicatorState.PROMPT_COLLECTING : IndicatorState.LISTENING, targetElement);
    else updateIndicatorState(IndicatorState.IDLE);
    return;
  }
  isProcessingTranscript = true;
  if (!isReplacingInterim || settings.translationActive) {
      updateIndicatorState(IndicatorState.PROCESSING, targetElement);
  }

  try {
    let textForProcessing = rawFinalText;
    if (settings.disableBrowserAutoPunctuation) {
        textForProcessing = textForProcessing.replace(/(?<!\w)[.,!?;:"](?!\w)/g, '').replace(/[.,!?;:"]\s*$/,'');
    }

    let textAfterAutoreplace = applyAutoReplace(textForProcessing);
    let textToInsert = textAfterAutoreplace;

    const commandProcessed = processFormattingCommands(textAfterAutoreplace.toLowerCase(), targetElement, isReplacingInterim, replaceStartPos, replaceLength);

    if (commandProcessed) {
        if (["удалить слово", "удалить всё", "стереть всё"].includes(textAfterAutoreplace.toLowerCase())) { textToInsert = ""; }
        else if (["новая строка", "новый абзац", "абзац"].includes(textAfterAutoreplace.toLowerCase())) { textToInsert = ""; }
    }

    if (settings.translationActive && settings.geminiApiKey && textToInsert.trim()) {
      updateIndicatorState(IndicatorState.TRANSLATING, targetElement);
      try {
        const translatedText = await translateTextViaBackground(textToInsert, settings.dictationLang, settings.translationLang, settings.geminiApiKey,
                                                                (settings.geminiModel === 'custom' && settings.customGeminiModel) ? settings.customGeminiModel : settings.geminiModel);
        if (translatedText && translatedText.trim() && translatedText.toLowerCase() !== textToInsert.toLowerCase()) {
            textToInsert = translatedText;
        }
      } catch (error) { console.error("SVI: Translation error in final pipeline:", error.message); }
    }

    if (!commandProcessed && textToInsert.trim()) {
        if (isReplacingInterim && settings.interimResultsEnabled) {
            replaceTextRange(targetElement, replaceStartPos, replaceStartPos + replaceLength, textToInsert + ' ');
            setCursorPosition(targetElement, replaceStartPos + textToInsert.length + 1);
        } else {
            if (document.activeElement === targetElement) insertText(targetElement, textToInsert + ' ');
            else if (currentFocusedInput && isEditable(currentFocusedInput) && document.activeElement === currentFocusedInput) {
                insertText(currentFocusedInput, textToInsert + ' ');
            }
        }
        triggerInputEvents(targetElement);
    } else if (commandProcessed) {
        triggerInputEvents(targetElement);
    }

  } catch (e) {
      console.error("SVI: Error in processFinalTranscript final pipeline:", e);
  } finally {
    isProcessingTranscript = false;
    if (isRecognitionActuallyRunning && recognition && recognition.targetElement === targetElement) updateIndicatorState(isPromptGeneratorModeActive ? IndicatorState.PROMPT_COLLECTING : IndicatorState.LISTENING, targetElement);
    else if (currentIndicatorState !== IndicatorState.IDLE && currentIndicatorState !== IndicatorState.NO_MIC_ACCESS) updateIndicatorState(IndicatorState.IDLE);
    if (transcriptQueue.length > 0) {
        const nextJob = transcriptQueue.shift();
        processFinalTranscript(nextJob.text, nextJob.target, nextJob.userHasEdited, nextJob.isReplacingInterim, nextJob.replaceStart, nextJob.replaceLength);
    }
  }
}

function applyAutoReplace(text) {
  if (!parsedAutoReplaceRules || parsedAutoReplaceRules.length === 0) { return text; }
  let resultText = text;
  parsedAutoReplaceRules.forEach(rule => { resultText = resultText.replace(rule.regex, rule.value); });
  return resultText;
}

function processFormattingCommands(textLC, targetElement, isReplacingInterim = false, interimStart = 0, interimLength = 0) {
    const commands = {
        "удалить слово": () => deleteLastWord(targetElement),
        "удалить всё": () => clearInput(targetElement),
        "стереть всё": () => clearInput(targetElement),
        "новая строка": () => {
            const textToInsertCmd = '\n';
            if (isReplacingInterim && settings.interimResultsEnabled) replaceTextRange(targetElement, interimStart, interimStart + interimLength, textToInsertCmd);
            else insertText(targetElement, textToInsertCmd);
        },
        "новый абзац": () => {
            const textToInsertCmd = '\n\n';
            if (isReplacingInterim && settings.interimResultsEnabled) replaceTextRange(targetElement, interimStart, interimStart + interimLength, textToInsertCmd);
            else insertText(targetElement, textToInsertCmd);
        },
        "абзац": () => {
            const textToInsertCmd = '\n\n';
            if (isReplacingInterim && settings.interimResultsEnabled) replaceTextRange(targetElement, interimStart, interimStart + interimLength, textToInsertCmd);
            else insertText(targetElement, textToInsertCmd);
        }
    };
    if (commands[textLC]) {
        commands[textLC]();
        return true;
    } return false;
}

function deleteLastWord(element) {
    const isContentEditable = element.isContentEditable;
    if (isContentEditable) { document.execCommand('undo'); }
    else {
        let value = element.value; let selStart = element.selectionStart; let textBefore = value.substring(0, selStart);
        if (element.selectionStart !== element.selectionEnd) {
            element.value = value.substring(0, element.selectionStart) + value.substring(element.selectionEnd);
            element.selectionStart = element.selectionEnd = element.selectionStart;
        } else {
            const trimmedTextBefore = textBefore.trimEnd(); const lastSpace = trimmedTextBefore.lastIndexOf(' ');
            textBefore = (lastSpace !== -1) ? trimmedTextBefore.substring(0, lastSpace + 1) : '';
            element.value = textBefore + value.substring(selStart);
            element.selectionStart = element.selectionEnd = textBefore.length;
        }
    }
    triggerInputEvents(element);
}

function clearInput(element) {
    if (element.isContentEditable) { element.innerHTML = ''; } else { element.value = ''; }
    triggerInputEvents(element);
}

function insertText(element, textToInsert) {
  if (!element || !document.body || !document.body.contains(element)) return; element.focus();
  if (element.isContentEditable) { document.execCommand('insertText', false, textToInsert); }
  else if (typeof element.selectionStart === 'number') {
    const start = element.selectionStart, end = element.selectionEnd;
    const scrollTop = element.scrollTop;
    element.value = element.value.substring(0, start) + textToInsert + element.value.substring(end);
    element.selectionStart = element.selectionEnd = start + textToInsert.length;
    element.scrollTop = scrollTop;
  } else { element.value += textToInsert; }
  triggerInputEvents(element);
}

function translateTextViaBackground(text, sourceLang, targetLang, apiKey, model) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        command: "translateTextViaGemini",
        textToTranslate: text,
        sourceLang: sourceLang,
        targetLang: targetLang,
        apiKey: apiKey,
        model: model
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("SVI Content: Error sending translate message to background:", chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response) {
          if (response.success && response.translatedText) {
            resolve(response.translatedText);
          } else {
            console.error("SVI Content: Translation failed in background:", response.error);
            resolve(text);
          }
        } else {
          console.error("SVI Content: No response from background for translation.");
          resolve(text);
        }
      }
    );
  });
}

// --- Запуск ---
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(loadSettingsAndInitialize, 200));
} else { setTimeout(loadSettingsAndInitialize, 200); }