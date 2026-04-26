const fileInput = document.querySelector('#fileInput');
const chooseBtn = document.querySelector('#chooseBtn');
const clearBtn = document.querySelector('#clearBtn');
const dropZone = document.querySelector('#dropZone');
const statusEl = document.querySelector('#status');
const resultsEl = document.querySelector('#results');
const counterEl = document.querySelector('#counter');
const template = document.querySelector('#resultTemplate');

const textUtf8 = new TextDecoder('utf-8', { fatal: false });
const textLatin1 = new TextDecoder('iso-8859-1', { fatal: false });
let resultCount = 0;

chooseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', event => handleFiles(event.target.files));
clearBtn.addEventListener('click', clearResults);

['dragenter', 'dragover'].forEach(type => {
  dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(type => {
  dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
  });
});

dropZone.addEventListener('drop', event => handleFiles(event.dataTransfer.files));

document.addEventListener('paste', event => {
  const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
  if (files.length > 0) handleFiles(files);
});

showEmptyNote();

async function handleFiles(fileList) {
  const files = [...fileList].filter(file => /^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name));
  if (files.length === 0) {
    setStatus('沒有找到支援的圖片。請使用 PNG、JPG/JPEG 或 WEBP。', 'error');
    return;
  }

  removeEmptyNote();
  setStatus(`正在處理 ${files.length} 個檔案...`, 'busy');

  for (const file of files) {
    try {
      const data = await inspectFile(file);
      addResultCard(file, data);
    } catch (error) {
      addResultCard(file, {
        file: basicFileInfo(file),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  setStatus(`完成。已加入 ${files.length} 個結果。`, 'ok');
  fileInput.value = '';
}

async function inspectFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const data = {
    file: basicFileInfo(file),
    detectedType: detectType(bytes, file),
    metadata: {},
    aiSummary: {}
  };

  if (data.detectedType === 'PNG') {
    data.metadata.png = await parsePng(bytes);
  } else if (data.detectedType === 'JPEG') {
    data.metadata.jpeg = parseJpeg(bytes);
  } else if (data.detectedType === 'WEBP') {
    data.metadata.webp = parseWebp(bytes);
  } else {
    data.metadata.note = 'Unknown or unsupported image signature.';
  }

  try {
    data.metadata.stealth = await readStealthMetadata(file);
  } catch (error) {
    data.metadata.stealth = { found: false, note: error.message };
  }

  data.aiSummary = summarizeAI(data.metadata);
  return data;
}

function basicFileInfo(file) {
  return {
    name: file.name || 'clipboard-image',
    type: file.type || 'unknown',
    sizeBytes: file.size,
    sizeReadable: formatBytes(file.size),
    lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null
  };
}

function detectType(bytes, file) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'PNG';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'WEBP';
  if (/\.png$/i.test(file.name)) return 'PNG';
  if (/\.jpe?g$/i.test(file.name)) return 'JPEG';
  if (/\.webp$/i.test(file.name)) return 'WEBP';
  return 'UNKNOWN';
}

async function parsePng(bytes) {
  const chunks = [];
  const text = {};
  let width = null;
  let height = null;
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = readU32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) break;

    chunks.push({ type, length });

    if (type === 'IHDR' && length >= 8) {
      width = readU32BE(bytes, start);
      height = readU32BE(bytes, start + 4);
    }

    if (type === 'tEXt') {
      const zero = bytes.indexOf(0, start);
      if (zero > start && zero < end) {
        const key = textLatin1.decode(bytes.slice(start, zero));
        const value = textLatin1.decode(bytes.slice(zero + 1, end));
        text[key] = tryParseJson(value);
      }
    }

    if (type === 'iTXt') {
      const parsed = await parseITXt(bytes.slice(start, end));
      if (parsed.key) text[parsed.key] = tryParseJson(parsed.value);
    }

    if (type === 'zTXt') {
      const parsed = await parseZTxt(bytes.slice(start, end));
      if (parsed.key) text[parsed.key] = parsed.value;
    }

    offset = end + 4;
    if (type === 'IEND') break;
  }

  return { width, height, chunks, text, textKeys: Object.keys(text) };
}

