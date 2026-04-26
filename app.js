const fileInput = document.querySelector('#fileInput');
const chooseBtn = document.querySelector('#chooseBtn');
const clearBtn = document.querySelector('#clearBtn');
const dropZone = document.querySelector('#dropZone');
const statusEl = document.querySelector('#status');
const resultsEl = document.querySelector('#results');
const counterEl = document.querySelector('#counter');
const template = document.querySelector('#resultTemplate');

const utf8 = new TextDecoder('utf-8', { fatal: false });
const latin1 = new TextDecoder('iso-8859-1', { fatal: false });
let resultCount = 0;

chooseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', event => handleFiles(event.target.files));
clearBtn.addEventListener('click', clearResults);

dropZone.addEventListener('click', event => {
  if (event.target === dropZone) fileInput.click();
});

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
  const files = [...fileList].filter(file => /^image\/(png|jpeg|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name));
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
        detectedType: 'Unknown',
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
  const detectedType = detectType(bytes, file);
  const data = {
    file: basicFileInfo(file),
    detectedType,
    metadata: {},
    novelAI: null
  };

  if (detectedType === 'PNG') data.metadata.png = await parsePng(bytes);
  else if (detectedType === 'JPEG') data.metadata.jpeg = parseJpeg(bytes);
  else if (detectedType === 'WEBP') data.metadata.webp = parseWebp(bytes);
  else data.metadata.note = 'Unknown or unsupported image signature.';

  try {
    data.metadata.stealth = await readStealthMetadata(file);
  } catch (error) {
    data.metadata.stealth = { found: false, note: error.message };
  }

  data.novelAI = extractNovelAI(data);
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
        const key = latin1.decode(bytes.slice(start, zero));
        const value = latin1.decode(bytes.slice(zero + 1, end));
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

  const key = utf8.decode(data.slice(0, keyEnd));
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
    value = utf8.decode(valueBytes);
  }
  return { key, value };
}

