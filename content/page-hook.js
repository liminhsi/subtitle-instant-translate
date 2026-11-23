(function () {
  const SOURCE = 'jslive';

  function post(payload) {
    window.postMessage({ source: SOURCE, ...payload }, '*');
  }

  function textName(name) {
    if (!name) return '';
    if (typeof name === 'string') return name;
    return name.simpleText || name.runs?.[0]?.text || '';
  }

  function youtubeTracks() {
    const tracks = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return false;
    post({
      type: 'caption-tracks',
      tracks: tracks.map((track) => ({
        lang: track.languageCode || '',
        kind: track.kind || '',
        name: textName(track.name),
        url: track.baseUrl || ''
      }))
    });
    return true;
  }

  function firstDefined(...values) {
    return values.find((value) => value != null && value !== '');
  }

  function bilibiliIds() {
    const state = window.__INITIAL_STATE__ || {};
    const videoData = state.videoData || state.epInfo || state.videoInfo || {};
    const aid = firstDefined(videoData.aid, state.aid, window.aid);
    const cid = firstDefined(videoData.cid, state.cid, window.cid, state.epInfo?.cid);
    const bvid = firstDefined(videoData.bvid, state.bvid, window.bvid);
    if (aid == null && cid == null && bvid == null) return false;
    post({ type: 'bilibili-ids', aid, cid, bvid });
    return true;
  }

  function scan() {
    const foundYouTube = /(^|\.)youtube\.com$/.test(location.hostname) && youtubeTracks();
    const foundBilibili = /(^|\.)bilibili\.com$/.test(location.hostname) && bilibiliIds();
    return foundYouTube || foundBilibili;
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (scan() || attempts > 24) clearInterval(timer);
  }, 500);

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'jslive-ext' || event.data.type !== 'fetch-track') return;
    const url = String(event.data.url || '');
    if (!url.includes('timedtext')) return;
    try {
      const response = await fetch(url, { credentials: 'include' });
      post({ type: 'caption-payload', url, body: await response.text() });
    } catch (error) {
      post({ type: 'caption-payload', url, error: String(error) });
    }
  });

  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(scan, 400);
    setTimeout(scan, 1200);
  });

  let href = location.href;
  setInterval(() => {
    if (location.href === href) return;
    href = location.href;
    setTimeout(scan, 600);
  }, 800);

  scan();
})();
