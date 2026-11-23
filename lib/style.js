(function (root) {
  const FONTS = [
    { id: 'sans', label: '黑体' },
    { id: 'serif', label: '宋体' },
    { id: 'round', label: '圆体' },
    { id: 'mono', label: '等宽' }
  ];

  const BACKGROUNDS = [
    { id: 'plate', label: '底衬' },
    { id: 'none', label: '无底' },
    { id: 'stroke', label: '描边' },
    { id: 'block', label: '色块' }
  ];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function cycle(list, current, direction) {
    const index = list.findIndex((item) => item.id === current);
    const next = (Math.max(0, index) + direction + list.length) % list.length;
    return list[next].id;
  }

  function adjust(settings, event) {
    if (!event.altKey || event.metaKey || event.ctrlKey) return null;
    const fontSize = Number(settings.fontSize) || 28;
    const bottom = Number(settings.bottom) || 12;
    const backgroundOpacity = Number(settings.backgroundOpacity ?? 0.66);
    const textOpacity = Number(settings.textOpacity ?? 1);
    const code = event.code;
    if (event.shiftKey && code === 'ArrowUp') return { bottom: clamp(bottom + 2, 0, 46) };
    if (event.shiftKey && code === 'ArrowDown') return { bottom: clamp(bottom - 2, 0, 46) };
    if (code === 'ArrowUp') return { fontSize: clamp(fontSize + 2, 16, 72) };
    if (code === 'ArrowDown') return { fontSize: clamp(fontSize - 2, 16, 72) };
    if (code === 'Equal' || code === 'NumpadAdd') return { backgroundOpacity: clamp(roundTenth(backgroundOpacity + 0.1), 0, 1) };
    if (code === 'Minus' || code === 'NumpadSubtract') return { backgroundOpacity: clamp(roundTenth(backgroundOpacity - 0.1), 0, 1) };
    if (code === 'BracketRight') return { textOpacity: clamp(roundTenth(textOpacity + 0.1), 0.35, 1) };
    if (code === 'BracketLeft') return { textOpacity: clamp(roundTenth(textOpacity - 0.1), 0.35, 1) };
    if (code === 'KeyB') {
      return { backgroundStyle: cycle(BACKGROUNDS, settings.backgroundStyle || 'plate', event.shiftKey ? -1 : 1) };
    }
    if (code === 'KeyG') {
      return { fontStyle: cycle(FONTS, settings.fontStyle || 'sans', event.shiftKey ? -1 : 1) };
    }
    return null;
  }

  function roundTenth(value) {
    return Math.round(value * 10) / 10;
  }

  function apply(element, settings) {
    if (!element) return;
    element.dataset.font = settings.fontStyle || 'sans';
    element.dataset.bg = settings.backgroundStyle || 'plate';
    element.style.setProperty('--sub-size', `${Number(settings.fontSize) || 28}px`);
    element.style.setProperty('--sub-bottom', `${Number(settings.bottom) || 12}%`);
    element.style.setProperty('--sub-bg-alpha', String(Number(settings.backgroundOpacity ?? 0.66)));
    element.style.setProperty('--sub-text-alpha', String(Number(settings.textOpacity ?? 1)));
  }

  root.JaSubStyle = { FONTS, BACKGROUNDS, adjust, apply };
})(globalThis);
