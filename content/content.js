(function () {
  const Settings = globalThis.JaSubSettings;
  const Subs = globalThis.Subs;

  const SITE_SELECTORS = [
    '.ytp-caption-segment',
    '.captions-text',
    '.player-timedtext-text-container',
    '.player-timedtext span',
    '.bpx-player-subtitle-panel-text',
    '.bili-subtitle-x-subtitle-panel-text',
    '.subtitle-item-text',
    '.atvwebplayersdk-captions-text',
    '.dss-subtitle-renderer-cue',
    '.vjs-text-track-cue',
    '.plyr__caption'
  ].join(',');

  const GENERIC_SELECTOR = '[class*="subtitle" i], [class*="caption" i], [class*="timedtext" i]';

  const SOURCE_RANK = { none: 0, dom: 1, texttrack: 2, bilibili: 3, youtube: 3, file: 4 };

  const boundLists = new WeakSet();
  const boundTracks = new WeakSet();

  const state = {
    settings: { ...Settings.DEFAULTS },
    video: null,
    cues: [],
    cueSource: 'none',
    client: null,
    host: null,
    nodes: null,
    pageUrl: location.href,
    prefetchToken: 0,
    lastPaint: '',
    lastLayout: '',
    raf: 0,
    modelCode: '',
    hint: '',
    domText: '',
    userFile: null,
    dictPair: '',
    playingSince: 0,
    hinted: false,
    clientPromise: null,
    tabId: null,
    fileName: '',
    pointerOverVideo: false,
    draggingFile: false,
    uploadUntil: 0,
    adAt: 0,
    adOn: false
  };

  let styleTimer = 0;
  let pendingStyle = null;

  const hideStyle = document.createElement('style');
  hideStyle.textContent = `
    html.jslive-hide-native .ytp-caption-window-container,
    html.jslive-hide-native .caption-window,
    html.jslive-hide-native .player-timedtext,
    html.jslive-hide-native .bpx-player-subtitle-panel,
    html.jslive-hide-native .bili-subtitle-x-subtitle-panel,
    html.jslive-hide-native .atvwebplayersdk-captions-overlay,
    html.jslive-hide-native .dss-subtitle-renderer,
    html.jslive-hide-native .vjs-text-track-display,
    html.jslive-hide-native .plyr__captions,
    html.jslive-hide-native .shaka-text-container {
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;
  document.documentElement.appendChild(hideStyle);

  init();

  async function init() {
    try {
      state.settings = await Settings.load();
    } catch (error) {
      /* Keep defaults if storage is briefly unavailable. */
    }
    chrome.storage.onChanged.addListener(onStorage);
    try {
      const who = await chrome.runtime.sendMessage({ type: 'whoami' });
      state.tabId = who?.tabId ?? null;
    } catch (error) {
      state.tabId = null;
    }
    chrome.storage.session.get('pendingSubtitle').then((stored) => {
      if (stored.pendingSubtitle) adoptPending(stored.pendingSubtitle);
    }).catch(() => {});
    document.addEventListener('keydown', onStyleKey, true);
    document.addEventListener('mousemove', onPointerMove, true);
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('dragleave', onDragLeave, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragend', () => {
      state.draggingFile = false;
      updateUploadButton();
    }, true);
    window.addEventListener('message', onPageMessage);
    document.addEventListener('play', (event) => {
      if (event.target instanceof HTMLVideoElement) attach(event.target);
    }, true);
    document.addEventListener('fullscreenchange', () => {
      placeHost();
      state.lastLayout = '';
      layout();
    });
    window.addEventListener('resize', () => {
      state.lastLayout = '';
      layout();
    });
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeName === 'VIDEO' || (node.querySelector && node.querySelector('video'))) {
            scan();
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (isCaptionSite()) injectHook();
    scan();
    setInterval(scan, 1500);
  }

  function isCaptionSite() {
    return /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|(^|\.)bilibili\.com$/.test(location.hostname);
  }

  function injectHook() {
    if (document.documentElement.dataset.jsliveHook) return;
    document.documentElement.dataset.jsliveHook = '1';
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/page-hook.js');
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  function onPageMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== 'jslive') return;
    if (event.data.type === 'caption-tracks') loadYouTube(event.data.tracks);
    if (event.data.type === 'bilibili-ids') loadBilibili(event.data);
  }

  function onStorage(changes, area) {
    if (area === 'session' && changes.pendingSubtitle?.newValue) {
      adoptPending(changes.pendingSubtitle.newValue);
    }
    if (area === 'local' && changes.modelReadyAt && state.settings.enabled) {
      state.modelCode = '';
      state.hint = '';
      state.client?.resetFailures();
      state.lastPaint = '';
      startPrefetch();
    }
    if (area !== 'local') return;
    const keys = Object.keys(Settings.DEFAULTS);
    if (!keys.some((key) => changes[key])) return;
    for (const key of keys) {
      if (changes[key]) state.settings[key] = changes[key].newValue;
    }
    applyAppearance();
    if (changes.sourceLanguage || changes.targetLanguage) {
      state.dictPair = '';
      state.clientPromise = null;
      state.client?.clear();
      state.modelCode = '';
      state.hint = '';
      startPrefetch();
    }
    if (changes.enabled && state.settings.enabled === false) {
      state.prefetchToken += 1;
      state.lastPaint = '';
      clearOverlay();
      return;
    }
    state.lastPaint = '';
    paint();
  }

  function scan() {
    if (location.href !== state.pageUrl) {
      state.pageUrl = location.href;
      state.userFile = null;
      state.fileName = '';
      state.cues = [];
      state.cueSource = 'none';
      updateUploadButton();
      state.domText = '';
      state.hint = '';
      state.hinted = false;
      state.playingSince = 0;
      state.lastPaint = '';
      state.prefetchToken += 1;
    }
    if (!state.settings.enabled) return;
    const video = findVideo();
    if (video) attach(video);
  }

  function findVideo() {
    const videos = [...document.querySelectorAll('video')].filter((video) => {
      const rect = video.getBoundingClientRect();
      if (rect.width < 220 || rect.height < 120) return false;
      if (video.closest('.video-ads, .ytp-ad-module')) return false;
      return true;
    });
    if (!videos.length) return null;
    const playing = videos.filter((video) => !video.paused && !video.ended);
    const pool = playing.length ? playing : videos;
    pool.sort((a, b) => area(b) - area(a));
    return pool[0];
  }

  function area(video) {
    const rect = video.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function attach(video) {
    if (!state.settings.enabled || !video) return;
    const changed = state.video !== video;
    state.video = video;
    if (changed) {
      state.domText = '';
      state.lastLayout = '';
      state.lastPaint = '';
      state.playingSince = video.paused ? 0 : Date.now();
      state.uploadUntil = Date.now() + 8000;
      if (!video.dataset.jsliveBound) {
        video.dataset.jsliveBound = '1';
        video.addEventListener('play', () => {
          if (state.video !== video) return;
          state.playingSince = Date.now();
          syncChrome();
          startLoop();
        });
        video.addEventListener('pause', () => {
          if (state.video !== video) return;
          syncChrome();
          paint();
        });
        video.addEventListener('seeked', () => {
          if (state.video !== video) return;
          state.lastPaint = '';
          paint();
          startPrefetch();
        });
        video.addEventListener('emptied', () => {
          if (state.video !== video || state.userFile) return;
          if (state.cueSource === 'youtube' || state.cueSource === 'bilibili' || state.cueSource === 'file') return;
          state.cues = [];
          state.cueSource = 'none';
          state.lastPaint = '';
          paint();
        });
        bindTextTracks(video);
      }
      watchDom(video);
      ensureUi().then(() => {
        placeHost();
        layout();
        paint();
      });
    }
    if (state.userFile) {
      state.cues = state.userFile.cues;
      state.cueSource = 'file';
    }
    harvestTextTracks(video);
    if (changed) {
      ensureClient().then(() => {
        if (state.video === video && state.cues.length) startPrefetch();
      }).catch(() => {});
    }
    if (!video.paused) startLoop();
    else paint();
  }

  function bindTextTracks(video) {
    const tracks = video.textTracks;
    if (!tracks || boundLists.has(tracks)) return;
    boundLists.add(tracks);
    const harvest = () => {
      if (state.video === video) harvestTextTracks(video);
    };
    tracks.addEventListener('addtrack', (event) => {
      watchTrack(event.track, harvest);
      harvest();
    });
    for (const track of tracks) watchTrack(track, harvest);
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      harvest();
      if (tries > 8 || state.cueSource === 'file' || state.cueSource === 'youtube' || state.cueSource === 'bilibili') {
        clearInterval(timer);
      }
    }, 700);
  }

  function watchTrack(track, harvest) {
    if (!track || boundTracks.has(track)) return;
    boundTracks.add(track);
    track.addEventListener('cuechange', harvest);
  }

  function harvestTextTracks(video) {
    if (!video?.textTracks || state.userFile) return;
    const tracks = [...video.textTracks];
    if (!tracks.length) return;
    const source = state.settings.sourceLanguage;
    const preferred = tracks.find((track) => String(track.language || '').toLowerCase().startsWith(source))
      || tracks.find((track) => String(track.language || '').toLowerCase().startsWith('ja'))
      || tracks.find((track) => track.mode === 'showing')
      || (tracks.length === 1 ? tracks[0] : null);
    if (!preferred) return;
    if (preferred.mode === 'disabled') preferred.mode = 'hidden';
    if (!preferred.cues?.length) return;
    const cues = [];
    for (const cue of preferred.cues) {
      const text = Subs.normalizeText(cue.text || '');
      if (!text) continue;
      cues.push({ start: cue.startTime, end: cue.endTime, text });
    }
    if (cues.length) adoptCues(cues, 'texttrack');
  }

  async function loadYouTube(tracks) {
    if (state.userFile) return;
    const track = pickTrack(tracks);
    if (!track?.url) return;
    try {
      const url = new URL(track.url, location.href);
      if (!url.searchParams.has('fmt')) url.searchParams.set('fmt', 'json3');
      const address = url.toString();
      const raw = await fetchViaPage(address) || await fetch(address, { credentials: 'include' }).then((response) => response.text());
      if (!raw) return;
      const cues = raw.trim().startsWith('{')
        ? Subs.parseYoutubeJson3(JSON.parse(raw))
        : Subs.parseTimedTextXml(raw);
      if (cues.length) adoptCues(cues, 'youtube');
    } catch (error) {
      /* The page's own caption nodes remain as a fallback. */
    }
  }

  function fetchViaPage(url) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve('');
      }, 4000);
      function onMessage(event) {
        if (event.source !== window || event.data?.source !== 'jslive' || event.data.type !== 'caption-payload') return;
        if (event.data.url !== url) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(event.data.body || '');
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ source: 'jslive-ext', type: 'fetch-track', url }, '*');
    });
  }

  async function loadBilibili(ids) {
    if (state.userFile) return;
    const params = new URLSearchParams();
    if (ids.aid != null && ids.aid !== '') params.set('aid', String(ids.aid));
    if (ids.bvid) params.set('bvid', String(ids.bvid));
    if (ids.cid != null && ids.cid !== '') params.set('cid', String(ids.cid));
    if ([...params.keys()].length === 0) return;
    try {
      const response = await fetch(`https://api.bilibili.com/x/player/v2?${params}`, { credentials: 'include' });
      const data = await response.json();
      const subs = data?.data?.subtitle?.subtitles || [];
      const source = state.settings.sourceLanguage;
      const chosen = subs.find((item) => String(item.lan || '').toLowerCase().startsWith(source));
      if (!chosen?.subtitle_url) return;
      const subtitleUrl = chosen.subtitle_url.startsWith('http') ? chosen.subtitle_url : `https:${chosen.subtitle_url}`;
      const body = await fetch(subtitleUrl, { credentials: 'include' }).then((res) => res.json());
      const cues = Subs.parseBilibiliBody(body);
      if (cues.length) adoptCues(cues, 'bilibili');
    } catch (error) {
      /* Live DOM captions still work when the API is blocked. */
    }
  }

  function pickTrack(tracks) {
    const list = (tracks || []).filter((track) => track?.url);
    const source = state.settings.sourceLanguage;
    let best = null;
    let bestScore = 0;
    for (const track of list) {
      const lang = String(track.lang || '').toLowerCase();
      let score = 0;
      if (lang === source || lang.startsWith(`${source}-`)) score += 10;
      if (source === 'ja' && lang.startsWith('ja')) score += 8;
      if (track.kind === 'asr') score -= 3;
      if (score > bestScore) {
        best = track;
        bestScore = score;
      }
    }
    return best;
  }

  function adoptCues(cues, source) {
    if (state.userFile && source !== 'file') return;
    if ((SOURCE_RANK[source] || 0) < (SOURCE_RANK[state.cueSource] || 0)) return;
    if (source === state.cueSource && cues.length === state.cues.length && cues[0]?.text === state.cues[0]?.text && cues.at(-1)?.text === state.cues.at(-1)?.text) {
      return;
    }
    state.cues = cues;
    state.cueSource = source;
    state.hint = '';
    state.hinted = false;
    state.lastPaint = '';
    startPrefetch();
    paint();
  }

  function adoptPending(pending) {
    if (!pending?.text || !ownsPending(pending)) return;
    const cues = Subs.parseSubtitle(pending.text, pending.name || '');
    if (!cues.length) {
      state.hint = '这份 SRT 没有读出时间轴。请确认文件里有 00:00:01,000 --> 00:00:04,000 这样的时间。';
      state.fileName = '';
      ensureUi().then(() => {
        updateUploadButton();
        updateStatus();
      });
      return;
    }
    state.userFile = { cues, name: pending.name || '字幕.srt', url: pending.url || location.href };
    state.fileName = state.userFile.name;
    state.cues = cues;
    state.cueSource = 'file';
    state.hint = '';
    state.hinted = false;
    state.lastPaint = '';
    if (!state.video) scan();
    ensureUi().then(updateUploadButton);
    startPrefetch();
    paint();
  }

  function ownsPending(pending) {
    if (pending.tabId && state.tabId && Number(pending.tabId) === Number(state.tabId)) return true;
    return pageMatches(pending.url);
  }

  async function loadSubtitleFile(file) {
    if (!file || !isSubtitleFile(file.name)) {
      state.hint = '请上传 .srt 字幕文件。';
      ensureUi().then(updateStatus);
      return;
    }
    const text = Subs.decodeSubtitleBytes(new Uint8Array(await file.arrayBuffer()));
    adoptPending({ text, name: file.name, url: location.href, tabId: state.tabId });
  }

  function clearUserFile() {
    state.userFile = null;
    state.fileName = '';
    state.cues = [];
    state.cueSource = 'none';
    state.hint = '';
    state.lastPaint = '';
    state.prefetchToken += 1;
    updateUploadButton();
    if (state.video) harvestTextTracks(state.video);
    paint();
  }

  function isSubtitleFile(name) {
    return /\.(srt|vtt|ass|ssa|txt)$/i.test(name || '');
  }

  function onPointerMove(event) {
    const inside = Boolean(state.video) && pointInVideo(event.clientX, event.clientY);
    if (inside === state.pointerOverVideo) return;
    state.pointerOverVideo = inside;
    updateUploadButton();
  }

  function onDragOver(event) {
    if (!state.video || !hasFileDrag(event) || !pointInVideo(event.clientX, event.clientY)) return;
    event.preventDefault();
    if (state.draggingFile) return;
    state.draggingFile = true;
    updateUploadButton();
  }

  function onDragLeave(event) {
    if (!state.draggingFile || pointInVideo(event.clientX, event.clientY)) return;
    state.draggingFile = false;
    updateUploadButton();
  }

  async function onDrop(event) {
    if (!state.video || !pointInVideo(event.clientX, event.clientY)) return;
    const file = [...(event.dataTransfer?.files || [])].find((item) => isSubtitleFile(item.name));
    state.draggingFile = false;
    updateUploadButton();
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    await loadSubtitleFile(file);
  }

  function hasFileDrag(event) {
    return [...(event.dataTransfer?.types || [])].includes('Files');
  }

  function pointInVideo(x, y) {
    if (!state.video) return false;
    const rect = state.video.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function pageMatches(url) {
    if (!url) return false;
    if (location.href === url) return true;
    try {
      return Boolean(window.top && window.top.location.href === url);
    } catch (error) {
      return false;
    }
  }

  function languages() {
    return {
      sourceLanguage: state.settings.sourceLanguage,
      targetLanguage: state.settings.targetLanguage
    };
  }

  function ensureClient() {
    if (state.clientPromise) return state.clientPromise;
    const pair = `${state.settings.sourceLanguage}:${state.settings.targetLanguage}`;
    state.clientPromise = (async () => {
      if (!state.client) {
        state.client = globalThis.JaSubClient.createClient();
        state.client.onUpdate((message) => {
          const text = message?.text;
          if (text) {
            const active = state.cues.length ? Subs.activeCues(state.cues, currentTime()) : [];
            const visible = active.some((cue) => cue.text === text) || state.domText === text;
            if (!visible) return;
          }
          state.lastPaint = '';
          requestPaint();
        });
      }
      if (state.dictPair !== pair) {
        state.client.clear();
        await state.client.loadDict(state.settings.sourceLanguage, state.settings.targetLanguage);
        if (`${state.settings.sourceLanguage}:${state.settings.targetLanguage}` !== pair) return state.client;
        state.dictPair = pair;
      }
      return state.client;
    })().catch((error) => {
      state.clientPromise = null;
      throw error;
    });
    return state.clientPromise;
  }

  async function startPrefetch() {
    const token = ++state.prefetchToken;
    if (!state.settings.enabled || !state.cues.length) return;
    try {
      await ensureClient();
    } catch (error) {
      return;
    }
    let stalls = 0;
    while (token === state.prefetchToken && state.settings.enabled) {
      const time = currentTime();
      const ordered = state.cueSource === 'file' ? Subs.textsAhead(state.cues, time) : Subs.uniqueTextsInOrder(state.cues, time);
      const texts = ordered.filter((text) => {
        return !state.client.cache.has(text) && !state.client.failed.has(text);
      });
      if (!texts.length) {
        state.modelCode = '';
        paint();
        return;
      }
      const before = state.client.cache.size + state.client.failed.size;
      const fileMode = state.cueSource === 'file';
      const indexed = indexCues(state.cues);
      const batch = texts.slice(0, fileMode ? 24 : 8).map((text) => ({
        text,
        priority: Subs.priorityForCue(indexed.get(text), time, fileMode)
      }));
      try {
        await state.client.translateItems(batch, languages());
        state.modelCode = '';
        state.hint = '';
        paint();
        const after = state.client.cache.size + state.client.failed.size;
        if (after === before) {
          stalls += 1;
          if (stalls > 3) return;
          await wait(800);
        } else {
          stalls = 0;
        }
      } catch (error) {
        state.modelCode = error.code || 'ERROR';
        state.hint = error.message || '翻译失败';
        paint();
        if (error.code === 'NEED_DOWNLOAD' || error.code === 'NO_API' || error.code === 'UNAVAILABLE') return;
        await wait(700);
      }
    }
  }

  function currentTime() {
    if (!state.video) return 0;
    return Math.max(0, state.video.currentTime + Number(state.settings.offset || 0));
  }

  function requestPaint() {
    if (state.paintQueued) return;
    state.paintQueued = true;
    requestAnimationFrame(() => {
      state.paintQueued = false;
      paint();
    });
  }

  function startLoop() {
    if (state.raf) return;
    const tick = () => {
      state.raf = 0;
      if (!state.video || state.video.paused || !state.settings.enabled) return;
      layout();
      paint();
      maybeHint();
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  }

  function maybeHint() {
    if (state.hinted || state.cues.length || state.domText || state.modelCode || !state.video || state.video.paused) return;
    if (!state.playingSince) state.playingSince = Date.now();
    if (Date.now() - state.playingSince < 6000) return;
    state.hinted = true;
    state.hint = '没有读到字幕轨。请打开播放器里的日语字幕，或在插件里载入字幕文件。';
    updateStatus();
  }

  function indexCues(cues) {
    const map = new Map();
    for (const cue of cues) {
      if (cue.text && !map.has(cue.text)) map.set(cue.text, cue);
    }
    return map;
  }

  function paint() {
    if (!state.nodes || !state.settings.enabled || !state.video) {
      if (!state.settings.enabled) clearOverlay();
      return;
    }
    layout();
    const now = performance.now();
    if (now - state.adAt > 500) {
      state.adAt = now;
      state.adOn = Boolean(document.querySelector('.ad-showing, .ytp-ad-player-overlay'));
    }
    if (state.adOn) {
      fill(state.nodes.original, '');
      fill(state.nodes.translation, '');
      document.documentElement.classList.remove('jslive-hide-native');
      state.lastPaint = 'ad';
      return;
    }
    if (state.cues.length && state.cueSource !== 'dom') paintTimeline();
    else paintDom();
    updateStatus();
  }

  function paintTimeline() {
    const active = Subs.activeCues(state.cues, currentTime());
    const original = active.map((cue) => cue.text).join('\n');
    const ready = active.length > 0 && active.every((cue) => state.client?.cache.has(cue.text));
    const translation = ready ? active.map((cue) => state.client.cache.get(cue.text)).join('\n') : '';
    render(original, translation, ready);
    if (!ready && active.length && state.client && !state.liveBusy) {
      const missing = active
        .filter((cue) => !state.client.cache.has(cue.text) && !state.client.failed.has(cue.text))
        .map((cue) => ({ text: cue.text, priority: 0 }));
      if (missing.length) {
        state.liveBusy = true;
        state.client.translateItems(missing, languages()).catch((error) => {
          state.modelCode = error.code || 'ERROR';
          state.hint = error.message || '翻译失败';
          updateStatus();
        }).finally(() => {
          state.liveBusy = false;
        });
      }
    }
  }

  function paintDom() {
    const original = state.domText;
    const ready = Boolean(original) && Boolean(state.client?.cache.has(original));
    const translation = ready ? state.client.cache.get(original) : '';
    render(original, translation, ready);
  }

  function render(original, translation, ready) {
    const showOriginal = state.settings.showOriginal || !ready;
    const signature = `${showOriginal ? original : ''}|${ready ? translation : ''}`;
    if (signature !== state.lastPaint) {
      state.lastPaint = signature;
      fill(state.nodes.original, showOriginal ? original : '');
      fill(state.nodes.translation, ready ? translation : '');
    }
    document.documentElement.classList.toggle('jslive-hide-native', Boolean(state.settings.hideSiteSubs && ready && translation));
  }

  function fill(element, text) {
    if (!element) return;
    element.replaceChildren();
    if (!text) return;
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      const row = document.createElement('div');
      const span = document.createElement('span');
      span.className = 'line';
      span.textContent = line;
      row.appendChild(span);
      element.appendChild(row);
    }
  }

  let domObserver = null;
  let domFrame = 0;

  function watchDom(video) {
    if (domObserver) domObserver.disconnect();
    domObserver = new MutationObserver(() => scheduleDomRead());
    for (const root of captionRoots(video)) {
      domObserver.observe(root, { subtree: true, childList: true, characterData: true });
    }
    scheduleDomRead();
  }

  function captionRoots(video) {
    const roots = new Set();
    if (video.parentElement) roots.add(video.parentElement);
    const player = video.closest('#movie_player, .html5-video-player, .bpx-player-container, .bilibili-player, .watch-video, .web-player, .video-player');
    if (player) roots.add(player);
    return [...roots];
  }

  function scheduleDomRead() {
    if (domFrame) return;
    if (state.cueSource === 'file' || state.cueSource === 'youtube' || state.cueSource === 'bilibili' || state.cueSource === 'texttrack') return;
    domFrame = setTimeout(() => {
      domFrame = 0;
      readDomSubtitle();
    }, 200);
  }

  function readDomSubtitle() {
    if (!state.video || state.cueSource === 'file' || state.cueSource === 'youtube' || state.cueSource === 'bilibili' || state.cueSource === 'texttrack') {
      return;
    }
    const text = collectDomText();
    if (text === state.domText) return;
    state.domText = text;
    state.lastPaint = '';
    if (text && !state.liveBusy) {
      state.hint = '';
      state.liveBusy = true;
      ensureClient().then(() => state.client.translateItems([{ text, priority: 0 }], languages())).catch((error) => {
        state.modelCode = error.code || 'ERROR';
        state.hint = error.message || '翻译失败';
        updateStatus();
      }).finally(() => {
        state.liveBusy = false;
      });
    }
    paint();
  }

  function collectDomText() {
    const roots = state.video ? captionRoots(state.video) : [];
    const specific = [];
    for (const root of roots) {
      for (const node of root.querySelectorAll(SITE_SELECTORS)) {
        const text = nodeText(node);
        if (text) specific.push(text);
      }
    }
    const picked = specific.length ? specific : genericTexts(roots);
    return dedupeTexts(picked).slice(0, 3).join('\n');
  }

  function genericTexts(roots) {
    const texts = [];
    for (const root of roots) {
      const nodes = [...root.querySelectorAll(GENERIC_SELECTOR)]
        .filter((node) => overlapsVideo(node))
        .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
      for (const node of nodes) {
        const text = nodeText(node);
        if (text) texts.push(text);
        if (texts.length >= 4) return texts;
      }
    }
    return texts;
  }

  function nodeText(node) {
    if (!node || node.id === 'jslive-host' || node.closest?.('#jslive-host')) return '';
    const tag = node.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA') return '';
    const text = Subs.normalizeText(node.innerText || node.textContent || '');
    if (!text || text.length > 180) return '';
    return text;
  }

  function dedupeTexts(texts) {
    const unique = [...new Set(texts.filter(Boolean))];
    return unique.filter((text, index) => !unique.some((other, otherIndex) => {
      return otherIndex !== index && other.length > text.length && other.includes(text);
    }));
  }

  function overlapsVideo(node) {
    if (!state.video) return false;
    const nodeRect = node.getBoundingClientRect();
    const videoRect = state.video.getBoundingClientRect();
    if (nodeRect.width < 8 || nodeRect.height < 8) return false;
    if (nodeRect.width * nodeRect.height > videoRect.width * videoRect.height * 0.45) return false;
    const width = Math.min(nodeRect.right, videoRect.right) - Math.max(nodeRect.left, videoRect.left);
    const height = Math.min(nodeRect.bottom, videoRect.bottom) - Math.max(nodeRect.top, videoRect.top);
    return width > 0 && height > 0;
  }

  async function ensureUi() {
    if (state.host) return;
    let css = '';
    try {
      css = await fetch(chrome.runtime.getURL('content/overlay.css')).then((response) => response.text());
    } catch (error) {
      css = ':host{position:fixed;z-index:2147483646;pointer-events:none}.line{background:rgba(0,0,0,.7);color:white}';
    }
    const host = document.createElement('div');
    host.id = 'jslive-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    const root = document.createElement('div');
    root.className = 'root';
    root.innerHTML = `
      <div class="status" hidden></div>
      <div class="stack">
        <div class="original"></div>
        <div class="translation"></div>
      </div>
      <div class="pill" hidden>
        <span class="pill-text"></span>
        <button type="button" class="model">下载模型</button>
      </div>
      <div class="upload">
        <button type="button" class="pick">上传 SRT</button>
        <button type="button" class="clear" hidden>移除</button>
        <div class="drop" hidden>松开，载入 SRT</div>
        <input class="file" type="file" accept=".srt,.vtt,.ass,.ssa,text/plain" hidden />
      </div>
    `;
    shadow.append(style, root);
    state.host = host;
    state.nodes = {
      status: root.querySelector('.status'),
      original: root.querySelector('.original'),
      translation: root.querySelector('.translation'),
      pill: root.querySelector('.pill'),
      pillText: root.querySelector('.pill-text'),
      pillButton: root.querySelector('.pill .model'),
      upload: root.querySelector('.upload'),
      uploadPick: root.querySelector('.upload .pick'),
      uploadClear: root.querySelector('.upload .clear'),
      uploadDrop: root.querySelector('.upload .drop'),
      uploadInput: root.querySelector('.upload .file')
    };
    state.nodes.pillButton.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'open-setup' });
    });
    state.nodes.uploadPick.addEventListener('click', () => {
      state.nodes.uploadInput.click();
    });
    state.nodes.uploadInput.addEventListener('change', async () => {
      const file = state.nodes.uploadInput.files?.[0];
      state.nodes.uploadInput.value = '';
      if (file) await loadSubtitleFile(file);
    });
    state.nodes.uploadClear.addEventListener('click', clearUserFile);
    updateUploadButton();
    applyAppearance();
    placeHost();
  }

  function placeHost() {
    if (!state.host) return;
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = fullscreen && state.video && fullscreen.contains(state.video) && fullscreen.tagName !== 'VIDEO'
      ? fullscreen
      : document.documentElement;
    if (state.host.parentElement !== parent) parent.appendChild(state.host);
  }

  function layout() {
    if (!state.host || !state.video) return;
    const rect = state.video.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) {
      state.host.style.display = 'none';
      return;
    }
    const key = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(',');
    state.host.style.display = 'block';
    if (key === state.lastLayout) return;
    state.lastLayout = key;
    state.host.style.left = `${rect.left}px`;
    state.host.style.top = `${rect.top}px`;
    state.host.style.width = `${rect.width}px`;
    state.host.style.height = `${rect.height}px`;
  }

  function applyAppearance() {
    globalThis.JaSubStyle.apply(state.host, state.settings);
  }

  function onStyleKey(event) {
    if (!state.video || !state.settings.enabled) return;
    const target = event.target;
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName || ''))) return;
    const partial = globalThis.JaSubStyle.adjust(state.settings, event);
    if (!partial) return;
    event.preventDefault();
    event.stopPropagation();
    Object.assign(state.settings, partial);
    applyAppearance();
    pendingStyle = Object.assign(pendingStyle || {}, partial);
    clearTimeout(styleTimer);
    styleTimer = setTimeout(() => {
      const payload = pendingStyle;
      pendingStyle = null;
      if (payload) Settings.save(payload);
    }, 160);
  }

  function syncChrome() {
    if (!state.host) return;
    const playing = Boolean(state.video && !state.video.paused && !state.draggingFile);
    state.host.classList.toggle('playing', playing);
  }

  function updateStatus() {
    if (!state.nodes) return;
    syncChrome();
    if (state.video && !state.video.paused && !state.draggingFile) return;
    const progress = progressLabel();
    state.nodes.status.hidden = !progress;
    state.nodes.status.textContent = progress;
    const needsModel = state.modelCode === 'NEED_DOWNLOAD' || state.modelCode === 'NO_API' || state.modelCode === 'UNAVAILABLE';
    const message = needsModel || (!state.cues.length && !state.domText) ? state.hint : '';
    state.nodes.pill.hidden = !message;
    state.nodes.pillText.textContent = message || '';
    state.nodes.pillButton.hidden = state.modelCode !== 'NEED_DOWNLOAD';
  }

  function progressLabel() {
    if (!state.client || !state.cues.length) return '';
    const unique = new Set(state.cues.map((cue) => cue.text).filter(Boolean));
    let done = 0;
    for (const text of unique) {
      if (state.client.cache.has(text)) done += 1;
    }
    if (!unique.size || done >= unique.size) return '';
    const time = currentTime();
    const upcoming = state.cues.filter((cue) => cue.end >= time && cue.start <= time + 60);
    if (upcoming.length && upcoming.every((cue) => state.client.cache.has(cue.text))) return '';
    const name = state.fileName ? `${shortenName(state.fileName)} · ` : '';
    return `${name}提前翻译 ${done}/${unique.size}`;
  }

  function shortenName(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '');
    return base.length > 18 ? `${base.slice(0, 17)}…` : base;
  }

  function updateUploadButton() {
    if (!state.nodes?.upload) return;
    syncChrome();
    const playing = state.video && !state.video.paused;
    const show = state.draggingFile || (!playing && (state.pointerOverVideo || Date.now() < state.uploadUntil));
    state.nodes.upload.classList.toggle('visible', show);
    state.nodes.uploadDrop.hidden = !state.draggingFile;
    state.nodes.uploadPick.textContent = state.fileName ? shortenName(state.fileName) : '上传 SRT';
    state.nodes.uploadPick.title = state.fileName ? `已载入 ${state.fileName}，点击更换` : '上传本地 SRT 字幕';
    state.nodes.uploadClear.hidden = !state.fileName;
  }

  function clearOverlay() {
    document.documentElement.classList.remove('jslive-hide-native');
    if (!state.nodes) return;
    state.nodes.original.replaceChildren();
    state.nodes.translation.replaceChildren();
    state.nodes.status.hidden = true;
    state.nodes.pill.hidden = true;
    state.lastPaint = '';
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