async function parseITXt(data) {
  const keyEnd = data.indexOf(0);
  if (keyEnd <= 0 || keyEnd + 3 > data.length) return { key: null, value: null };

  const key = textUtf8.decode(data.slice(0, keyEnd));
  const compressionFlag = data[keyEnd + 1];
  const compressionMethod = data[keyEnd + 2];
  let pos = keyEnd + 3;

  const languageEnd = data.indexOf(0, pos);
  if (languageEnd < 0) return { key: null, value: null };
  pos = languageEnd + 1;

  const translatedEnd = data.indexOf(0, pos);
  if (translatedEnd < 0) return { key: null, value: null };
  pos = translatedEnd + 1;

  const valueBytes = data.slice(pos);
  let value;
  if (compressionFlag === 1 && compressionMethod === 0) {
    value = await inflateDeflate(valueBytes).catch(() => '[compressed iTXt data could not be decoded in this browser]');
  } else {
    value = textUtf8.decode(valueBytes);
  }
  return { key, value };
}

async function parseZTxt(data) {
  const zero = data.indexOf(0);
  if (zero <= 0 || zero + 2 > data.length) return { key: null, value: null };
  const key = textLatin1.decode(data.slice(0, zero));
  const method = data[zero + 1];
  const compressed = data.slice(zero + 2);
  let value = '[compressed zTXt data could not be decoded]';
  if (method === 0) value = await inflateDeflate(compressed).catch(() => value);
  return { key, value: tryParseJson(value) };
}

function parseJpeg(bytes) {
  const segments = [];
  const textSegments = [];
  let offset = 2;

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = bytes[offset + 1];
    offset += 2;
    while (marker === 0xff && offset < bytes.length) marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;

    const length = readU16BE(bytes, offset);
    const start = offset + 2;
    const end = start + length - 2;
    if (length < 2 || end > bytes.length) break;
    const label = jpegMarkerName(marker);
    const segmentBytes = bytes.slice(start, end);
    const printable = extractPrintableText(segmentBytes);
    const segment = { marker: `0x${marker.toString(16).padStart(2, '0')}`, label, length };

    if (label === 'APP1' && ascii(segmentBytes, 0, 4) === 'Exif') segment.kind = 'EXIF';
    if (label === 'APP1' && printable.includes('xmpmeta')) segment.kind = 'XMP';
    if (label === 'COM') segment.kind = 'Comment';
    if (printable.length >= 8) {
      segment.previewText = printable.slice(0, 4000);
      textSegments.push({ label, kind: segment.kind || 'Text', text: printable });
    }

    segments.push(segment);
    offset = end;
  }

  return { segments, textSegments };
}

function parseWebp(bytes) {
  const chunks = [];
  const textChunks = [];
  let offset = 12;
  let width = null;
  let height = null;

  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = readU32LE(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) break;

    const chunk = { type, length };
    const data = bytes.slice(start, end);
    if (type === 'VP8X' && length >= 10) {
      width = 1 + readU24LE(data, 4);
      height = 1 + readU24LE(data, 7);
    }
    if (['EXIF', 'XMP ', 'ICCP'].includes(type)) {
      const printable = extractPrintableText(data);
      chunk.previewText = printable.slice(0, 4000);
      textChunks.push({ type, text: printable });
    }

    chunks.push(chunk);
    offset = end + (length % 2);
  }

  return { width, height, chunks, textChunks };
}

async function readStealthMetadata(file) {
  if (!/^image\/(png|webp)$/i.test(file.type) && !/\.(png|webp)$/i.test(file.name)) {
    return { found: false, note: 'Stealth LSB metadata is usually useful for PNG/WEBP only.' };
  }

  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;

  const alpha = buildBits(canvas.width, canvas.height, channelGetter(pixels, canvas.width, 'alpha'));
  const alphaResult = await decodeStealthBits(alpha, 'alpha');
  if (alphaResult.found) return alphaResult;

  const rgb = buildBits(canvas.width, canvas.height, channelGetter(pixels, canvas.width, 'rgb'));
  const rgbResult = await decodeStealthBits(rgb, 'rgb');
  if (rgbResult.found) return rgbResult;

  return { found: false, note: 'No recognized stealth_pnginfo / stealth_pngcomp / stealth_rgbinfo / stealth_rgbcomp signature found.' };
}

