import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = { TextDecoder, Uint8Array };
vm.createContext(context);
vm.runInContext(readFileSync(new URL('../lib/subs.js', import.meta.url), 'utf8'), context);
const { Subs } = context;
const data = (value) => JSON.parse(JSON.stringify(value));

const sample = readFileSync(new URL('../demo/sample.srt', import.meta.url), 'utf8');
const cues = Subs.parseSrt(sample);
assert.equal(cues.length, 5);
assert.equal(cues[0].text, '今夜は、少し冷えるね。');
assert.equal(cues[0].start, 1);
assert.equal(cues[0].end, 3.2);
assert.deepEqual(data(Subs.activeCues(cues, 1)), data([cues[0]]));
assert.deepEqual(data(Subs.activeCues(cues, 3.2)), []);
assert.deepEqual(data(Subs.activeCues(cues, 4)), data([cues[1]]));

const vtt = `WEBVTT

NOTE
ignore me

1
00:01.000 --> 00:04.000 align:middle
<b>こんにちは</b>

00:00:05.500 --> 00:00:06.000
{\\an8}次の行
`;
assert.deepEqual(data(Subs.parseVtt(vtt)), [
  { start: 1, end: 4, text: 'こんにちは' },
  { start: 5.5, end: 6, text: '次の行' }
]);

const ass = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\an8}駅まで、一緒に歩こう。
Dialogue: 0,0:00:04.00,0:00:05.25,Default,,0,0,0,,明日、またここで会おう。
`;
const assCues = Subs.parseAss(ass);
assert.equal(assCues.length, 2);
assert.equal(assCues[0].text, '駅まで、一緒に歩こう。');
assert.equal(assCues[0].start, 1.5);
assert.equal(assCues[1].end, 5.25);

assert.deepEqual(
  data(Subs.parseYoutubeJson3({
    events: [
      { tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: 'こんにちは' }] },
      { tStartMs: 2400, dDurationMs: 800, segs: [{ utf8: 'こんにちは' }] },
      { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: '次へ' }, { utf8: '\n' }] }
    ]
  })),
  [
    { start: 1, end: 3.2, text: 'こんにちは' },
    { start: 4, end: 5, text: '次へ' }
  ]
);

assert.deepEqual(
  data(Subs.parseTimedTextXml('<transcript><text start="1.5" dur="2">こんにちは</text><text start="4" dur="1"></text></transcript>')),
  [{ start: 1.5, end: 3.5, text: 'こんにちは' }]
);

assert.deepEqual(
  data(Subs.parseBilibiliBody({ body: [{ from: 1, to: 2.5, content: '  今夜は ' }, { from: 3, to: 3, content: '空' }] })),
  [{ start: 1, end: 2.5, text: '今夜は' }]
);

const ordered = Subs.uniqueTextsInOrder(
  [
    { start: 0, end: 2, text: '过去' },
    { start: 10, end: 12, text: '现在' },
    { start: 40, end: 42, text: '以后' },
    { start: 11, end: 12, text: '现在' }
  ],
  11
);
assert.deepEqual(data(ordered), ['现在', '以后', '过去']);
assert.equal(Subs.priorityForCue({ start: 10, end: 12 }, 11), 0);
assert.equal(Subs.priorityForCue({ start: 40, end: 42 }, 11), 1);
assert.equal(Subs.priorityForCue({ start: 0, end: 2 }, 11), 2);

assert.equal(Subs.parseSubtitle(sample, 'movie.srt').length, 5);
assert.equal(Subs.normalizeText('&amp;  こんにちは<br>明日'), '& こんにちは\n明日');

const utf8Srt = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n');
assert.equal(Subs.parseSrt(Subs.decodeSubtitleBytes(utf8Srt))[0].text, 'こんにちは');

const utf16 = encodeUtf16Le('1\n00:00:01,000 --> 00:00:02,000\n駅まで\n');
assert.equal(Subs.parseSrt(Subs.decodeSubtitleBytes(utf16))[0].text, '駅まで');

const shiftJis = new Uint8Array([
  ...new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\n'),
  0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd,
  0x0a
]);
assert.equal(Subs.parseSrt(Subs.decodeSubtitleBytes(shiftJis))[0].text, 'こんにちは');

function encodeUtf16Le(value) {
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >> 8;
  }
  return bytes;
}

console.log('subs.test.mjs: ok');
