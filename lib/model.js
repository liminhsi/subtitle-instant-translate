(function (root) {
  function startModelDownload(options, onProgress) {
    if (typeof Translator === 'undefined') {
      const error = new Error('需要桌面版 Chrome 138 或更高版本');
      error.code = 'NO_API';
      throw error;
    }
    return Translator.create({
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          if (typeof onProgress !== 'function') return;
          let ratio = Number(event.loaded || 0);
          if (ratio > 1) ratio /= 100;
          onProgress(Math.max(0, Math.min(1, ratio)));
        });
      }
    });
  }

  root.JaSubModel = { startModelDownload };
})(globalThis);
