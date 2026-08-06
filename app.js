const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

const state = {
  files: [null, null],
  text: ['', ''],
  fields: [emptyFields(), emptyFields()],
};

const FIELD_CONFIG = [
  { key: 'containerNumber', label: 'CONTAINER NUMBER' },
  { key: 'sealNo', label: 'SEAL NO' },
  { key: 'booking', label: 'BOOKING' },
];

const THAI_DIGITS = {
  '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
  '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9',
};

function emptyFields() {
  return { containerNumber: '', sealNo: '', booking: '' };
}

function thaiToArabic(value) {
  return String(value || '').replace(/[๐-๙]/g, (d) => THAI_DIGITS[d] || d);
}

function normalize(value) {
  return thaiToArabic(value)
    .toUpperCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/[-_/.:,;|()[\]{}]/g, '')
    .replace(/[‐‑‒–—]/g, '');
}

function cleanCandidate(value) {
  return thaiToArabic(value)
    .toUpperCase()
    .replace(/[“”"'`]/g, '')
    .replace(/^[\s:=#\-–—.]+/, '')
    .replace(/[\s,;|.]+$/, '')
    .trim();
}

function repairCommonOcrErrors(value, kind = 'generic') {
  let result = cleanCandidate(value)
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, '');

  if (kind === 'container') {
    const compact = result.replace(/[^A-Z0-9]/g, '');
    if (compact.length >= 11) {
      const first = compact.slice(0, 4)
        .replace(/0/g, 'O')
        .replace(/1/g, 'I')
        .replace(/5/g, 'S')
        .replace(/8/g, 'B');
      const rest = compact.slice(4, 11)
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1')
        .replace(/S/g, '5')
        .replace(/B/g, '8')
        .replace(/Z/g, '2')
        .replace(/G/g, '6');
      return first + rest;
    }
  }

  return result.replace(/[^A-Z0-9]/g, '');
}

function scoreCandidate(value, kind, context = '') {
  const v = repairCommonOcrErrors(value, kind);
  let score = 0;

  if (kind === 'container') {
    if (/^[A-Z]{4}\d{7}$/.test(v)) score += 100;
    if (/^[A-Z]{3}U\d{7}$/.test(v)) score += 15;
    if (v.length === 11) score += 10;
  } else {
    if (/^[A-Z0-9]{5,20}$/.test(v)) score += 40;
    if (/[A-Z]/.test(v) && /\d/.test(v)) score += 15;
    if (v.length >= 7 && v.length <= 14) score += 10;
  }

  const c = String(context || '').toUpperCase();
  if (kind === 'seal' && /SEAL|ซีล/.test(c)) score += 50;
  if (kind === 'booking' && /BOOK|บุ๊ก|จอง/.test(c)) score += 50;
  if (kind === 'container' && /CONTAINER|ตู้|คอนเทนเนอร์/.test(c)) score += 50;

  return { value: v, score };
}

function linesOf(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

function candidatesNearLabels(text, labels, kind) {
  const lines = linesOf(text);
  const output = [];

  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    const matched = labels.some((label) => label.test(current));
    if (!matched) continue;

    const neighborhood = [
      current,
      lines[i + 1] || '',
      lines[i + 2] || '',
      lines[i - 1] || '',
    ];

    for (const line of neighborhood) {
      const tokens = line.match(/[A-Z0-9๐-๙][A-Z0-9๐-๙\-_/ ]{3,24}/gi) || [];
      for (const token of tokens) {
        const scored = scoreCandidate(token, kind, neighborhood.join(' '));
        if (scored.value) output.push(scored);
      }
    }
  }
  return output;
}

function globalCandidates(text, kind) {
  const source = thaiToArabic(String(text || '')).toUpperCase();
  const output = [];

  if (kind === 'container') {
    const patterns = [
      /\b([A-Z0-9]{4}\s*[- ]?\s*[A-Z0-9]{7})\b/g,
      /\b([A-Z]{3}[U0]\s*[- ]?\s*[0-9OILSBZG]{7})\b/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        output.push(scoreCandidate(match[1], kind, match[0]));
      }
    }
  } else {
    const pattern = /\b([A-Z0-9][A-Z0-9\-_/]{4,19})\b/g;
    for (const match of source.matchAll(pattern)) {
      output.push(scoreCandidate(match[1], kind, match[0]));
    }
  }

  return output;
}

function bestCandidate(candidates, exclusions = []) {
  const excluded = new Set(exclusions.map(normalize));
  const unique = new Map();

  for (const item of candidates) {
    const key = normalize(item.value);
    if (!key || excluded.has(key)) continue;
    const old = unique.get(key);
    if (!old || item.score > old.score) unique.set(key, item);
  }

  return [...unique.values()]
    .sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0]?.value || '';
}

function extractFields(text) {
  const containerLabels = [
    /CONTA[I1L]NER\s*(?:NUMBER|N[O0]\.?|#)?/i,
    /หมายเลขตู้|เลขตู้|ตู้คอนเทนเนอร์|หมายเลขคอนเทนเนอร์/i,
  ];
  const sealLabels = [
    /SEA[L1I]\s*(?:NUMBER|N[O0]\.?|#)?/i,
    /หมายเลขซีล|เลขซีล|ซีล/i,
  ];
  const bookingLabels = [
    /B[O0][O0]K[I1L]NG\s*(?:NUMBER|N[O0]\.?|#)?/i,
    /หมายเลขบุ๊กกิ้ง|เลขบุ๊กกิ้ง|บุ๊กกิ้ง|หมายเลขจอง|เลขที่จอง|เลขจอง/i,
  ];

  const container = bestCandidate([
    ...candidatesNearLabels(text, containerLabels, 'container'),
    ...globalCandidates(text, 'container'),
  ]);

  const seal = bestCandidate([
    ...candidatesNearLabels(text, sealLabels, 'seal'),
    ...globalCandidates(text, 'seal').map((x) => ({ ...x, score: x.score - 25 })),
  ], [container]);

  const booking = bestCandidate([
    ...candidatesNearLabels(text, bookingLabels, 'booking'),
    ...globalCandidates(text, 'booking').map((x) => ({ ...x, score: x.score - 25 })),
  ], [container, seal]);

  return {
    containerNumber: container,
    sealNo: seal,
    booking,
  };
}

function compare(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return {
    missing: !na || !nb,
    match: Boolean(na && nb && na === nb),
    na,
    nb,
  };
}

function diffHint(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb || na === nb) return '';
  const max = Math.max(na.length, nb.length);
  const positions = [];
  for (let i = 0; i < max; i += 1) {
    if ((na[i] || '∅') !== (nb[i] || '∅')) positions.push(i + 1);
  }
  return `ต่างกันที่ตำแหน่ง: ${positions.slice(0, 20).join(', ')}${positions.length > 20 ? '…' : ''}`;
}

function setProgress(percent, text) {
  document.querySelector('#progressWrap').classList.remove('hidden');
  document.querySelector('#progressBar').style.width =
    `${Math.max(0, Math.min(100, percent))}%`;
  document.querySelector('#progressPercent').textContent = `${Math.round(percent)}%`;
  document.querySelector('#progressText').textContent = text;
}

function showError(message) {
  const box = document.querySelector('#errorBox');
  box.textContent = message;
  box.classList.remove('hidden');
}

function clearError() {
  document.querySelector('#errorBox').classList.add('hidden');
}

function attachUpload(index) {
  const input = document.querySelector(`#file${index + 1}`);
  const drop = document.querySelector(`#drop${index + 1}`);

  input.addEventListener('change', () =>
    setFile(index, input.files?.[0] || null));

  ['dragenter', 'dragover'].forEach((eventName) =>
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.add('drag');
    }));

  ['dragleave', 'drop'].forEach((eventName) =>
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.remove('drag');
    }));

  drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0] || null;
    if (file) setFile(index, file);
  });
}

