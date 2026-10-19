// Click the toolbar icon (or press Alt+Shift+K) -> inject / toggle the keyboard on the current tab.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (e) {
    // chrome:// pages, the Web Store, PDF viewer etc. can't be scripted.
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#c0392b' });
    chrome.action.setBadgeText({ tabId: tab.id, text: 'X' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2500);
  }
});

// First install: open the camera-permission page once.
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
});