async function parseZTxt(data) {
  const zero = data.indexOf(0);
  if (zero <= 0 || zero + 2 > data.length) return { key: null, value: null };
  const key = latin1.decode(data.slice(0, zero));
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
      segment.previewText = printable.slice(0, 1500);
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
      chunk.previewText = printable.slice(0, 1500);
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
    for (let y = 0; y < height; y++) bits.push(...getBits(x, y));
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
    const inflated = await inflateGzip(payloadBytes).catch(async () => inflateDeflateToBytes(payloadBytes));
    decodedText = typeof inflated === 'string' ? inflated : utf8.decode(inflated);
  } else {
    decodedText = utf8.decode(payloadBytes);
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

function extractNovelAI(data) {
  const candidates = [];

  if (data.metadata.stealth?.found) {
    candidates.push({ label: `Stealth / LSB (${data.metadata.stealth.signature})`, value: data.metadata.stealth.parsed || data.metadata.stealth.text, isStealth: true });
  }

  if (data.metadata.png?.text) {
    for (const [key, value] of Object.entries(data.metadata.png.text)) {
      candidates.push({ label: `PNG text: ${key}`, value });
    }
  }

  if (data.metadata.jpeg?.textSegments) {
    data.metadata.jpeg.textSegments.forEach((item, index) => {
      candidates.push({ label: `JPEG text ${index + 1}`, value: tryParseJson(item.text) });
    });
  }

  if (data.metadata.webp?.textChunks) {
    data.metadata.webp.textChunks.forEach((item, index) => {
      candidates.push({ label: `WEBP text ${index + 1}`, value: tryParseJson(item.text) });
    });
  }

  for (const candidate of candidates) {
    const normalized = normalizeNovelCandidate(candidate.value);
    if (!normalized) continue;

    const base = normalized.base;
    const comment = normalized.comment;
    const v4Positive = extractV4Caption(comment, [
      'v4_prompt',
      'v4Prompt',
      'v4_prompt_v2',
      'v4PromptV2'
    ]);
    const v4Negative = extractV4Caption(comment, [
      'v4_negative_prompt',
      'v4NegativePrompt',
      'v4_uc',
      'v4Uc',
      'v4_negative',
      'v4Negative'
    ]);
    const characterPrompts = buildV4CharacterPromptLines(v4Positive, v4Negative);

    const positive = firstText(
      base.Description,
      base.description,
      base.prompt,
      comment.prompt,
      comment.description,
      comment.Description,
      v4Positive.base
    );
    const negative = firstText(
      comment.uc,
      comment.negative_prompt,
      comment.negativePrompt,
      comment.negative,
      base.uc,
      base.negative_prompt,
      v4Negative.base
    );
    const software = firstText(base.Software, base.software, comment.Software, comment.software);
    const source = firstText(base.Source, base.source, comment.model, comment.Model, comment.source);

    const hasNovelAIName = /novelai|nai|novel ai/i.test(`${software} ${source}`);
    const hasUsefulFields = Boolean(
      positive ||
      negative ||
      characterPrompts.length ||
      comment.seed ||
      comment.sampler ||
      comment.steps ||
      comment.scale
    );

    if (hasNovelAIName || hasUsefulFields || candidate.isStealth) {
      return {
        sourceLabel: candidate.label,
        raw: normalized.raw,
        base,
        comment,
        positive: positive || '',
        negative: negative || '',
        characterPrompts,
        software: software || '',
        source: source || '',
        modelLabel: inferNaiModel(base, comment, source, software),
        sampler: cleanSampler(firstText(comment.sampler, comment.Sampler, base.sampler)),
        steps: valueOrBlank(comment.steps, base.steps),
        scale: valueOrBlank(comment.scale, comment.cfg_scale, base.scale),
        cfgRescale: valueOrBlank(comment.cfg_rescale, comment.cfg_rescale, base.cfg_rescale),
        noiseSchedule: valueOrBlank(comment.noise_schedule, comment.noiseSchedule),
        seed: valueOrBlank(comment.seed, base.seed),
        width: valueOrBlank(comment.width, base.width, data.metadata.png?.width, data.metadata.webp?.width),
        height: valueOrBlank(comment.height, base.height, data.metadata.png?.height, data.metadata.webp?.height),
        nSamples: valueOrBlank(comment.n_samples, comment.nSamples),
        requestType: firstText(comment.request_type, base.request_type)
      };
    }
  }

  return null;
}

function normalizeNovelCandidate(value) {
  const parsed = tryParseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const base = { ...parsed };
  let comment = {};

  const commentValue = base.Comment ?? base.comment ?? base.parameters ?? base.Parameters;
  const parsedComment = tryParseJson(commentValue);
  if (parsedComment && typeof parsedComment === 'object' && !Array.isArray(parsedComment)) comment = parsedComment;
  else if (typeof commentValue === 'string') comment = parseLooseParameterText(commentValue);

  const cleanedBase = { ...base };
  if (typeof cleanedBase.Comment === 'string') cleanedBase.Comment = comment;
  if (typeof cleanedBase.comment === 'string') cleanedBase.comment = comment;

  return {
    base: cleanedBase,
    comment,
    raw: deepParseJsonStrings(cleanedBase)
  };
}

function parseLooseParameterText(text) {
  const out = {};
  if (!text || typeof text !== 'string') return out;

  const patterns = {
    prompt: /^(.*?)(?:\nNegative prompt:|\nSteps:|$)/s,
    negative_prompt: /Negative prompt:\s*(.*?)(?:\nSteps:|$)/s,
    steps: /Steps:\s*([^,\n]+)/i,
    sampler: /Sampler:\s*([^,\n]+)/i,
    scale: /CFG scale:\s*([^,\n]+)/i,
    seed: /Seed:\s*([^,\n]+)/i,
    model: /Model:\s*([^,\n]+)/i
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match && match[1] && match[1].trim()) out[key] = match[1].trim();
  }
  return out;
}

