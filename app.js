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
  return String(value || '').replace(/[๐-๙]/g, d => THAI_DIGITS[d] || d);
}

function normalize(value) {
  return thaiToArabic(value)
    .toUpperCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/[-_/.:,;|()[\]{}]/g, '')
    .replace(/[‐‑‒–—]/g, '');
}

function cleanValue(value) {
  return thaiToArabic(String(value || ''))
    .toUpperCase()
    .replace(/[“”"'`]/g, '')
    .replace(/^[\s:=#\-–—.]+/, '')
    .replace(/[\s,;|.]+$/, '')
    .trim();
}

function labelNormalized(line) {
  return thaiToArabic(String(line || ''))
    .toUpperCase()
    // Fix OCR mistakes ONLY for label matching, never blindly for values.
    .replace(/B[0O][0O]K[I1L]NG/g, 'BOOKING')
    .replace(/C[0O]NTA[I1L]NER/g, 'CONTAINER')
    .replace(/N[0O][\.\:]?/g, 'NO')
    .replace(/SEA[I1L]/g, 'SEAL')
    .replace(/\s+/g, ' ')
    .trim();
}

function linesOf(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

const LABELS = {
  containerNumber: [
    /CONTAINER\s*(?:NUMBER|NO|#)?/i,
    /หมายเลข\s*ตู้|เลข\s*ตู้|ตู้\s*คอนเทนเนอร์|หมายเลข\s*คอนเทนเนอร์/i,
  ],
  sealNo: [
    /SEAL\s*(?:NUMBER|NO|#)?/i,
    /หมายเลข\s*ซีล|เลข\s*ซีล|ซีล/i,
  ],
  booking: [
    /BOOKING\s*(?:NUMBER|NO|#)?/i,
    /หมายเลข\s*บุ๊กกิ้ง|เลข\s*บุ๊กกิ้ง|บุ๊กกิ้ง|หมายเลข\s*จอง|เลขที่\s*จอง|เลข\s*จอง/i,
  ],
};

function isAnyFieldLabel(line) {
  const fixed = labelNormalized(line);
  return Object.values(LABELS).some(patterns =>
    patterns.some(p => p.test(fixed))
  );
}

function valueLooksLikeContainer(raw) {
  const c = repairContainer(raw);
  return /^[A-Z]{4}\d{7}$/.test(c);
}

function repairContainer(raw) {
  let compact = cleanValue(raw).replace(/[^A-Z0-9]/g, '');
  if (compact.length < 11) return compact;

  // Work only on a probable 11-character ISO-style container candidate.
  compact = compact.slice(0, 11);
  let prefix = compact.slice(0, 4)
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/5/g, 'S')
    .replace(/8/g, 'B');
  let digits = compact.slice(4)
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/Z/g, '2')
    .replace(/S/g, '5')
    .replace(/G/g, '6')
    .replace(/B/g, '8');

  return prefix + digits;
}

function cleanGenericCode(raw) {
  return cleanValue(raw).replace(/[^A-Z0-9]/g, '');
}

function valueLooksLikeGenericCode(raw) {
  const v = cleanGenericCode(raw);
  return v.length >= 5 && v.length <= 24 && /\d/.test(v);
}

// Remove a matched label from the start/middle of a line and return only the
// text following that exact label. This prevents Order/Invoice/etc. being chosen.
function afterSpecificLabel(line, fieldKey) {
  const original = thaiToArabic(String(line || ''));
  const fixed = labelNormalized(original);

  const fieldPatterns = LABELS[fieldKey];
  for (const p of fieldPatterns) {
    const m = fixed.match(p);
    if (!m || m.index == null) continue;

    // Because labelNormalized preserves overall character order sufficiently,
    // take the visible tail after the label and stop at the next known label.
    const start = m.index + m[0].length;
    let tail = fixed.slice(start);

    // Stop before another field heading if OCR placed several columns on one line.
    const stopTokens = [
      'CONTAINER', 'SEAL', 'BOOKING',
      'หมายเลขตู้', 'เลขตู้', 'หมายเลขซีล', 'เลขซีล',
      'หมายเลขจอง', 'เลขจอง', 'บุ๊กกิ้ง',
      'REMARK', 'LOCATION', 'STATUS', 'SIZE', 'DATE',
      'ORDER', 'INVOICE', 'LINER', 'GENERATOR'
    ];

    let stop = tail.length;
    for (const token of stopTokens) {
      const idx = tail.indexOf(token);
      if (idx > 0 && idx < stop) stop = idx;
    }
    tail = tail.slice(0, stop);

    return tail.replace(/^[\s:=#\-–—.]+/, '').trim();
  }
  return '';
}

function tokenCandidates(value) {
  return String(value || '')
    .toUpperCase()
    .match(/[A-Z0-9๐-๙][A-Z0-9๐-๙\-_/]{3,24}/g) || [];
}

function extractContainerStrict(lines) {
  // 1) Prefer value following CONTAINER label.
  for (let i = 0; i < lines.length; i++) {
    const fixed = labelNormalized(lines[i]);
    if (!LABELS.containerNumber.some(p => p.test(fixed))) continue;

    const sameLine = afterSpecificLabel(lines[i], 'containerNumber');
    for (const token of tokenCandidates(sameLine)) {
      if (valueLooksLikeContainer(token)) return repairContainer(token);
    }

    // Allow only the next two lines, and stop if we encounter another heading.
    for (let step = 1; step <= 2; step++) {
      const next = lines[i + step] || '';
      if (!next || isAnyFieldLabel(next)) break;
      for (const token of tokenCandidates(next)) {
        if (valueLooksLikeContainer(token)) return repairContainer(token);
      }
    }
  }

  // 2) Container number has a uniquely strict ISO-like shape, so a global
  // fallback is safe enough ONLY for this field.
  const whole = thaiToArabic(lines.join(' ')).toUpperCase();
  const matches = whole.match(/\b[A-Z0-9]{4}[\s\-]?[A-Z0-9]{7}\b/g) || [];
  for (const candidate of matches) {
    if (valueLooksLikeContainer(candidate)) return repairContainer(candidate);
  }

  return '';
}

function extractAnchoredGeneric(lines, fieldKey) {
  // SEAL and BOOKING must NEVER use a global "guess any code" fallback.
  // They are returned only when found next to their own heading.
  for (let i = 0; i < lines.length; i++) {
    const fixed = labelNormalized(lines[i]);
    if (!LABELS[fieldKey].some(p => p.test(fixed))) continue;

    const sameLine = afterSpecificLabel(lines[i], fieldKey);
    const sameTokens = tokenCandidates(sameLine)
      .map(cleanGenericCode)
      .filter(valueLooksLikeGenericCode);

    if (sameTokens.length) {
      // Usually the first code following the exact heading is the desired value.
      return sameTokens[0];
    }

    // If OCR separated label/value into lines, inspect only the immediate next
    // line. Do not roam around the document.
    const next = lines[i + 1] || '';
    if (next && !isAnyFieldLabel(next)) {
      const nextTokens = tokenCandidates(next)
        .map(cleanGenericCode)
        .filter(valueLooksLikeGenericCode);
      if (nextTokens.length) return nextTokens[0];
    }
  }

  return '';
}

function extractFields(text) {
  const lines = linesOf(text);
  return {
    containerNumber: extractContainerStrict(lines),
    sealNo: extractAnchoredGeneric(lines, 'sealNo'),
    booking: extractAnchoredGeneric(lines, 'booking'),
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
  for (let i = 0; i < max; i++) {
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

  ['dragenter', 'dragover'].forEach(eventName =>
    drop.addEventListener(eventName, event => {
      event.preventDefault();
      drop.classList.add('drag');
    }));

  ['dragleave', 'drop'].forEach(eventName =>
    drop.addEventListener(eventName, event => {
      event.preventDefault();
      drop.classList.remove('drag');
    }));

  drop.addEventListener('drop', event => {
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

async function renderPdfPage(pdf, pageNumber, scale = 2.6) {
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

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();

    // Preserve more separation between PDF text items than the old version.
    const items = content.items
      .map(item => ('str' in item ? item.str : ''))
      .filter(Boolean);

    pages.push(items.join('\n'));
  }

  return pages.join('\n');
}

async function imageFileToCanvas(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 3000;
  const scale = Math.min(3.2, maxSide / Math.max(bitmap.width, bitmap.height));
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

    for (let page = 1; page <= maxPages; page++) {
      canvases.push(await renderPdfPage(pdf, page, 3.0));
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

  if (mode === 'original') return canvas;

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(
      data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    );

    let value = gray;
    if (mode === 'contrast') {
      const factor = 1.7;
      value = Math.max(0, Math.min(255, (gray - 128) * factor + 128));
    } else if (mode === 'threshold') {
      value = gray < 190 ? 0 : 255;
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

function allThreeFound(fields) {
  return Boolean(fields.containerNumber && fields.sealNo && fields.booking);
}

async function runOcrOnFile(file, fileNumber, startPercent, endPercent) {
  const nativeText = await extractNativePdfText(file).catch(() => '');
  const nativeFields = extractFields(nativeText);

  if (allThreeFound(nativeFields)) {
    setProgress(endPercent, `ข้อมูล ${fileNumber}: พบทั้ง 3 หัวข้อจาก PDF`);
    return nativeText;
  }

  const canvases = await fileToCanvases(file);

  const worker = await Tesseract.createWorker('eng+tha', 1, {
    logger: message => {
      if (message.status === 'recognizing text') {
        const local = message.progress || 0;
        const percent = startPercent +
          (endPercent - startPercent) * Math.min(0.9, local);
        setProgress(percent,
          `กำลังอ่านข้อมูล ${fileNumber}: ${Math.round(local * 100)}%`);
      }
    },
  });

  const chunks = [nativeText];

  try {
    for (let pageIndex = 0; pageIndex < canvases.length; pageIndex++) {
      const page = canvases[pageIndex];
      const passes = [
        { name: 'ต้นฉบับ', mode: 'original', psm: 6 },
        { name: 'เพิ่ม Contrast', mode: 'contrast', psm: 6 },
        { name: 'ค้นหาข้อความกระจาย', mode: 'contrast', psm: 11 },
        { name: 'ขาวดำ', mode: 'threshold', psm: 11 },
      ];

      for (let passIndex = 0; passIndex < passes.length; passIndex++) {
        const pass = passes[passIndex];
        const processed = preprocessCanvas(page, pass.mode);

        setProgress(
          startPercent +
            (endPercent - startPercent) *
              ((pageIndex * passes.length + passIndex + 1) /
                (canvases.length * passes.length)),
          `ข้อมูล ${fileNumber} หน้า ${pageIndex + 1}: ${pass.name}`
        );

        const text = await recognizeCanvas(worker, processed, pass.psm);
        chunks.push(`\n--- OCR หน้า ${pageIndex + 1}: ${pass.name} ---\n${text}`);

        // Stop early only when the STRICT label-based parser has all 3.
        if (allThreeFound(extractFields(chunks.join('\n')))) break;
      }

      if (allThreeFound(extractFields(chunks.join('\n')))) break;
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
    const result = compare(
      state.fields[0][config.key],
      state.fields[1][config.key]
    );

    const statusClass = result.missing
      ? 'missing'
      : result.match ? 'match' : 'mismatch';

    const statusText = result.missing
      ? 'ไม่พบข้อมูล'
      : result.match ? 'ตรงกัน' : 'ไม่ตรงกัน';

    const hint = diffHint(
      state.fields[0][config.key],
      state.fields[1][config.key]
    );

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${config.label}</td>
      <td>
        <input data-side="0" data-key="${config.key}"
          value="${escapeHtml(state.fields[0][config.key])}"
          aria-label="${config.label} ข้อมูล 1">
      </td>
      <td>
        <input data-side="1" data-key="${config.key}"
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

  body.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', () => {
      const side = Number(input.dataset.side);
      const key = input.dataset.key;
      state.fields[side][key] = input.value;
      renderResults();
    });
  });

  const passed = FIELD_CONFIG.every(({ key }) =>
    compare(state.fields[0][key], state.fields[1][key]).match
  );

  const overall = document.querySelector('#overallStatus');
  overall.textContent = passed ? 'ผ่านการตรวจสอบ' : 'ไม่ผ่านการตรวจสอบ';
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
    setProgress(2, 'กำลังอ่านข้อมูล 1...');
    state.text[0] = await runOcrOnFile(state.files[0], 1, 4, 48);

    setProgress(50, 'กำลังอ่านข้อมูล 2...');
    state.text[1] = await runOcrOnFile(state.files[1], 2, 52, 96);

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
    showError(`ไม่สามารถประมวลผลไฟล์ได้: ${error?.message || error}`);
  } finally {
    button.disabled = false;
  }
}

function resetAll() {
  state.files = [null, null];
  state.text = ['', ''];
  state.fields = [emptyFields(), emptyFields()];

  [1, 2].forEach(number => {
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
document.querySelector('#checkButton').addEventListener('click', checkDocuments);
document.querySelector('#resetButton').addEventListener('click', resetAll);
document.querySelector('#printButton').addEventListener('click', () => window.print());