function channelGetter(pixels, width, mode) {
  return (x, y) => {
    const base = (y * width + x) * 4;
    if (mode === 'alpha') return [pixels[base + 3] & 1];
    return [pixels[base] & 1, pixels[base + 1] & 1, pixels[base + 2] & 1];
  };
}

function buildBits(width, height, getBits) {
  const bits = [];
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      bits.push(...getBits(x, y));
    }
  }
  return bits;
}

async function decodeStealthBits(bits, mode) {
  const sigByteLen = 'stealth_pnginfo'.length;
  if (bits.length < (sigByteLen + 4) * 8) return { found: false };

  const signature = bitsToString(bits, 0, sigByteLen * 8);
  const allowed = ['stealth_pnginfo', 'stealth_pngcomp', 'stealth_rgbinfo', 'stealth_rgbcomp'];
  if (!allowed.includes(signature)) return { found: false };

  const compressed = signature.endsWith('comp');
  const lenStart = sigByteLen * 8;
  const bitLength = bitsToInt(bits, lenStart, 32);
  const payloadStart = lenStart + 32;
  if (!Number.isFinite(bitLength) || bitLength <= 0 || payloadStart + bitLength > bits.length) {
    return { found: true, mode, signature, error: 'Stealth signature found, but payload length is invalid.' };
  }

  const payloadBytes = bitsToBytes(bits, payloadStart, bitLength);
  let decodedText;
  if (compressed) {
    const inflated = await inflateGzip(payloadBytes).catch(async () => inflateDeflate(payloadBytes));
    decodedText = typeof inflated === 'string' ? inflated : textUtf8.decode(inflated);
  } else {
    decodedText = textUtf8.decode(payloadBytes);
  }

  return {
    found: true,
    mode,
    signature,
    compressed,
    payloadBitLength: bitLength,
    text: decodedText,
    parsed: tryParseJson(decodedText)
  };
}

function summarizeAI(metadata) {
  const found = [];
  const fields = {};

  const addSource = (name, value) => {
    if (value === undefined || value === null || value === '') return;
    found.push(name);
    collectFields(value, fields);
  };

  if (metadata.png?.text) {
    for (const [key, value] of Object.entries(metadata.png.text)) {
      addSource(`PNG:${key}`, value);
    }
  }
  if (metadata.jpeg?.textSegments) {
    metadata.jpeg.textSegments.forEach(seg => addSource(`JPEG:${seg.kind || seg.label}`, seg.text));
  }
  if (metadata.webp?.textChunks) {
    metadata.webp.textChunks.forEach(chunk => addSource(`WEBP:${chunk.type.trim()}`, chunk.text));
  }
  if (metadata.stealth?.found) addSource(`Stealth:${metadata.stealth.signature}`, metadata.stealth.parsed || metadata.stealth.text);

  const likely = Object.keys(fields).some(key => /prompt|negative|seed|steps|sampler|cfg|scale|workflow|comment|uc|model/i.test(key));
  return { hasLikelyAIMetadata: likely, sources: [...new Set(found)], fields };
}

