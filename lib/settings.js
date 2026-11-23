(function (root) {
  const DEFAULTS = {
    enabled: true,
    sourceLanguage: 'ja',
    targetLanguage: 'zh',
    showOriginal: true,
    hideSiteSubs: false,
    fontSize: 28,
    fontStyle: 'sans',
    backgroundStyle: 'plate',
    backgroundOpacity: 0.66,
    textOpacity: 1,
    bottom: 12,
    offset: 0
  };

  const SOURCES = [
    { code: 'ja', label: '日语' },
    { code: 'en', label: '英语' }
  ];

  const TARGETS = [
    { code: 'zh', label: '简体中文' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ko', label: '한국어' }
  ];

  function pairKey(sourceLanguage, targetLanguage) {
    return `dict:${sourceLanguage}:${targetLanguage}`;
  }

  async function load() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  }

  async function save(partial) {
    await chrome.storage.local.set(partial);
  }

  root.JaSubSettings = {
    DEFAULTS,
    SOURCES,
    TARGETS,
    pairKey,
    load,
    save
  };
})(globalThis);