function extractV4Caption(comment, keys) {
  if (!comment || typeof comment !== 'object') return { base: '', charCaptions: [] };

  for (const key of keys) {
    const raw = comment[key];
    if (raw === undefined || raw === null || raw === '') continue;

    const obj = tryParseJson(raw);
    const caption = obj?.caption || obj?.Caption || obj?.prompt || obj?.Prompt || obj;

    const base = firstText(
      caption?.base_caption,
      caption?.baseCaption,
      caption?.base,
      caption?.prompt,
      caption?.uc,
      obj?.base_caption,
      obj?.baseCaption,
      obj?.prompt,
      obj?.uc
    );

    const charSource =
      caption?.char_captions ??
      caption?.charCaptions ??
      caption?.characters ??
      caption?.chars ??
      obj?.char_captions ??
      obj?.charCaptions ??
      obj?.characters ??
      obj?.chars;

    const charCaptions = normalizeCharCaptions(charSource);

    if (base || charCaptions.length) {
      return { base, charCaptions, raw: obj };
    }
  }

  return { base: '', charCaptions: [] };
}

function normalizeCharCaptions(value) {
  if (value === undefined || value === null || value === '') return [];

  if (typeof value === 'string') {
    return value
      .split(/\n{2,}/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .map(item => extractCharCaptionText(item))
      .filter(Boolean);
  }

  if (typeof value === 'object') {
    return Object.values(value)
      .map(item => extractCharCaptionText(item))
      .filter(Boolean);
  }

  return [];
}

function extractCharCaptionText(item) {
  if (item === undefined || item === null) return '';

  if (typeof item === 'string' || typeof item === 'number') {
    return String(item).trim();
  }

  if (Array.isArray(item)) {
    return item
      .map(part => extractCharCaptionText(part))
      .filter(Boolean)
      .join(', ');
  }

  if (typeof item === 'object') {
    return firstText(
      item.char_caption,
      item.charCaption,
      item.caption,
      item.prompt,
      item.description,
      item.text,
      item.value,
      item.uc,
      item.negative_prompt,
      item.negativePrompt,
      item.negative
    );
  }

  return '';
}

function buildV4CharacterPromptLines(v4Positive, v4Negative) {
  const positiveChars = v4Positive?.charCaptions || [];
  const negativeChars = v4Negative?.charCaptions || [];
  const max = Math.max(positiveChars.length, negativeChars.length);
  const lines = [];

  for (let i = 0; i < max; i++) {
    const positive = cleanPromptLine(positiveChars[i]);
    const negative = cleanPromptLine(negativeChars[i]);

    if (positive && negative) {
      const positiveWithPrefix = ensureCharacterPrefix(positive);
      const cleanNegative = negative.replace(/^uc\s*=\s*/i, '').trim();
      if (/\buc\s*=/.test(positiveWithPrefix)) lines.push(positiveWithPrefix);
      else lines.push(`${positiveWithPrefix} uc=${cleanNegative}`);
    } else if (positive) {
      lines.push(ensureCharacterPrefix(positive));
    } else if (negative) {
      lines.push(`uc=${negative.replace(/^uc\s*=\s*/i, '').trim()}`);
    }
  }

  return lines;
}

function ensureCharacterPrefix(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^c\s*=/i.test(text)) return text;
  return `c=${text}`;
}

function cleanPromptLine(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}


