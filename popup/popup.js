document.addEventListener('DOMContentLoaded', () => {
  const toggleCheckbox = document.getElementById('toggleDictation');
  const languageSelect = document.getElementById('languageSelect');

  // Загружаем сохраненные настройки
  chrome.storage.sync.get(['dictationActive', 'dictationLang'], (result) => {
    toggleCheckbox.checked = result.dictationActive !== undefined ? result.dictationActive : true;
    if (result.dictationLang) {
      languageSelect.value = result.dictationLang;
    } else {
      languageSelect.value = 'ru-RU'; // Значение по умолчанию, если в storage пусто
    }
  });

  // Сохраняем и отправляем состояние при изменении чекбокса
  toggleCheckbox.addEventListener('change', () => {
    const isActive = toggleCheckbox.checked;
    chrome.storage.sync.set({ dictationActive: isActive }, () => {
      console.log('Popup: Dictation active state saved:', isActive);
      // Отправляем сообщение активной вкладке
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, { command: "toggleDictation", data: isActive }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn("Popup: Error sending toggleDictation message:", chrome.runtime.lastError.message);
            } else {
              console.log("Popup: toggleDictation message response:", response);
            }
          });
        }
      });
    });
  });

  // Сохраняем язык и отправляем сообщение
  languageSelect.addEventListener('change', () => {
    const lang = languageSelect.value;
    chrome.storage.sync.set({ dictationLang: lang }, () => {
      console.log('Popup: Dictation language saved:', lang);
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, { command: "languageChanged", newLang: lang }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn("Popup: Error sending languageChanged message:", chrome.runtime.lastError.message);
            } else {
              console.log("Popup: languageChanged message response:", response);
            }
          });
        }
      });
    });
  });
});