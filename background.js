// background.js

// Функция для обновления иконки и всплывающей подсказки
function updateActionState(isActive) {
  const iconPathPrefix = isActive ? "icons/icon-on-" : "icons/icon-off-";
  const title = isActive ? "Голосовой Ввод (Включено)" : "Голосовой Ввод (Выключено)";

  chrome.action.setIcon({
    path: {
      "16": `${iconPathPrefix}16.png`,
      "32": `${iconPathPrefix}32.png`,
      "48": `${iconPathPrefix}48.png`,
      "128": `${iconPathPrefix}128.png`
    }
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn("Ошибка установки иконки:", chrome.runtime.lastError.message);
      // Это может произойти, если иконки еще не существуют при первой загрузке
    }
  });
  chrome.action.setTitle({ title: title });
}

// 1. Устанавливаем начальное состояние иконки при установке/обновлении
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.sync.get(['dictationActive', 'dictationLang'], (result) => {
    const initialState = {
      dictationActive: result.dictationActive !== undefined ? result.dictationActive : true, // Включено по умолчанию
      dictationLang: result.dictationLang || 'ru-RU' // Русский по умолчанию
    };
    chrome.storage.sync.set(initialState, () => {
      updateActionState(initialState.dictationActive);
      console.log('Расширение установлено/обновлено. Начальные настройки применены. Состояние:', initialState.dictationActive);
    });
  });
});

// 2. Слушаем изменения в chrome.storage, чтобы обновить иконку,
//    если состояние было изменено из popup.js
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.dictationActive) {
    const isActive = changes.dictationActive.newValue;
    updateActionState(isActive);
    console.log('Состояние dictationActive изменилось в storage, иконка обновлена на:', isActive);
  }
});

 // 3. При запуске браузера, если расширение уже установлено, убедимся, что иконка правильная
 // (onInstalled покрывает первый запуск, но это для последующих запусков браузера)
 chrome.runtime.onStartup.addListener(() => {
     chrome.storage.sync.get('dictationActive', (result) => {
         updateActionState(result.dictationActive !== undefined ? result.dictationActive : true);
     });
 });