function collectFields(value, target, prefix = '') {
  if (typeof value === 'string') {
    parseParameterText(value, target, prefix);
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 12).forEach((item, index) => collectFields(item, target, `${prefix}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (/prompt|negative|seed|steps|sampler|cfg|scale|workflow|comment|uc|model|software|source|title/i.test(fullKey)) {
        target[fullKey] = item;
      }
      collectFields(item, target, fullKey);
    }
  }
}

function parseParameterText(text, target, prefix = '') {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (/Negative prompt:|Steps:|Sampler:|CFG scale:|Seed:/i.test(trimmed)) {
    target[prefix || 'parameters'] = trimmed;
  }
  const patterns = {
    prompt: /^(.*?)(?:\nNegative prompt:|\nSteps:|$)/s,
    negativePrompt: /Negative prompt:\s*(.*?)(?:\nSteps:|$)/s,
    steps: /Steps:\s*([^,\n]+)/i,
    sampler: /Sampler:\s*([^,\n]+)/i,
    cfgScale: /CFG scale:\s*([^,\n]+)/i,
    seed: /Seed:\s*([^,\n]+)/i,
    model: /Model:\s*([^,\n]+)/i
  };
  for (const [name, pattern] of Object.entries(patterns)) {
    const match = trimmed.match(pattern);
    if (match && match[1] && match[1].trim()) target[prefix ? `${prefix}.${name}` : name] = match[1].trim();
  }
}

function addResultCard(file, data) {
  const node = template.content.cloneNode(true);
  const card = node.querySelector('.result-card');
  const preview = node.querySelector('.preview');
  const fileName = node.querySelector('.file-name');
  const fileNote = node.querySelector('.file-note');
  const summaryTags = node.querySelector('.summary-tags');
  const prettyOutput = node.querySelector('.pretty-output');
  const rawOutput = node.querySelector('.raw-output');
  const copyBtn = node.querySelector('.copy-btn');
  const downloadBtn = node.querySelector('.download-btn');

  const objectUrl = URL.createObjectURL(file);
  preview.src = objectUrl;
  preview.onload = () => URL.revokeObjectURL(objectUrl);
  fileName.textContent = data.file?.name || file.name;
  fileNote.textContent = `${data.detectedType || 'Unknown'} · ${data.file?.sizeReadable || formatBytes(file.size)}`;

  const tags = buildTags(data);
  summaryTags.append(...tags.map(tag => createTag(tag.text, tag.kind)));

  const pretty = formatPretty(data);
  const raw = JSON.stringify(data, null, 2);
  prettyOutput.textContent = pretty;
  rawOutput.textContent = raw;

  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(raw);
    copyBtn.textContent = '已複製';
    setTimeout(() => { copyBtn.textContent = '複製 JSON'; }, 1200);
  });

  downloadBtn.addEventListener('click', () => {
    const blob = new Blob([pretty + '\n\nRAW JSON\n' + raw], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFilename(file.name)}.metadata.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  resultsEl.prepend(card);
  resultCount += 1;
  counterEl.textContent = `${resultCount} file${resultCount === 1 ? '' : 's'}`;
}

function buildTags(data) {
  if (data.error) return [{ text: 'Error', kind: 'warn' }];
  const tags = [{ text: data.detectedType || 'Unknown', kind: '' }];
  if (data.aiSummary?.hasLikelyAIMetadata) tags.push({ text: 'AI metadata found', kind: 'good' });
  else tags.push({ text: 'No obvious AI metadata', kind: 'warn' });
  if (data.metadata?.stealth?.found) tags.push({ text: data.metadata.stealth.signature, kind: 'good' });
  if (data.metadata?.png?.textKeys?.length) tags.push({ text: `${data.metadata.png.textKeys.length} PNG text fields`, kind: '' });
  return tags;
}

function formatPretty(data) {
  if (data.error) return `Error\n${data.error}`;
  const lines = [];
  lines.push(`File: ${data.file.name}`);
  lines.push(`Type: ${data.detectedType}`);
  lines.push(`Size: ${data.file.sizeReadable}`);
  lines.push('');

  if (data.metadata.png) {
    lines.push('PNG');
    lines.push(`- Size: ${data.metadata.png.width || '?'} × ${data.metadata.png.height || '?'}`);
    lines.push(`- Chunks: ${data.metadata.png.chunks.map(c => c.type).join(', ')}`);
    lines.push(`- Text keys: ${data.metadata.png.textKeys.join(', ') || 'none'}`);
    appendObject(lines, data.metadata.png.text, 'PNG text');
  }

  if (data.metadata.jpeg) {
    lines.push('JPEG');
    lines.push(`- Segments: ${data.metadata.jpeg.segments.map(s => s.kind || s.label).join(', ') || 'none'}`);
    data.metadata.jpeg.textSegments.forEach((seg, i) => {
      lines.push(`\nJPEG text #${i + 1} (${seg.kind || seg.label})`);
      lines.push(seg.text.slice(0, 6000));
    });
  }

  if (data.metadata.webp) {
    lines.push('WEBP');
    lines.push(`- Size: ${data.metadata.webp.width || '?'} × ${data.metadata.webp.height || '?'}`);
    lines.push(`- Chunks: ${data.metadata.webp.chunks.map(c => c.type.trim()).join(', ')}`);
    data.metadata.webp.textChunks.forEach(chunk => {
      lines.push(`\nWEBP ${chunk.type.trim()}`);
      lines.push(chunk.text.slice(0, 6000));
    });
  }

  if (data.metadata.stealth?.found) {
    lines.push('\nStealth / LSB metadata');
    lines.push(`- Signature: ${data.metadata.stealth.signature}`);
    lines.push(`- Mode: ${data.metadata.stealth.mode}`);
    appendObject(lines, data.metadata.stealth.parsed || data.metadata.stealth.text, 'Payload');
  } else if (data.metadata.stealth) {
    lines.push('\nStealth / LSB metadata');
    lines.push(`- ${data.metadata.stealth.note}`);
  }

  lines.push('\nAI summary');
  lines.push(`- Likely AI metadata: ${data.aiSummary.hasLikelyAIMetadata ? 'yes' : 'no'}`);
  lines.push(`- Sources: ${data.aiSummary.sources.join(', ') || 'none'}`);
  appendObject(lines, data.aiSummary.fields, 'Detected fields');

  return lines.join('\n');
}

