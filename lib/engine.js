(function (root) {
  function passthrough(text) {
    const core = String(text || '').replace(/[\s\d♪♫〜～ー—\-。、，「」！？!?.,'"“”‘’()（）【】[\]…・]/g, '');
    return core.length === 0;
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('这一句翻译超时')), ms);
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  function notify(clientId, payload) {
    if (!clientId) return;
    chrome.runtime.sendMessage(
      { type: 'translation', clientId, ...payload },
      () => void chrome.runtime.lastError
    );
  }

  function createDictionary(sourceLanguage, targetLanguage) {
    const dictKey = `dict:${sourceLanguage}:${targetLanguage}`;
    const memory = new Map();
    let chain = Promise.resolve();
    let loaded = false;
    let saveTimer = 0;

    async function load() {
      if (loaded) return memory;
      const stored = await chrome.storage.local.get(dictKey);
      for (const [text, translation] of Object.entries(stored[dictKey] || {})) {
        if (translation) memory.set(text, translation);
      }
      loaded = true;
      return memory;
    }

    function remember(text, translation) {
      if (!text || !translation) return;
      memory.set(text, translation);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 400);
    }

    function flush() {
      const snapshot = new Map(memory);
      chain = chain
        .then(async () => {
          const stored = await chrome.storage.local.get(dictKey);
          const dict = { ...(stored[dictKey] || {}) };
          for (const [text, translation] of snapshot) dict[text] = translation;
          const keys = Object.keys(dict);
          if (keys.length > 5000) {
            for (const key of keys.slice(0, keys.length - 4500)) delete dict[key];
          }
          await chrome.storage.local.set({ [dictKey]: dict });
        })
        .catch(() => {});
    }

    return { dictKey, memory, load, remember };
  }

  function createQueue(options) {
    const jobs = [];
    let running = 0;
    const inflight = new Map();
    const dictionary = createDictionary(options.sourceLanguage, options.targetLanguage);
    let loadPromise = null;

    function ensureLoaded() {
      if (!loadPromise) loadPromise = dictionary.load().catch((error) => {
        loadPromise = null;
        throw error;
      });
      return loadPromise;
    }

    function translateLine(text) {
      const cached = dictionary.memory.get(text);
      if (cached) return Promise.resolve(cached);
      if (passthrough(text)) {
        dictionary.memory.set(text, text);
        return Promise.resolve(text);
      }
      const existing = inflight.get(text);
      if (existing) return existing;
      const translator = options.getTranslator();
      if (!translator) {
        const error = new Error('翻译模型还没准备好');
        error.code = 'NEED_DOWNLOAD';
        return Promise.reject(error);
      }
      const pending = withTimeout(translator.translate(text), 8000)
        .then((result) => {
          const translation = String(result || '').trim() || text;
          dictionary.remember(text, translation);
          return translation;
        })
        .finally(() => {
          if (inflight.get(text) === pending) inflight.delete(text);
        });
      inflight.set(text, pending);
      return pending;
    }

    async function translateCue(text) {
      const normalized = String(text || '');
      if (!normalized.trim()) return '';
      const cached = dictionary.memory.get(normalized);
      if (cached) return cached;
      await ensureLoaded();
      const afterLoad = dictionary.memory.get(normalized);
      if (afterLoad) return afterLoad;
      const translated = [];
      for (const part of normalized.split('\n')) {
        const line = part.trim();
        translated.push(line ? await translateLine(line) : '');
      }
      const result = translated.join('\n');
      dictionary.remember(normalized, result);
      return result;
    }

    function pump() {
      while (running < 4 && jobs.length) {
        let best = 0;
        for (let index = 1; index < jobs.length; index += 1) {
          if (jobs[index].priority < jobs[best].priority) best = index;
        }
        const job = jobs.splice(best, 1)[0];
        running += 1;
        job.task().finally(() => {
          running -= 1;
          pump();
        });
      }
    }

    function run(message, sendResponse) {
      const items = Array.isArray(message.items) ? message.items : [];
      if (!items.length) {
        sendResponse({ ok: true, results: [] });
        return;
      }
      const results = new Array(items.length);
      let left = items.length;
      let replied = false;
      const finish = () => {
        if (replied) return;
        replied = true;
        try {
          sendResponse({ ok: true, results });
        } catch (error) {
          /* The tab that asked may already be gone. */
        }
      };
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        jobs.push({
          priority: Number.isFinite(item.priority) ? item.priority : 2,
          task: async () => {
            const text = String(item.text || '');
            try {
              const translation = await translateCue(text);
              results[index] = { text, translation };
              notify(message.clientId, { text, translation });
            } catch (error) {
              const reason = error.message || String(error);
              results[index] = { text, error: reason };
              notify(message.clientId, { text, error: reason });
            } finally {
              left -= 1;
              if (left === 0) finish();
            }
          }
        });
      }
      pump();
    }

    return { run, dictionary, translateCue, ensureLoaded };
  }

  function installEngine(getQueue) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'engine') return;
    const queue = getQueue();
    if (message.type === 'get-status') {
      sendResponse({ ok: true, ready: Boolean(queue), via: 'engine' });
      return false;
    }
    if (message.type === 'translate') {
      if (!queue) return;
      queue.run(message, sendResponse);
      return true;
    }
  });
}

root.JaSubEngine = { createQueue, createDictionary, installEngine };
})(globalThis);
