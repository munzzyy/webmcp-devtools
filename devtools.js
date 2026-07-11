// devtools.js
//
// Runs once per open DevTools window, in the special "devtools page" context
// (this is NOT a content script and NOT the panel itself -- it only has
// access to chrome.devtools.* APIs). Its only job is to register the
// "WebMCP" panel; all real logic lives in panel.js.

chrome.devtools.panels.create('WebMCP', 'icons/icon-16.png', 'panel.html', () => {
  if (chrome.runtime.lastError) {
    // Nothing useful to show the user here -- there's no UI surface yet if
    // panel creation itself failed -- but log it so it's visible in the
    // DevTools-of-DevTools / extension service worker console.
    console.error('webmcp-devtools: failed to create the WebMCP panel', chrome.runtime.lastError);
  }
});