function addResultCard(file, data) {
  const node = template.content.cloneNode(true);
  const card = node.querySelector('.result-card');
  const preview = node.querySelector('.preview');
  const fileName = node.querySelector('.file-name');
  const fileNote = node.querySelector('.file-note');
  const summaryGrid = node.querySelector('.summary-grid');
  const promptOutput = node.querySelector('.prompt-output');
  const rawOutput = node.querySelector('.raw-output');
  const technicalOutput = node.querySelector('.technical-output');
  const copyPromptBtn = node.querySelector('.copy-prompt-btn');
  const copyJsonBtn = node.querySelector('.copy-json-btn');
  const downloadBtn = node.querySelector('.download-btn');
  const showMoreBtn = node.querySelector('.show-more-btn');

  const objectUrl = URL.createObjectURL(file);
  preview.src = objectUrl;
  preview.onload = () => URL.revokeObjectURL(objectUrl);

  fileName.textContent = data.file?.name || file.name;
  fileNote.textContent = `${data.detectedType || 'Unknown'} / ${data.file?.sizeReadable || formatBytes(file.size)}`;

  if (data.error) {
    promptOutput.textContent = `讀取失敗：${data.error}`;
    rawOutput.textContent = '{}';
    technicalOutput.textContent = data.error;
    summaryGrid.append(...summaryItems({ 狀態: '讀取失敗' }));
  } else {
    const promptText = formatNovelPrompt(data);
    const rawJson = formatRawMetadata(data);
    const technicalText = formatTechnicalInfo(data);

    renderPromptBlocks(promptOutput, data, promptText);
    rawOutput.textContent = rawJson;
    technicalOutput.textContent = technicalText;
    summaryGrid.append(...summaryItems(buildSummary(data)));

    copyPromptBtn.addEventListener('click', () => copyText(promptText, copyPromptBtn, '複製文本'));
    copyJsonBtn.addEventListener('click', () => copyText(rawJson, copyJsonBtn, '複製 JSON'));
    downloadBtn.addEventListener('click', () => downloadText(file.name, promptText, rawJson, technicalText));
  }

  showMoreBtn.addEventListener('click', () => {
    rawOutput.classList.toggle('collapsed');
    showMoreBtn.textContent = rawOutput.classList.contains('collapsed') ? '顯示全部' : '收起';
  });

  resultsEl.prepend(card);
  resultCount += 1;
  counterEl.textContent = `${resultCount} 個檔案`;
}


function renderPromptBlocks(container, data, fallbackText) {
  container.innerHTML = '';

  const nai = data?.novelAI;
  if (!nai) {
    const pre = document.createElement('pre');
    pre.className = 'prompt-fallback';
    pre.textContent = fallbackText || '未找到可整理的 NovelAI metadata。';
    container.append(pre);
    return;
  }

  container.append(buildPromptCard('機器人指令', buildRobotCommand(nai), 'command'));
  container.append(buildPromptCard('prompt=', nai.positive || '(空)', 'prompt'));

  for (const entry of nai.characterPrompts || []) {
    const parsed = parseCharacterPromptEntry(entry);
    if (parsed.c) container.append(buildPromptCard('c=', parsed.c, 'character'));
    if (parsed.uc) container.append(buildPromptCard('uc=', parsed.uc, 'uc'));
  }

  container.append(buildPromptCard('negative_prompt=', nai.negative || '(空)', 'negative'));
  container.append(buildPromptCard('生成參數', buildGenerationLine(nai), 'meta'));
}

function buildPromptCard(label, content, tone) {
  const section = document.createElement('section');
  section.className = `prompt-card ${tone ? `prompt-card-${tone}` : ''}`.trim();

  const header = document.createElement('div');
  header.className = 'prompt-card-header';
  header.textContent = label;

  const body = document.createElement('div');
  body.className = 'prompt-card-body';
  body.textContent = content || '(空)';

  section.append(header, body);
  return section;
}

function formatNovelPrompt(data) {
  const nai = data.novelAI;
  if (!nai) {
    return [
      '未找到可整理的 NovelAI metadata。',
      '',
      '可能原因：',
      '1. 圖片不是由 NovelAI 產生。',
      '2. 圖片被壓縮、截圖或重新儲存，metadata 已被移除。',
      '3. Metadata 使用了本工具暫不支援的格式。'
    ].join('\n');
  }

  const command = buildRobotCommand(nai);
  const lines = [];
  lines.push(command);
  lines.push('');
  lines.push('prompt=');
  lines.push(nai.positive || '(空)');

  if (nai.characterPrompts?.length) {
    lines.push('');
    lines.push(...formatCharacterPromptBlocks(nai.characterPrompts));
  }

  lines.push('');
  lines.push('negative_prompt=');
  lines.push(nai.negative || '(空)');
  lines.push('');
  lines.push(buildGenerationLine(nai));
  return lines.join('\n');
}