async function setFile(index, file) {
  state.files[index] = file;
  state.text[index] = '';
  state.fields[index] = emptyFields();

  document.querySelector(`#fileName${index + 1}`).textContent =
    file?.name || 'ยังไม่ได้เลือกไฟล์';
  document.querySelector('#resultSection').classList.add('hidden');

  await renderPreview(index, file);
}

async function renderPreview(index, file) {
  const preview = document.querySelector(`#preview${index + 1}`);
  preview.innerHTML = '';

  if (!file) {
    preview.innerHTML = '<span>ตัวอย่างเอกสารจะแสดงที่นี่</span>';
    return;
  }

  if (isPdf(file)) {
    const pdf = await pdfjsLib.getDocument({
      data: await file.arrayBuffer(),
    }).promise;
    const canvas = await renderPdfPage(pdf, 1, 1.2);
    preview.append(canvas);

    if (pdf.numPages > 1) {
      const badge = document.createElement('span');
      badge.textContent = `PDF ${pdf.numPages} หน้า — แสดงตัวอย่างหน้าแรก`;
      badge.style.padding = '10px';
      preview.append(badge);
    }
  } else if (file.type.startsWith('image/')) {
    const img = new Image();
    img.alt = file.name;
    img.src = URL.createObjectURL(file);
    preview.append(img);
  } else {
    preview.innerHTML = '<span>ชนิดไฟล์ไม่รองรับ</span>';
  }
}

