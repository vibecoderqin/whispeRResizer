'use strict';

// Clicking the toolbar action or the item in Chrome's Extensions menu opens
// the registered extension options page.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
