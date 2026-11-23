(function (root) {
  function decodeSubtitleBytes(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(data);
    }
    if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(data);
    }
    let offset = 0;
    if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) offset = 3;
    let zeros = 0;
    for (const byte of data) if (byte === 0) zeros += 1;
    if (data.length > 8 && zeros / data.length > 0.08) {
      return new TextDecoder('utf-16le').decode(data);
    }
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(offset));
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
      const shiftJis = new TextDecoder('shift_jis').decode(data.subarray(offset));
      if (scriptScore(shiftJis) > scriptScore(utf8)) return shiftJis;
    } catch (error) {
      /* This runtime has no Shift_JIS decoder. */
    }
    return utf8;
  }

  function scriptScore(value) {
    const matches = String(value).match(/[\u3040-\u30ff\u4e00-\u9fff]/g);
    return matches ? matches.length : 0;
  }

  function stripSubtitleTags(value) {
    return String(value || '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ');
  }

  function decodeXml(value) {
    return String(value || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function normalizeText(value) {
    return decodeXml(stripSubtitleTags(value))
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function timestampToSeconds(value) {
    const match = String(value).trim().match(
      /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/
    );
    if (!match) return null;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const fraction = match[4].padEnd(3, '0').slice(0, 3);
    return hours * 3600 + minutes * 60 + seconds + Number(fraction) / 1000;
  }

  function parseSrt(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = text.split(/\n{2,}/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n').filter((line, index) => !(index === 0 && /^\d+$/.test(line.trim()) && block.includes('-->')));
      const timing = lines.find((line) => line.includes('-->'));
      if (!timing) continue;
      const [startRaw, endRaw] = timing.split('-->').map((part) => part.trim().split(/\s+/)[0]);
      const start = timestampToSeconds(startRaw);
      const end = timestampToSeconds(endRaw);
      if (start == null || end == null || end <= start) continue;
      const body = lines.slice(lines.indexOf(timing) + 1).join('\n');
      const cueText = normalizeText(body);
      if (!cueText) continue;
      cues.push({ start, end, text: cueText });
    }
    return cues;
  }

  function parseVtt(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n');
    const cues = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index].trim();
      if (!line || line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION') || line.startsWith('X-TIMESTAMP')) {
        if (line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
          index += 1;
          while (index < lines.length && lines[index].trim()) index += 1;
        }
        index += 1;
        continue;
      }
      let timingLine = line;
      if (!timingLine.includes('-->') && index + 1 < lines.length) {
        index += 1;
        timingLine = lines[index].trim();
      }
      if (!timingLine.includes('-->')) {
        index += 1;
        continue;
      }
      const [startRaw, endRaw] = timingLine.split('-->').map((part) => part.trim().split(/\s+/)[0]);
      const start = timestampToSeconds(startRaw);
      const end = timestampToSeconds(endRaw);
      index += 1;
      const body = [];
      while (index < lines.length && lines[index].trim()) {
        body.push(lines[index]);
        index += 1;
      }
      if (start != null && end != null && end > start) {
        const cueText = normalizeText(body.join('\n'));
        if (cueText) cues.push({ start, end, text: cueText });
      }
    }
    return cues;
  }

  function parseAss(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const cues = [];
    for (const line of text.split('\n')) {
      if (!/^Dialogue:/i.test(line.trim())) continue;
      const payload = line.replace(/^Dialogue:\s*/i, '');
      const parts = payload.split(',');
      if (parts.length < 10) continue;
      const start = timestampToSeconds(parts[1]);
      const end = timestampToSeconds(parts[2]);
      const cueText = normalizeText(parts.slice(9).join(','));
      if (start == null || end == null || end <= start || !cueText) continue;
      cues.push({ start, end, text: cueText });
    }
    return cues;
  }

  function parseSubtitle(raw, filename = '') {
    const name = String(filename || '').toLowerCase();
    const sample = String(raw || '').slice(0, 400);
    if (name.endsWith('.ass') || name.endsWith('.ssa') || /\[Script Info\]/i.test(sample) || /^Dialogue:/im.test(sample)) {
      return parseAss(raw);
    }
    if (name.endsWith('.vtt') || /^\s*WEBVTT/i.test(sample)) return parseVtt(raw);
    return parseSrt(raw);
  }

  function parseYoutubeJson3(data) {
    const cues = [];
    for (const event of data?.events || []) {
      if (!event?.segs) continue;
      const raw = event.segs.map((segment) => segment.utf8 || '').join('');
      const text = normalizeText(raw);
      if (!text) continue;
      const start = Number(event.tStartMs || 0) / 1000;
      const duration = Number(event.dDurationMs || 0) / 1000;
      cues.push({ start, end: start + (duration || 2.5), text });
    }
    return mergeAdjacentDuplicates(cues);
  }

  function parseTimedTextXml(xml) {
    const cues = [];
    const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match = pattern.exec(xml);
    while (match) {
      const start = Number(readAttr(match[1], 'start') || 0);
      const duration = Number(readAttr(match[1], 'dur') || 2.5);
      const text = normalizeText(match[2]);
      if (text) cues.push({ start, end: start + duration, text });
      match = pattern.exec(xml);
    }
    return mergeAdjacentDuplicates(cues);
  }

  function parseBilibiliBody(data) {
    const rows = Array.isArray(data?.body) ? data.body : [];
    return rows
      .map((row) => ({
        start: Number(row.from),
        end: Number(row.to),
        text: normalizeText(row.content || '')
      }))
      .filter((cue) => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start);
  }

  function readAttr(source, name) {
    const match = String(source).match(new RegExp(`${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
    return match ? match[2] : '';
  }

  function mergeAdjacentDuplicates(cues) {
    const merged = [];
    for (const cue of cues) {
      const previous = merged[merged.length - 1];
      if (previous && previous.text === cue.text && cue.start <= previous.end + 0.25) {
        previous.end = Math.max(previous.end, cue.end);
        continue;
      }
      merged.push({ start: cue.start, end: cue.end, text: cue.text });
    }
    return merged;
  }

  function activeCues(cues, time) {
    const count = cues.length;
    if (!count) return [];
    let low = 0;
    let high = count - 1;
    let right = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start <= time) {
        right = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (right < 0) return [];
    const active = [];
    for (let index = right; index >= Math.max(0, right - 8); index -= 1) {
      const cue = cues[index];
      if (time >= cue.start && time < cue.end) active.push(cue);
    }
    active.reverse();
    return active;
  }

  function cueDistance(cue, time) {
    if (time >= cue.start && time < cue.end) return -1;
    if (cue.end < time - 0.4) return Math.abs(cue.start - time) + 1e6;
    return Math.abs(cue.start - time);
  }

  function textsAhead(cues, time) {
    const count = cues.length;
    if (!count) return [];
    let low = 0;
    let high = count - 1;
    let right = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start <= time + 0.2) {
        right = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const seen = new Set();
    const texts = [];
    const push = (cue) => {
      if (!cue?.text || seen.has(cue.text)) return;
      seen.add(cue.text);
      texts.push(cue.text);
    };
    const start = Math.max(0, right);
    for (let index = start; index < count; index += 1) push(cues[index]);
    for (let index = start - 1; index >= 0; index -= 1) push(cues[index]);
    return texts;
  }

  function uniqueTextsInOrder(cues, time) {
    const sorted = cues
      .filter((cue) => cue.text)
      .slice()
      .sort((a, b) => cueDistance(a, time) - cueDistance(b, time) || a.start - b.start);
    const seen = new Set();
    const texts = [];
    for (const cue of sorted) {
      if (seen.has(cue.text)) continue;
      seen.add(cue.text);
      texts.push(cue.text);
    }
    return texts;
  }

  function priorityForCue(cue, time, wide) {
    if (!cue) return 2;
    const lead = wide ? 30 : 6;
    const horizon = wide ? 180 : 90;
    if (time >= cue.start - 0.5 && time < cue.end + lead) return 0;
    if (cue.end >= time && cue.start < time + horizon) return 1;
    return 2;
  }

  root.Subs = {
    decodeSubtitleBytes,
    stripSubtitleTags,
    normalizeText,
    timestampToSeconds,
    parseSrt,
    parseVtt,
    parseAss,
    parseSubtitle,
    parseYoutubeJson3,
    parseTimedTextXml,
    parseBilibiliBody,
    activeCues,
    textsAhead,
    uniqueTextsInOrder,
    priorityForCue
  };
})(globalThis);
