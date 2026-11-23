const settingsApi = globalThis.JaSubSettings;
const styleApi = globalThis.JaSubStyle;
const sourceSelect = document.querySelector('#source');
const targetSelect = document.querySelector('#target');
const enabledInput = document.querySelector('#enabled');
const originalInput = document.querySelector('#show-original');
const hideInput = document.querySelector('#hide-site');
const fontStyleSelect = document.querySelector('#font-style');
const backgroundSelect = document.querySelector('#background-style');
const fontInput = document.querySelector('#font-size');
const bottomInput = document.querySelector('#bottom');
const offsetInput = document.querySelector('#offset');
const bgAlphaInput = document.querySelector('#bg-alpha');
const textAlphaInput = document.querySelector('#text-alpha');
const statusNode = document.querySelector('#status');
const noteNode = document.querySelector('#note');
let settings = { ...settingsApi.DEFAULTS };
let saveTimer = 0;

init();

async function init() {
  settings = await settingsApi.load();
  fillSelect(sourceSelect, settingsApi.SOURCES, settings.sourceLanguage);
  fillTargets();
  enabledInput.checked = settings.enabled !== false;
  originalInput.checked = settings.showOriginal !== false;
  hideInput.checked = Boolean(settings.hideSiteSubs);
  fillSelect(fontStyleSelect, styleApi.FONTS.map((item) => ({ code: item.id, label: item.label })), settings.fontStyle || 'sans');
  fillSelect(backgroundSelect, styleApi.BACKGROUNDS.map((item) => ({ code: item.id, label: item.label })), settings.backgroundStyle || 'plate');
  fontInput.value = settings.fontSize;
  bottomInput.value = settings.bottom;
  offsetInput.value = settings.offset;
  bgAlphaInput.value = Math.round(Number(settings.backgroundOpacity ?? 0.66) * 100);
  textAlphaInput.value = Math.round(Number(settings.textOpacity ?? 1) * 100);
  showNumbers();
  bind();
  await refreshStatus();
}

function bind() {
  enabledInput.addEventListener('change', () => saveNow({ enabled: enabledInput.checked }));
  originalInput.addEventListener('change', () => saveNow({ showOriginal: originalInput.checked }));
  hideInput.addEventListener('change', () => saveNow({ hideSiteSubs: hideInput.checked }));
  fontStyleSelect.addEventListener('change', () => saveNow({ fontStyle: fontStyleSelect.value }));
  backgroundSelect.addEventListener('change', () => saveNow({ backgroundStyle: backgroundSelect.value }));
  sourceSelect.addEventListener('change', () => {
    settings.sourceLanguage = sourceSelect.value;
    fillTargets();
    saveNow({ sourceLanguage: sourceSelect.value, targetLanguage: targetSelect.value });
    refreshStatus();
  });
  targetSelect.addEventListener('change', () => {
    settings.targetLanguage = targetSelect.value;
    saveNow({ targetLanguage: targetSelect.value });
    refreshStatus();
  });
  for (const input of [fontInput, bottomInput, offsetInput, bgAlphaInput, textAlphaInput]) {
    input.addEventListener('input', () => {
      showNumbers();
      saveSoon(appearance());
    });
  }
  document.querySelector('#setup').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open-setup' });
  });
  document.querySelector('#player').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open-player' });
  });
  document.querySelector('#upload-srt').addEventListener('click', openUploader);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.fontSize) fontInput.value = changes.fontSize.newValue;
    if (changes.bottom) bottomInput.value = changes.bottom.newValue;
    if (changes.offset) offsetInput.value = changes.offset.newValue;
    if (changes.backgroundOpacity) bgAlphaInput.value = Math.round(Number(changes.backgroundOpacity.newValue) * 100);
    if (changes.textOpacity) textAlphaInput.value = Math.round(Number(changes.textOpacity.newValue) * 100);
    if (changes.fontStyle) fontStyleSelect.value = changes.fontStyle.newValue;
    if (changes.backgroundStyle) backgroundSelect.value = changes.backgroundStyle.newValue;
    showNumbers();
    if (changes.modelReadyAt || changes.sourceLanguage || changes.targetLanguage) refreshStatus();
  });
}

function fillSelect(select, options, selected) {
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.code;
    node.textContent = option.label;
    node.selected = option.code === selected;
    select.appendChild(node);
  }
}

function fillTargets() {
  const options = settingsApi.TARGETS.filter((item) => item.code !== sourceSelect.value);
  if (!options.some((item) => item.code === settings.targetLanguage)) {
    settings.targetLanguage = options[0].code;
  }
  fillSelect(targetSelect, options, settings.targetLanguage);
}

function appearance() {
  return {
    fontSize: Number(fontInput.value),
    bottom: Number(bottomInput.value),
    offset: Number(offsetInput.value),
    backgroundOpacity: Number(bgAlphaInput.value) / 100,
    textOpacity: Number(textAlphaInput.value) / 100
  };
}

function showNumbers() {
  document.querySelector('#font-value').textContent = fontInput.value;
  document.querySelector('#bottom-value').textContent = bottomInput.value;
  document.querySelector('#offset-value').textContent = Number(offsetInput.value).toFixed(1);
  document.querySelector('#bg-alpha-value').textContent = bgAlphaInput.value;
  document.querySelector('#text-alpha-value').textContent = textAlphaInput.value;
}

function saveSoon(partial) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(partial), 80);
}

function saveNow(partial) {
  Object.assign(settings, partial);
  return settingsApi.save(partial);
}

async function openUploader() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || /^(chrome|edge|about|devtools):/.test(tab.url)) {
    noteNode.textContent = '请先打开正在播放的视频页面，再上传 SRT。';
    return;
  }
  const params = new URLSearchParams({ tabId: String(tab.id) });
  if (tab.url.length < 4000) params.set('url', tab.url);
  await chrome.windows.create({
    url: `${chrome.runtime.getURL('upload/upload.html')}?${params}`,
    type: 'popup',
    width: 440,
    height: 340
  });
}

async function refreshStatus() {
  statusNode.className = 'status';
  statusNode.textContent = '正在连接本地模型…';
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'warm',
      sourceLanguage: sourceSelect.value || settings.sourceLanguage,
      targetLanguage: targetSelect.value || settings.targetLanguage
    });
  } catch (error) {
    response = { ok: false, error: '翻译进程没有启动' };
  }
  if (response?.ready) {
    statusNode.className = 'status ready';
    const count = response.dictSize ? `，已记住 ${response.dictSize} 句` : '';
    statusNode.textContent = `模型已就绪${count}。靠近播放位置的句子会先译好。`;
    return;
  }
  statusNode.className = 'status warn';
  if (response?.code === 'NO_API') {
    statusNode.textContent = '需要桌面版 Chrome 138 或更高版本。';
    return;
  }
  if (response?.code === 'UNAVAILABLE') {
    statusNode.textContent = '这台电脑不支持这个语言方向。';
    return;
  }
  statusNode.textContent = '模型还没下载。点下面的按钮，只需一次。';
}
