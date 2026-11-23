const OFFSCREEN_URL = 'offscreen.html';

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen().catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translation') return;
  const stored = await chrome.storage.local.get({ enabled: true });
  await chrome.storage.local.set({ enabled: stored.enabled === false });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === 'offscreen' || message.target === 'engine' || message.type === 'translation') {
    return;
  }

  if (message.type === 'whoami') {
    sendResponse({ tabId: _sender.tab?.id ?? null });
    return false;
  }

  if (message.type === 'ensure-offscreen') {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'open-setup' || message.type === 'open-player') {
    const page = message.type === 'open-player' ? 'player/player.html' : 'setup/setup.html';
    chrome.tabs.create({ url: chrome.runtime.getURL(page) });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'warm' || message.type === 'get-status') {
    forward(message).then(sendResponse);
    return true;
  }

  if (message.type === 'translate') {
    routeTranslate(message).then(sendResponse);
    return true;
  }
});

async function forward(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

async function routeTranslate(message) {
  await ensureOffscreen();
  let offscreenResponse = null;
  try {
    offscreenResponse = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
    if (offscreenResponse?.ok) return offscreenResponse;
  } catch (error) {
    offscreenResponse = null;
  }

  try {
    const engineResponse = await chrome.runtime.sendMessage({ ...message, target: 'engine' });
    if (engineResponse?.ok) return engineResponse;
  } catch (error) {
    /* No setup or player page is holding a model yet. */
  }

  return offscreenResponse || {
    ok: false,
    code: 'NEED_DOWNLOAD',
    error: '请先点击插件里的「下载翻译模型」。模型只需要下载一次。'
  };
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (existing.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'Keep the on-device translation model loaded so subtitle lines can be ready before they appear.'
    });
  } catch (error) {
    const text = String(error);
    if (!text.includes('offscreen')) throw error;
  }
}