function isPdf(file) {
  return file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf');
}

async function renderPdfPage(pdf, pageNumber, scale = 2.5) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

async function extractNativePdfText(file) {
  if (!isPdf(file)) return '';

  const pdf = await pdfjsLib.getDocument({
    data: await file.arrayBuffer(),
  }).promise;

  const pages = [];
  const maxPages = Math.min(pdf.numPages, 10);

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    pages.push(content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' '));
  }

  return pages.join('\n');
}

async function imageFileToCanvas(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 2600;
  const scale = Math.min(3, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');

  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return canvas;
}

async function fileToCanvases(file) {
  if (file.type.startsWith('image/')) {
    return [await imageFileToCanvas(file)];
  }

  if (isPdf(file)) {
    const pdf = await pdfjsLib.getDocument({
      data: await file.arrayBuffer(),
    }).promise;

    const canvases = [];
    const maxPages = Math.min(pdf.numPages, 10);

    for (let page = 1; page <= maxPages; page += 1) {
      canvases.push(await renderPdfPage(pdf, page, 2.8));
    }
    return canvases;
  }

  throw new Error('รองรับเฉพาะไฟล์ PDF, JPG, JPEG, PNG และ WEBP');
}

function preprocessCanvas(source, mode) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(
      data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);

    let value = gray;

    if (mode === 'contrast') {
      value = gray < 175 ? Math.max(0, gray - 55) : Math.min(255, gray + 35);
    } else if (mode === 'threshold') {
      value = gray < 185 ? 0 : 255;
    } else if (mode === 'soft-threshold') {
      value = gray < 205 ? 20 : 255;
    }

    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function recognizeCanvas(worker, canvas, psm) {
  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });

  const result = await worker.recognize(canvas);
  return result.data.text || '';
}

async function runOcrOnFile(file, fileNumber, startPercent, endPercent) {
  const nativeText = await extractNativePdfText(file).catch(() => '');
  const nativeFields = extractFields(nativeText);

  if (nativeFields.containerNumber &&
      nativeFields.sealNo &&
      nativeFields.booking) {
    setProgress(endPercent, `ข้อมูล ${fileNumber}: อ่านจากข้อความใน PDF สำเร็จ`);
    return nativeText;
  }

  const canvases = await fileToCanvases(file);
  const worker = await Tesseract.createWorker('eng+tha', 1, {
    logger: (message) => {
      if (message.status === 'recognizing text') {
        const local = message.progress || 0;
        const percent = startPercent +
          (endPercent - startPercent) * Math.min(0.95, local);
        setProgress(
          percent,
          `กำลังอ่านข้อมูล ${fileNumber}: ${Math.round(local * 100)}%`
        );
      }
    },
  });

  const chunks = [nativeText];

  try {
    for (let i = 0; i < canvases.length; i += 1) {
      const page = canvases[i];
      const modes = [
        { name: 'ภาพต้นฉบับ', canvas: page, psm: 6 },
        { name: 'เพิ่มความคมชัด', canvas: preprocessCanvas(page, 'contrast'), psm: 6 },
        { name: 'ขาวดำ', canvas: preprocessCanvas(page, 'threshold'), psm: 11 },
        { name: 'ขาวดำแบบอ่อน', canvas: preprocessCanvas(page, 'soft-threshold'), psm: 11 },
      ];

      for (let pass = 0; pass < modes.length; pass += 1) {
        const mode = modes[pass];
        const step = (i * modes.length + pass + 1) /
          (canvases.length * modes.length);
        setProgress(
          startPercent + (endPercent - startPercent) * step,
          `ข้อมูล ${fileNumber} หน้า ${i + 1}: ${mode.name}`
        );

        const text = await recognizeCanvas(worker, mode.canvas, mode.psm);
        chunks.push(`\n--- หน้า ${i + 1} / ${mode.name} ---\n${text}`);

        const fields = extractFields(chunks.join('\n'));
        if (fields.containerNumber && fields.sealNo && fields.booking) break;
      }

      const current = extractFields(chunks.join('\n'));
      if (current.containerNumber && current.sealNo && current.booking) break;
    }
  } finally {
    await worker.terminate();
  }

  return chunks.join('\n');
}

