const settingsApi = globalThis.JaSubSettings;
const Subs = globalThis.Subs;
const stage = document.querySelector('#stage');
const video = document.querySelector('#video');
const screen = document.querySelector('#screen');
const originalNode = document.querySelector('#original');
const translationNode = document.querySelector('#translation');
const progressNode = document.querySelector('#progress');
const statusNode = document.querySelector('#status');
const seek = document.querySelector('#seek');
const clock = document.querySelector('#clock');
const playButton = document.querySelector('#play');
const downloadButton = document.querySelector('#download');

let settings = { ...settingsApi.DEFAULTS };
let cues = [];
let client = null;
let queue = null;
let translator = null;
let useRemote = false;
let mode = 'empty';
let playing = false;
let clockTime = 0;
let clockStamp = 0;
let duration = 0;
let objectUrl = '';
let prefetchToken = 0;
let raf = 0;
let lastSignature = '';
let styleTimer = 0;
let pendingStyle = null;
const giveUp = new Set();

globalThis.JaSubEngine.installEngine(() => (useRemote ? null : queue));
client = globalThis.JaSubClient.createClient();
client.onUpdate((message) => {
  const active = Subs.activeCues(cues, mediaTime());
  if (!message?.text || active.some((cue) => cue.text === message.text)) paint();
});

init();

async function init() {
  settings = await settingsApi.load();
  applyAppearance();
  bind();
  await connectModel(false);
}

function bind() {
  downloadButton.addEventListener('click', downloadModel);
  playButton.addEventListener('click', togglePlay);
  document.querySelector('#demo').addEventListener('click', loadDemo);
  document.querySelector('#fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen();
  });
  document.querySelector('#sooner').addEventListener('click', () => shiftOffset(0.5));
  document.querySelector('#later').addEventListener('click', () => shiftOffset(-0.5));
  document.querySelector('#video-file').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) setVideoFile(file);
  });
  document.querySelector('#sub-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await setSubtitleFile(file);
  });
  seek.addEventListener('input', () => {
    const value = Number(seek.value);
    if (mode === 'video') video.currentTime = value;
    else clockTime = value;
    paint();
    startPrefetch();
  });
  stage.addEventListener('click', (event) => {
    if (event.target.closest('button, input, label, a')) return;
    togglePlay();
  });
  stage.addEventListener('dragover', (event) => event.preventDefault());
  stage.addEventListener('drop', async (event) => {
    event.preventDefault();
    for (const file of event.dataTransfer.files) await routeFile(file);
  });
  video.addEventListener('play', () => {
    playButton.textContent = '暂停';
    startLoop();
  });
  video.addEventListener('pause', () => {
    playButton.textContent = '播放';
    paint();
  });
  video.addEventListener('loadedmetadata', () => {
    duration = Number.isFinite(video.duration) ? video.duration : 0;
    seek.max = String(duration || 0);
    paint();
  });
  video.addEventListener('seeked', () => {
    paint();
    startPrefetch();
  });
  window.addEventListener('keydown', onKey);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(settingsApi.DEFAULTS)) {
      if (changes[key]) settings[key] = changes[key].newValue;
    }
    applyAppearance();
    if (changes.sourceLanguage || changes.targetLanguage || changes.modelReadyAt) {
      client.clear();
      giveUp.clear();
      connectModel(false).then(startPrefetch);
    }
    paint();
  });
}

async function connectModel(userAsked) {
  const response = await chrome.runtime.sendMessage({
    type: 'warm',
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage
  }).catch(() => null);
  if (response?.ready) {
    useRemote = true;
    queue = null;
    if (translator && typeof translator.destroy === 'function') {
      try { translator.destroy(); } catch (error) { /* already released */ }
    }
    translator = null;
    await client.loadDict(settings.sourceLanguage, settings.targetLanguage);
    statusNode.textContent = '模型已就绪。字幕会先译好，播放时直接出现。';
    downloadButton.textContent = '重新连接模型';
    return true;
  }
  useRemote = false;
  if (!userAsked) {
    statusNode.textContent = response?.code === 'NO_API'
      ? '需要桌面版 Chrome 138 或更高版本。'
      : '第一次需要下载翻译模型，之后就可以整轨提前译好。';
  }
  return false;
}

function downloadModel() {
  const options = {
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage
  };
  let pending;
  try {
    pending = globalThis.JaSubModel.startModelDownload(options, (ratio) => {
      statusNode.textContent = `正在下载模型 ${Math.round(ratio * 100)}%`;
    });
  } catch (error) {
    statusNode.textContent = error.message;
    return;
  }
  downloadButton.disabled = true;
  pending
    .then(async (created) => {
      translator = created;
      queue = globalThis.JaSubEngine.createQueue({
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        getTranslator: () => translator
      });
      await queue.ensureLoaded();
      await chrome.storage.local.set({ modelReadyAt: Date.now() });
      const ready = await connectModel(true);
      if (!ready) {
        useRemote = false;
        statusNode.textContent = '模型已下载。这个页面会负责翻译，先不要关掉。';
      }
      startPrefetch();
    })
    .catch((error) => {
      statusNode.textContent = error?.message || '模型下载没有完成';
    })
    .finally(() => {
      downloadButton.disabled = false;
    });
}

