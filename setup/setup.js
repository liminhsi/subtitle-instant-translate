const settingsApi = globalThis.JaSubSettings;
const sourceSelect = document.querySelector('#source');
const targetSelect = document.querySelector('#target');
const button = document.querySelector('#download');
const fill = document.querySelector('#fill');
const statusNode = document.querySelector('#status');
let settings = { ...settingsApi.DEFAULTS };
let queue = null;
let translator = null;

globalThis.JaSubEngine.installEngine(() => queue);

init();

async function init() {
  settings = await settingsApi.load();
  fillSelect(sourceSelect, settingsApi.SOURCES, settings.sourceLanguage);
  fillTargets();
  sourceSelect.addEventListener('change', () => {
    settings.sourceLanguage = sourceSelect.value;
    fillTargets();
    settingsApi.save({ sourceLanguage: sourceSelect.value, targetLanguage: targetSelect.value });
  });
  targetSelect.addEventListener('change', () => {
    settings.targetLanguage = targetSelect.value;
    settingsApi.save({ targetLanguage: targetSelect.value });
  });
  button.addEventListener('click', download);
  const existing = await chrome.runtime.sendMessage({
    type: 'warm',
    sourceLanguage: sourceSelect.value,
    targetLanguage: targetSelect.value
  }).catch(() => null);
  if (existing?.ready) {
    statusNode.textContent = '模型已经在这台电脑上，可以直接回到视频页面。';
    button.textContent = '重新连接模型';
  }
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

function download() {
  const options = {
    sourceLanguage: sourceSelect.value,
    targetLanguage: targetSelect.value
  };
  let pending;
  try {
    pending = globalThis.JaSubModel.startModelDownload(options, (ratio) => {
      fill.style.width = `${Math.round(ratio * 100)}%`;
      statusNode.textContent = ratio > 0 ? `正在下载 ${Math.round(ratio * 100)}%` : '正在开始下载…';
    });
  } catch (error) {
    statusNode.textContent = error.message;
    return;
  }
  button.disabled = true;
  pending
    .then(async (created) => {
      translator = created;
      queue = globalThis.JaSubEngine.createQueue({
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        getTranslator: () => translator
      });
      await queue.ensureLoaded();
      fill.style.width = '100%';
      await chrome.storage.local.set({
        modelReadyAt: Date.now(),
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage
      });
      const warm = await chrome.runtime.sendMessage({ type: 'warm', ...options }).catch(() => null);
      if (warm?.ready) {
        releaseLocalModel();
        statusNode.textContent = '模型已就绪。回到正在播放的页面即可，这个页面可以关掉。';
      } else {
        statusNode.textContent = '模型已下载。请先留着这个页面，它会暂时负责翻译。';
      }
    })
    .catch((error) => {
      statusNode.textContent = error?.message || '下载没有完成';
    })
    .finally(() => {
      button.disabled = false;
    });
}

function releaseLocalModel() {
  queue = null;
  if (translator && typeof translator.destroy === 'function') {
    try {
      translator.destroy();
    } catch (error) {
      /* The browser already released it. */
    }
  }
  translator = null;
}