function appendObject(lines, value, title) {
  lines.push(`\n${title}`);
  if (typeof value === 'string') lines.push(value);
  else lines.push(JSON.stringify(value, null, 2));
}

function createTag(text, kind) {
  const span = document.createElement('span');
  span.className = `tag ${kind || ''}`.trim();
  span.textContent = text;
  return span;
}

function clearResults() {
  resultsEl.innerHTML = '';
  resultCount = 0;
  counterEl.textContent = '0 files';
  setStatus('已清空結果。', 'ok');
  showEmptyNote();
}

function showEmptyNote() {
  if (resultsEl.querySelector('.empty-note')) return;
  const div = document.createElement('div');
  div.className = 'empty-note';
  div.textContent = '未有結果。請選擇、拖放或貼上圖片開始。';
  resultsEl.append(div);
}

function removeEmptyNote() {
  resultsEl.querySelector('.empty-note')?.remove();
}

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

async function inflateGzip(bytes) {
  if ('DecompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('This browser does not support gzip DecompressionStream. Try Chrome/Edge/Firefox latest version.');
}

async function inflateDeflate(bytes) {
  if ('DecompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return textUtf8.decode(await new Response(stream).arrayBuffer());
  }
  throw new Error('This browser does not support deflate DecompressionStream.');
}

function bitsToString(bits, start, length) {
  return textUtf8.decode(bitsToBytes(bits, start, length));
}

function bitsToBytes(bits, start, length) {
  const byteLength = Math.floor(length / 8);
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    let value = 0;
    for (let b = 0; b < 8; b++) value = (value << 1) | (bits[start + i * 8 + b] ? 1 : 0);
    out[i] = value;
  }
  return out;
}

function bitsToInt(bits, start, length) {
  let value = 0;
  for (let i = 0; i < length; i++) value = (value * 2) + (bits[start + i] ? 1 : 0);
  return value;
}

function splitNullParts(bytes, maxSplits) {
  const parts = [];
  let start = 0;
  let splits = 0;
  for (let i = 0; i < bytes.length && splits < maxSplits; i++) {
    if (bytes[i] === 0) {
      parts.push(bytes.slice(start, i));
      start = i + 1;
      splits++;
    }
  }
  parts.push(bytes.slice(start));
  return parts;
}

function extractPrintableText(bytes) {
  const text = textUtf8.decode(bytes);
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function readU16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0;
}

function readU32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readU24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function jpegMarkerName(marker) {
  if (marker >= 0xe0 && marker <= 0xef) return `APP${marker - 0xe0}`;
  if (marker === 0xfe) return 'COM';
  if (marker === 0xc0) return 'SOF0';
  if (marker === 0xc2) return 'SOF2';
  return `Marker ${marker.toString(16)}`;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function safeFilename(name) {
  return (name || 'image').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
}
