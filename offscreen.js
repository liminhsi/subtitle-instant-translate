let translator = null;
let queue = null;
let queuePair = '';
let lastError = '';
let lastCode = '';
let createPromise = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  if (message.type === 'get-status') {
    sendResponse(status());
    return false;
  }

  if (message.type === 'warm' || message.type === 'translate') {
    warm(message.sourceLanguage, message.targetLanguage)
      .then(() => {
        if (message.type === 'warm') {
          sendResponse({ ...status(), ok: true });
          return;
        }
        queue.run(message, sendResponse);
      })
      .catch((error) => {
        const mapped = mapError(error);
        lastError = mapped.message;
        lastCode = mapped.code || '';
        sendResponse({ ok: false, error: mapped.message, code: mapped.code || '' });
      });
    return true;
  }
});

function status() {
  return {
    ok: true,
    api: typeof Translator !== 'undefined',
    ready: Boolean(translator),
    pair: queuePair,
    dictSize: queue ? queue.dictionary.memory.size : 0,
    error: lastError,
    code: lastCode
  };
}

function warm(sourceLanguage, targetLanguage) {
  const nextPair = `${sourceLanguage}>${targetLanguage}`;
  if (translator && queue && queuePair === nextPair) return Promise.resolve(translator);
  if (createPromise && queuePair === nextPair) return createPromise;

  queuePair = nextPair;
  lastError = '';
  lastCode = '';
  createPromise = (async () => {
    if (typeof Translator === 'undefined') throw coded('需要桌面版 Chrome 138 或更高版本', 'NO_API');
    const options = { sourceLanguage, targetLanguage };
    let availability = 'unavailable';
    try {
      availability = await Translator.availability(options);
    } catch (error) {
      throw coded(error.message || '无法检查翻译模型', 'NO_API');
    }
    if (availability === 'unavailable') {
      throw coded('这台电脑不支持这个语言方向的本地翻译', 'UNAVAILABLE');
    }
    if (availability !== 'available') {
      throw coded('请先下载翻译模型', 'NEED_DOWNLOAD');
    }
    if (translator && typeof translator.destroy === 'function') {
      try {
        translator.destroy();
      } catch (error) {
        /* The previous model is already gone. */
      }
    }
    translator = await Translator.create(options);
    queue = globalThis.JaSubEngine.createQueue({
      sourceLanguage,
      targetLanguage,
      getTranslator: () => translator
    });
    await queue.ensureLoaded();
    return translator;
  })();

  return createPromise.then(
    (value) => {
      createPromise = null;
      return value;
    },
    (error) => {
      createPromise = null;
      translator = null;
      queue = null;
      throw mapError(error);
    }
  );
}

function mapError(error) {
  if (error?.code) return error;
  const message = error?.message || String(error);
  if (error?.name === 'NotAllowedError' || /user gesture|not allowed|activation/i.test(message)) {
    return coded('请先下载翻译模型', 'NEED_DOWNLOAD');
  }
  return coded(message, 'ERROR');
}

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