function formatCharacterPromptBlocks(entries) {
  const lines = [];

  for (const entry of entries || []) {
    const parsed = parseCharacterPromptEntry(entry);

    if (parsed.c) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push('c=');
      lines.push(parsed.c);
    }

    if (parsed.uc) {
      lines.push('');
      lines.push('uc=');
      lines.push(parsed.uc);
    }

    if (parsed.c || parsed.uc) lines.push('');
  }

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function parseCharacterPromptEntry(entry) {
  const text = String(entry ?? '').trim();
  if (!text) return { c: '', uc: '' };

  if (/^uc\s*=/i.test(text)) {
    return {
      c: '',
      uc: text.replace(/^uc\s*=\s*/i, '').trim()
    };
  }

  if (!/^c\s*=/i.test(text)) {
    return { c: text, uc: '' };
  }

  const withoutC = text.replace(/^c\s*=\s*/i, '');
  const ucIndex = withoutC.search(/\buc\s*=/i);

  if (ucIndex < 0) {
    return { c: withoutC.trim(), uc: '' };
  }

  return {
    c: withoutC.slice(0, ucIndex).trim(),
    uc: withoutC.slice(ucIndex).replace(/^uc\s*=\s*/i, '').trim()
  };
}

function buildRobotCommand(nai) {
  const parts = [];
  if (nai.modelLabel) parts.push(`模型=${nai.modelLabel}`);
  if (nai.sampler) parts.push(`sampler=${nai.sampler}`);
  if (nai.scale !== '') parts.push(`scale=${nai.scale}`);
  if (nai.cfgRescale !== '') parts.push(`cfg_rescale=${nai.cfgRescale}`);
  if (nai.noiseSchedule !== '') parts.push(`noise_schedule=${nai.noiseSchedule}`);
  return `/繪畫 ${parts.join(' ')}`.trim();
}

function buildGenerationLine(nai) {
  const items = [];
  if (nai.modelLabel) items.push(`生成類型=${nai.modelLabel}`);
  if (nai.source) items.push(`模型/來源=${nai.source}`);
  if (nai.sampler) items.push(`採樣器=${nai.sampler}`);
  if (nai.steps !== '') items.push(`steps=${nai.steps}`);
  if (nai.width !== '' && nai.height !== '') items.push(`尺寸=${nai.width}x${nai.height}`);
  if (nai.scale !== '') items.push(`scale=${nai.scale}`);
  if (nai.cfgRescale !== '') items.push(`cfg_rescale=${nai.cfgRescale}`);
  if (nai.noiseSchedule !== '') items.push(`noise_schedule=${nai.noiseSchedule}`);
  if (nai.seed !== '') items.push(`seed=${nai.seed}`);
  if (nai.nSamples !== '') items.push(`n_samples=${nai.nSamples}`);
  return items.length ? items.join(' | ') : '未找到生成參數';
}

function buildSummary(data) {
  const nai = data.novelAI;
  if (!nai) {
    return {
      狀態: '未找到 NovelAI metadata',
      格式: data.detectedType,
      大小: data.file.sizeReadable,
      LSB: data.metadata.stealth?.found ? '有，但未能整理' : '沒有找到'
    };
  }

  return {
    狀態: '已整理 NovelAI metadata',
    來源: nai.sourceLabel,
    模型: nai.modelLabel || nai.source || '未知',
    採樣器: nai.sampler || '未知',
    尺寸: nai.width && nai.height ? `${nai.width}x${nai.height}` : '未知',
    Seed: nai.seed !== '' ? nai.seed : '未知'
  };
}

function summaryItems(obj) {
  return Object.entries(obj).map(([label, value]) => {
    const div = document.createElement('div');
    div.className = 'summary-item';
    div.innerHTML = `<span class="summary-label"></span><span class="summary-value"></span>`;
    div.querySelector('.summary-label').textContent = label;
    div.querySelector('.summary-value').textContent = String(value ?? '');
    return div;
  });
}

function formatRawMetadata(data) {
  if (data.novelAI) return JSON.stringify(data.novelAI.raw, null, 2);

  const fallback = {
    stealth: data.metadata.stealth?.found ? deepParseJsonStrings(data.metadata.stealth.parsed || data.metadata.stealth.text) : data.metadata.stealth,
    pngText: data.metadata.png?.text || null,
    jpegText: data.metadata.jpeg?.textSegments || null,
    webpText: data.metadata.webp?.textChunks || null
  };
  return JSON.stringify(fallback, null, 2);
}

