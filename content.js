let recognition;
let currentFocusedInput = null;
let isDictationActive = true; // По умолчанию включено, будет обновлено из storage
let currentLang = 'ru-RU';    // По умолчанию, будет обновлено из storage
let recognitionRestartTimer = null; // Таймер для перезапуска

// Загрузка настроек при старте
function loadSettingsAndInit() {
    chrome.storage.sync.get(['dictationActive', 'dictationLang'], (result) => {
        isDictationActive = result.dictationActive !== undefined ? result.dictationActive : true;
        currentLang = result.dictationLang || 'ru-RU';
        console.log('Content Script: Dictation active state loaded:', isDictationActive, 'Language:', currentLang);
        // Если при загрузке скрипта уже есть активный инпут и диктовка включена
        if (isDictationActive && document.activeElement && isEditable(document.activeElement)) {
            currentFocusedInput = document.activeElement;
            startRecognition(currentFocusedInput);
        }
    });
}

loadSettingsAndInit(); // Вызываем при первой загрузке скрипта

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.command === "toggleDictation") {
        isDictationActive = request.data;
        console.log('Content Script: Dictation state changed to:', isDictationActive);
        if (!isDictationActive && recognition) {
            stopRecognition();
        } else if (isDictationActive && currentFocusedInput) {
            startRecognition(currentFocusedInput);
        }
        sendResponse({ status: "ok" });
    } else if (request.command === "languageChanged") {
        currentLang = request.newLang;
        console.log('Content Script: Language changed to:', currentLang);
        if (recognition && (recognition.recognizing || recognition.isRecording)) { // isRecording - гипотетическое свойство, лучше просто проверять recognition
            stopRecognition();
            // Даем время полностью остановиться перед новым запуском
            setTimeout(() => {
                if (currentFocusedInput && isDictationActive) { // Перепроверка состояния
                    startRecognition(currentFocusedInput);
                }
            }, 250);
        }
        sendResponse({ status: "language update processed" });
    }
    return true; // Для асинхронного sendResponse
});

function isEditable(element) {
    return element && (
        (element.tagName === 'INPUT' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type.toLowerCase())) ||
        element.tagName === 'TEXTAREA' ||
        element.isContentEditable
    ) && !element.disabled && !element.readOnly;
}


function startRecognition(targetElement) {
    if (!isDictationActive || !targetElement) return;
    if (!('webkitSpeechRecognition' in window)) {
        console.error("Speech Recognition API не поддерживается.");
        alert("Голосовой ввод не поддерживается в вашем браузере.");
        return;
    }

    if (recognition && (typeof recognition.recognizing !== 'undefined' ? recognition.recognizing : false)) { // `recognizing` не стандартное свойство, проверяем его наличие
        console.log("Распознавание уже активно.");
        return;
    }
    
    clearTimeout(recognitionRestartTimer); // Отменяем предыдущий таймер перезапуска, если есть

    recognition = new webkitSpeechRecognition();
    recognition.lang = currentLang;
    recognition.continuous = true; // Важно для длительной диктовки
    recognition.interimResults = true;

    let lastFinalTranscriptTime = Date.now();

    recognition.onstart = () => {
        console.log("Распознавание начато для:", targetElement);
        targetElement.style.boxShadow = "0 0 5px 2px rgba(255,0,0,0.7)"; // Индикатор
        recognition.recognizing = true; // Пользовательский флаг
    };

    recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
                lastFinalTranscriptTime = Date.now(); // Обновляем время последнего финального результата
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }

        if (finalTranscript.trim()) {
            insertText(targetElement, finalTranscript.trim() + ' ');
        }
        // Отображение interim результатов можно сделать более сложным, чтобы не мешать вводу
        // Пока что для простоты не будем активно вставлять interim, чтобы не было "прыжков"
        // console.log('Interim:', interimTranscript);
    };

    recognition.onerror = (event) => {
        console.error("Ошибка распознавания:", event.error);
        recognition.recognizing = false;
        targetElement.style.boxShadow = ""; // Снять индикатор

        if (event.error === 'no-speech' && isDictationActive && recognition.continuous) {
            console.log("No speech, but continuous is on. Will attempt restart via onend.");
        } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            alert("Доступ к микрофону запрещен. Пожалуйста, разрешите доступ и перезагрузите страницу или расширение.");
            isDictationActive = false; // Выключить, чтобы не пытаться снова
            chrome.storage.sync.set({ dictationActive: false }); // Обновить в storage -> обновит иконку
            // Сообщить в popup, если он открыт (сложнее, т.к. popup может быть не активен)
        } else if (event.error === 'network') {
            console.warn("Проблема с сетью при распознавании.");
        }
    };

    recognition.onend = () => {
        console.log("Распознавание завершено (onend).");
        recognition.recognizing = false;
        if (targetElement) targetElement.style.boxShadow = ""; // Снять индикатор

        // Если распознавание должно продолжаться (continuous=true, isDictationActive=true)
        // и оно не было остановлено принудительно (через stopRecognition, который ставит continuous=false)
        // Web Speech API может сам останавливаться (например, после долгой тишины или таймаута ~1 мин)
        if (recognition && recognition.continuous && isDictationActive && currentFocusedInput === targetElement) {
            console.log("Continuous mode: Re-starting recognition after short delay.");
            // Перезапуск с небольшой задержкой, чтобы избежать слишком частых циклов
            clearTimeout(recognitionRestartTimer); // На всякий случай
            recognitionRestartTimer = setTimeout(() => {
                if (isDictationActive && currentFocusedInput === targetElement) { // Доп. проверка
                    try {
                        recognition.start();
                    } catch (e) {
                        console.warn("Could not restart recognition (already started or other issue):", e);
                    }
                }
            }, 250);
        } else {
            recognition = null; // Освобождаем, если не перезапускаем
        }
    };

    try {
        recognition.start();
    } catch (e) {
        console.error("Не удалось запустить распознавание:", e);
        recognition.recognizing = false;
        if (targetElement) targetElement.style.boxShadow = "";
    }
}