async function loadDemo() {
  const response = await fetch(chrome.runtime.getURL('demo/sample.srt'));
  const text = await response.text();
  setCues(Subs.parseSubtitle(text, 'sample.srt'));
  mode = 'demo';
  video.pause();
  video.hidden = true;
  video.removeAttribute('src');
  screen.hidden = false;
  screen.textContent = '示例画面';
  clockTime = 0;
  duration = (cues.at(-1)?.end || 0) + 0.8;
  seek.max = String(duration);
  seek.value = '0';
  startPrefetch();
  paint();
}

function setVideoFile(file) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  mode = 'video';
  playing = false;
  video.hidden = false;
  screen.hidden = true;
  video.src = objectUrl;
  clockTime = 0;
}

async function setSubtitleFile(file) {
  const parsed = Subs.parseSubtitle(Subs.decodeSubtitleBytes(new Uint8Array(await file.arrayBuffer())), file.name);
  if (!parsed.length) {
    statusNode.textContent = '没有从这份文件里读出时间轴。请换 srt、vtt 或 ass。';
    return;
  }
  setCues(parsed);
  if (mode === 'empty') {
    mode = 'demo';
    screen.hidden = false;
    screen.textContent = file.name;
    duration = (cues.at(-1)?.end || 0) + 0.8;
    seek.max = String(duration);
  }
  startPrefetch();
  paint();
}

function setCues(next) {
  cues = next;
  giveUp.clear();
  lastSignature = '';
  prefetchToken += 1;
}

async function routeFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(srt|vtt|ass|ssa|txt)$/.test(name)) {
    await setSubtitleFile(file);
    return;
  }
  if (file.type.startsWith('video/') || /\.(mp4|webm|m4v|mov)$/.test(name)) setVideoFile(file);
}

function togglePlay() {
  if (mode === 'video') {
    if (video.paused) video.play();
    else video.pause();
    return;
  }
  if (!cues.length) return;
  playing = !playing;
  playButton.textContent = playing ? '暂停' : '播放';
  if (playing) {
    if (clockTime >= duration) clockTime = 0;
    clockStamp = performance.now();
    startLoop();
  }
}

function startLoop() {
  if (raf) return;
  const tick = (now) => {
    raf = 0;
    if (mode === 'video') {
      paint();
      if (!video.paused) raf = requestAnimationFrame(tick);
      return;
    }
    if (!playing) return;
    clockTime += (now - clockStamp) / 1000;
    clockStamp = now;
    if (clockTime >= duration) {
      clockTime = duration;
      playing = false;
      playButton.textContent = '播放';
    }
    paint();
    if (playing) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function mediaTime() {
  const base = mode === 'video' ? video.currentTime || 0 : clockTime;
  return Math.max(0, base + Number(settings.offset || 0));
}

function startPrefetch() {
  const token = ++prefetchToken;
  if (!cues.length) return;
  runPrefetch(token);
}

async function runPrefetch(token) {
  let stalls = 0;
  while (token === prefetchToken) {
    const time = mediaTime();
    const texts = Subs.textsAhead(cues, time).filter((text) => !settled(text));
    if (!texts.length) {
      paint();
      return;
    }
    if (!useRemote && !queue) return;
    const indexed = indexCues(cues);
    const batch = texts.slice(0, 24);
    const doneBefore = client.cache.size + client.failed.size + giveUp.size;
    try {
      if (useRemote) {
        await client.translateItems(batch.map((text) => ({
          text,
          priority: Subs.priorityForCue(indexed.get(text), time, true)
        })), {
          sourceLanguage: settings.sourceLanguage,
          targetLanguage: settings.targetLanguage
        });
        if (client.cache.size + client.failed.size + giveUp.size === doneBefore) {
          stalls += 1;
          if (stalls > 3) return;
          await new Promise((resolve) => setTimeout(resolve, 800));
        } else {
          stalls = 0;
        }
      } else {
        await translatePool(batch, token);
      }
      paint();
    } catch (error) {
      statusNode.textContent = error.message || '翻译失败';
      if (error.code === 'NEED_DOWNLOAD' || error.code === 'NO_API' || error.code === 'UNAVAILABLE') return;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
}

function indexCues(list) {
  const map = new Map();
  for (const cue of list) {
    if (cue.text && !map.has(cue.text)) map.set(cue.text, cue);
  }
  return map;
}

async function translatePool(texts, token) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, texts.length) }, async () => {
    while (token === prefetchToken) {
      const current = cursor;
      cursor += 1;
      if (current >= texts.length) return;
      const text = texts[current];
      try {
        await queue.translateCue(text);
      } catch (error) {
        giveUp.add(text);
      }
      if (Subs.activeCues(cues, mediaTime()).some((cue) => cue.text === text)) paint();
    }
  });
  await Promise.all(workers);
}