function formatTechnicalInfo(data) {
  const info = {
    file: data.file,
    detectedType: data.detectedType,
    png: data.metadata.png ? {
      width: data.metadata.png.width,
      height: data.metadata.png.height,
      textKeys: data.metadata.png.textKeys,
      chunks: data.metadata.png.chunks
    } : undefined,
    jpeg: data.metadata.jpeg ? {
      segments: data.metadata.jpeg.segments
    } : undefined,
    webp: data.metadata.webp ? {
      width: data.metadata.webp.width,
      height: data.metadata.webp.height,
      chunks: data.metadata.webp.chunks
    } : undefined,
    stealth: data.metadata.stealth ? {
      found: data.metadata.stealth.found,
      signature: data.metadata.stealth.signature,
      mode: data.metadata.stealth.mode,
      compressed: data.metadata.stealth.compressed,
      payloadBitLength: data.metadata.stealth.payloadBitLength,
      note: data.metadata.stealth.note,
      error: data.metadata.stealth.error
    } : undefined
  };
  return JSON.stringify(removeUndefined(info), null, 2);
}

function clearResults() {
  resultsEl.innerHTML = '';
  resultCount = 0;
  counterEl.textContent = '0 個檔案';
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

async function copyText(text, button, normalText) {
  await navigator.clipboard.writeText(text);
  button.textContent = '已複製';
  setTimeout(() => { button.textContent = normalText; }, 1200);
}

function downloadText(fileName, promptText, rawJson, technicalText) {
  const content = [
    'AI 繪圖機器人指令',
    promptText,
    '',
    '原始 JSON',
    rawJson,
    '',
    '檔案與 Chunk 資料',
    technicalText
  ].join('\n');

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFilename(fileName)}.metadata.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function deepParseJsonStrings(value) {
  if (typeof value === 'string') return tryParseJson(value);
  if (Array.isArray(value)) return value.map(item => deepParseJsonStrings(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepParseJsonStrings(item);
    return out;
  }
  return value;
}

function firstText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function valueOrBlank(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    return value;
  }
  return '';
}

function cleanSampler(value) {
  if (!value) return '';
  const text = String(value).replace(/^k_/, '').replace(/_/g, ' ');
  const map = {
    'euler ancestral': 'Euler a',
    euler: 'Euler',
    'dpmpp 2m': 'DPM++ 2M',
    'dpmpp sde': 'DPM++ SDE'
  };
  return map[text.toLowerCase()] || text;
}

function inferNaiModel(base, comment, source, software) {
  const text = `${base.Source || ''} ${base.Software || ''} ${comment.model || ''} ${comment.request_type || ''} ${source || ''} ${software || ''}`.toLowerCase();
  if (/4\.5|v4\.5|nai4\.5|nai-diffusion-4-5|nai diffusion 4\.5/.test(text)) return 'NAI4.5';
  if (/nai[ -]?diffusion[ -]?4|v4|nai4/.test(text)) return 'NAI4';
  if (/nai[ -]?diffusion[ -]?3|v3|nai3/.test(text)) return 'NAI3';
  if (/novelai|novel ai|nai/.test(text)) return 'NovelAI';
  return '';
}

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = removeUndefined(item);
    }
    return out;
  }
  return value;
}

async function inflateGzip(bytes) {
  if ('DecompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('This browser does not support gzip DecompressionStream.');
}

async function inflateDeflate(bytes) {
  const inflated = await inflateDeflateToBytes(bytes);
  return utf8.decode(inflated);
}

async function inflateDeflateToBytes(bytes) {
  if ('DecompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('This browser does not support deflate DecompressionStream.');
}

function bitsToString(bits, start, length) {
  return utf8.decode(bitsToBytes(bits, start, length));
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

function extractPrintableText(bytes) {
  const text = utf8.decode(bytes);
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