function stopRecognition() {
    clearTimeout(recognitionRestartTimer); // Отменить любой запланированный перезапуск
    if (recognition) {
        recognition.continuous = false; // Предотвратить автоматический перезапуск в onend
        recognition.stop();
        // recognition = null; // Лучше в onend, чтобы обработчик отработал
        console.log("Распознавание остановлено принудительно.");
    }
}

function insertText(element, textToInsert) {
    if (element.isContentEditable) {
        // Для contentEditable лучше использовать execCommand или Selection API
        // Простой вариант:
        document.execCommand('insertText', false, textToInsert);
    } else if (typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
        // Для input/textarea
        const start = element.selectionStart;
        const end = element.selectionEnd;
        const M_val = element.value;
        element.value = M_val.substring(0, start) + textToInsert + M_val.substring(end);
        element.selectionStart = element.selectionEnd = start + textToInsert.length;
        // Инициировать событие input, чтобы Angular/React/Vue и др. фреймворки среагировали
        const event = new Event('input', { bubbles: true, cancelable: true });
        element.dispatchEvent(event);
    } else { // Fallback
        element.value += textToInsert;
        const event = new Event('input', { bubbles: true, cancelable: true });
        element.dispatchEvent(event);
    }
}

document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (isEditable(target)) {
        if (target.type === 'password') return; // Не активировать на полях пароля

        console.log('Фокус на:', target);
        currentFocusedInput = target;
        if (isDictationActive) {
            // Если уже есть активное распознавание для другого элемента, остановить его
            if (recognition && recognition.recognizing && target !== (recognition.currentTarget || currentFocusedInput)) { // currentTarget нет в SpeechRecognition
                stopRecognition();
            }
            // Небольшая задержка перед стартом, чтобы избежать ложных срабатываний при быстрой смене фокуса
            setTimeout(() => {
                if (currentFocusedInput === target && isDictationActive) { // Проверяем, что фокус все еще здесь
                    startRecognition(target);
                }
            }, 100);
        }
    }
});

document.addEventListener('focusout', (event) => {
    const target = event.target;
    // Проверяем, что это тот элемент, для которого шло распознавание
    if (target === currentFocusedInput) {
        console.log('Потеря фокуса с:', target);
        // Не останавливать сразу, если continuous=true, API сам может перезапуститься или остановиться
        // Остановка здесь может помешать 'onend' перезапустить распознавание, если это было кратковременное "моргание" фокуса
        // Однако, если пользователь явно ушел с поля, нужно остановить.
        // Давайте сделаем так: если распознавание активно, остановим его.
        if (recognition && recognition.recognizing) { // Проверяем пользовательский флаг
             stopRecognition();
        }
        currentFocusedInput = null; // Сбрасываем текущий активный инпут
    }
});

// Обработка выгрузки страницы
window.addEventListener('beforeunload', () => {
    if (recognition) {
        stopRecognition();
    }
});