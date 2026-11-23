const Subs = globalThis.Subs;
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
const pageUrl = params.get('url') || '';
const statusNode = document.querySelector('#status');
const input = document.querySelector('#file');

input.addEventListener('change', async () => {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!/\.(srt|vtt|ass|ssa|txt)$/i.test(file.name)) {
    statusNode.textContent = '请选择 .srt 字幕文件。';
    return;
  }
  const text = Subs.decodeSubtitleBytes(new Uint8Array(await file.arrayBuffer()));
  const cues = Subs.parseSubtitle(text, file.name);
  if (!cues.length) {
    statusNode.textContent = '没有读出时间轴。SRT 里需要有 00:00:01,000 --> 00:00:04,000 这样的行。';
    return;
  }
  await chrome.storage.session.set({
    pendingSubtitle: {
      text,
      name: file.name,
      url: pageUrl,
      tabId: Number.isFinite(tabId) ? tabId : null,
      id: Date.now()
    }
  });
  statusNode.textContent = `已载入「${file.name}」，共 ${cues.length} 条。回到视频页面即可，这个窗口可以关掉。`;
});