function renderResults() {
  const body = document.querySelector('#resultBody');
  body.innerHTML = '';

  for (const config of FIELD_CONFIG) {
    const row = document.createElement('tr');
    const result = compare(
      state.fields[0][config.key],
      state.fields[1][config.key]
    );

    const statusClass = result.missing
      ? 'missing'
      : result.match
        ? 'match'
        : 'mismatch';

    const statusText = result.missing
      ? 'ไม่พบข้อมูล'
      : result.match
        ? 'ตรงกัน'
        : 'ไม่ตรงกัน';

    const hint = diffHint(
      state.fields[0][config.key],
      state.fields[1][config.key]
    );

    row.innerHTML = `
      <td>${config.label}</td>
      <td>
        <input
          data-side="0"
          data-key="${config.key}"
          value="${escapeHtml(state.fields[0][config.key])}"
          aria-label="${config.label} ข้อมูล 1">
      </td>
      <td>
        <input
          data-side="1"
          data-key="${config.key}"
          value="${escapeHtml(state.fields[1][config.key])}"
          aria-label="${config.label} ข้อมูล 2">
      </td>
      <td>
        <span class="status ${statusClass}">${statusText}</span>
        ${hint ? `<div class="char-diff">${hint}</div>` : ''}
      </td>
    `;

    body.append(row);
  }

  body.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      const side = Number(input.dataset.side);
      const key = input.dataset.key;
      state.fields[side][key] = input.value;
      renderResults();
    });
  });

  const passed = FIELD_CONFIG.every(({ key }) =>
    compare(state.fields[0][key], state.fields[1][key]).match);

  const overall = document.querySelector('#overallStatus');
  overall.textContent = passed
    ? 'ผ่านการตรวจสอบ'
    : 'ไม่ผ่านการตรวจสอบ';
  overall.className = `overall ${passed ? 'pass' : 'fail'}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function checkDocuments() {
  clearError();

  if (!state.files[0] || !state.files[1]) {
    showError('กรุณาเลือกไฟล์ข้อมูล 1 และข้อมูล 2 ให้ครบ');
    return;
  }

  const button = document.querySelector('#checkButton');
  button.disabled = true;

  try {
    setProgress(2, 'กำลังวิเคราะห์ข้อมูล 1...');
    state.text[0] = await runOcrOnFile(
      state.files[0], 1, 4, 48);

    setProgress(50, 'กำลังวิเคราะห์ข้อมูล 2...');
    state.text[1] = await runOcrOnFile(
      state.files[1], 2, 52, 96);

    state.fields[0] = extractFields(state.text[0]);
    state.fields[1] = extractFields(state.text[1]);

    document.querySelector('#rawText1').textContent = state.text[0];
    document.querySelector('#rawText2').textContent = state.text[1];
    document.querySelector('#reportFile1').textContent = state.files[0].name;
    document.querySelector('#reportFile2').textContent = state.files[1].name;
    document.querySelector('#reportDate').textContent =
      new Date().toLocaleString('th-TH');

    renderResults();
    document.querySelector('#resultSection').classList.remove('hidden');
    setProgress(100, 'อ่านและเปรียบเทียบเสร็จแล้ว');
    document.querySelector('#resultSection').scrollIntoView({
      behavior: 'smooth',
    });
  } catch (error) {
    console.error(error);
    showError(
      `ไม่สามารถประมวลผลไฟล์ได้: ${error?.message || error}`
    );
  } finally {
    button.disabled = false;
  }
}

function resetAll() {
  state.files = [null, null];
  state.text = ['', ''];
  state.fields = [emptyFields(), emptyFields()];

  [1, 2].forEach((number) => {
    document.querySelector(`#file${number}`).value = '';
    document.querySelector(`#fileName${number}`).textContent =
      'ยังไม่ได้เลือกไฟล์';
    document.querySelector(`#preview${number}`).innerHTML =
      '<span>ตัวอย่างเอกสารจะแสดงที่นี่</span>';
  });

  document.querySelector('#resultSection').classList.add('hidden');
  document.querySelector('#progressWrap').classList.add('hidden');
  clearError();
}

attachUpload(0);
attachUpload(1);
document.querySelector('#checkButton').addEventListener(
  'click', checkDocuments);
document.querySelector('#resetButton').addEventListener(
  'click', resetAll);
document.querySelector('#printButton').addEventListener(
  'click', () => window.print());
