(function (root) {
  function createClient() {
    const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const cache = new Map();
    const failed = new Set();
    const inflight = new Map();
    const listeners = new Set();

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'translation' || message.clientId !== clientId) return;
      if (message.translation) {
        cache.set(message.text, message.translation);
        failed.delete(message.text);
      } else if (message.error) {
        failed.add(message.text);
      }
      listeners.forEach((listener) => listener(message));
    });

    function translateItems(items, languages) {
      const need = [];
      const seen = new Set();
      const waiting = [];
      for (const item of items) {
        const text = item?.text;
        if (!text || cache.has(text) || failed.has(text) || seen.has(text)) continue;
        seen.add(text);
        if (inflight.has(text)) {
          waiting.push(inflight.get(text));
          continue;
        }
        need.push({ text, priority: item.priority ?? 2 });
      }
      if (!need.length) return waiting.length ? Promise.all(waiting).then(() => ({ ok: true, results: [] })) : Promise.resolve({ ok: true, results: [] });

      let resolveJob;
      let rejectJob;
      const job = new Promise((resolve, reject) => {
        resolveJob = resolve;
        rejectJob = reject;
      });
      for (const item of need) inflight.set(item.text, job);

      sendBatch(need, languages).then(
        (response) => {
          for (const item of need) inflight.delete(item.text);
          resolveJob(response);
        },
        (error) => {
          for (const item of need) inflight.delete(item.text);
          rejectJob(error);
        }
      );
      return Promise.all([job, ...waiting]).then(([response]) => response);
    }

    async function sendBatch(need, languages) {
      const ensured = await chrome.runtime.sendMessage({ type: 'ensure-offscreen' });
      if (!ensured?.ok) {
        const error = new Error(ensured?.error || '翻译进程没有启动');
        error.code = 'NO_WORKER';
        throw error;
      }
      const response = await chrome.runtime.sendMessage({
        type: 'translate',
        clientId,
        items: need,
        sourceLanguage: languages.sourceLanguage,
        targetLanguage: languages.targetLanguage
      });
      if (!response?.ok) {
        const error = new Error(response?.error || '翻译失败');
        error.code = response?.code || '';
        throw error;
      }
      for (const item of response.results || []) {
        if (item?.translation) cache.set(item.text, item.translation);
        else if (item?.text) failed.add(item.text);
      }
      return response;
    }

    async function loadDict(sourceLanguage, targetLanguage) {
      const key = `dict:${sourceLanguage}:${targetLanguage}`;
      const stored = await chrome.storage.local.get(key);
      for (const [text, translation] of Object.entries(stored[key] || {})) {
        if (translation) cache.set(text, translation);
      }
    }

    function clear() {
      cache.clear();
      failed.clear();
    }

    function resetFailures() {
      failed.clear();
    }

    return {
      cache,
      failed,
      translateItems,
      loadDict,
      clear,
      resetFailures,
      onUpdate(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
  }

  root.JaSubClient = { createClient };
})(globalThis);