function isPlaying() {
  return mode === 'video' ? Boolean(video.src && !video.paused && !video.ended) : playing;
}

function hasText(text) {
  if (useRemote) return client.cache.has(text);
  return Boolean(queue?.dictionary.memory.has(text));
}

function settled(text) {
  return hasText(text) || giveUp.has(text) || Boolean(useRemote && client.failed.has(text));
}

function lookup(text) {
  if (useRemote) return client.cache.get(text) || '';
  return queue?.dictionary.memory.get(text) || '';
}

function paint() {
  const time = mediaTime();
  const active = Subs.activeCues(cues, time);
  const original = active.map((cue) => cue.text).join('\n');
  const ready = active.length > 0 && active.every((cue) => hasText(cue.text));
  const translation = ready ? active.map((cue) => lookup(cue.text)).join('\n') : '';
  const showOriginal = settings.showOriginal || !ready;
  const signature = `${showOriginal ? original : ''}|${ready ? translation : ''}`;
  if (signature !== lastSignature) {
    lastSignature = signature;
    fill(originalNode, showOriginal ? original : '');
    fill(translationNode, ready ? translation : '');
  }
  const playingNow = isPlaying();
  stage.classList.toggle('is-playing', playingNow);
  if (playingNow) {
    progressNode.hidden = true;
  } else {
    const label = progressLabel(time);
    progressNode.hidden = !label;
    progressNode.textContent = label;
  }
  const shown = mode === 'video' ? video.currentTime || 0 : clockTime;
  const total = mode === 'video' ? video.duration || duration : duration;
  seek.max = String(total || 0);
  if (document.activeElement !== seek) seek.value = String(shown || 0);
  clock.textContent = `${formatTime(shown)} / ${formatTime(total)}`;
}

function progressLabel(time) {
  if (!cues.length) return '';
  const unique = new Set(cues.map((cue) => cue.text));
  let done = 0;
  for (const text of unique) if (hasText(text)) done += 1;
  if (!unique.size || done >= unique.size) return '';
  const upcoming = cues.filter((cue) => cue.end >= time && cue.start <= time + 60);
  if (upcoming.length && upcoming.every((cue) => hasText(cue.text))) return '';
  return `提前翻译 ${done}/${unique.size}`;
}

function fill(element, text) {
  element.replaceChildren();
  if (!text) return;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = document.createElement('div');
    const span = document.createElement('span');
    span.className = 'line';
    span.textContent = line;
    row.appendChild(span);
    element.appendChild(row);
  }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const body = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return hours ? `${hours}:${body}` : body;
}

function shiftOffset(delta) {
  const offset = Math.max(-5, Math.min(5, Math.round((Number(settings.offset || 0) + delta) * 10) / 10));
  settings.offset = offset;
  settingsApi.save({ offset });
  statusNode.textContent = `字幕时间 ${offset > 0 ? '提前' : offset < 0 ? '延后' : '对齐'} ${Math.abs(offset).toFixed(1)} 秒`;
  paint();
}

function applyAppearance() {
  globalThis.JaSubStyle.apply(stage, settings);
}

function onKey(event) {
  if (event.target instanceof Element && event.target.closest('input, textarea, select')) return;
  const partial = globalThis.JaSubStyle.adjust(settings, event);
  if (partial) {
    event.preventDefault();
    Object.assign(settings, partial);
    applyAppearance();
    pendingStyle = Object.assign(pendingStyle || {}, partial);
    clearTimeout(styleTimer);
    styleTimer = setTimeout(() => {
      const payload = pendingStyle;
      pendingStyle = null;
      if (payload) settingsApi.save(payload);
    }, 160);
    return;
  }
  if (event.altKey || event.metaKey || event.ctrlKey) return;
  if (event.code === 'Space') {
    event.preventDefault();
    togglePlay();
  } else if (event.code === 'ArrowRight') {
    nudge(5);
  } else if (event.code === 'ArrowLeft') {
    nudge(-5);
  } else if (event.key === 'f') {
    document.querySelector('#fullscreen').click();
  }
}

function nudge(delta) {
  if (mode === 'video') video.currentTime = Math.max(0, (video.currentTime || 0) + delta);
  else clockTime = Math.max(0, Math.min(duration, clockTime + delta));
  paint();
  startPrefetch();
}
