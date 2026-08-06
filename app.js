const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

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

function emptyFields() {
  return { containerNumber: '', sealNo: '', booking: '' };
}

function normalize(value) {
  return String(value || '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/[-_/.:]/g, '')
    .replace(/[‐‑‒–—]/g, '')
    .replace(/[๐-๙]/g, (d) => ({'๐':'0','๑':'1','๒':'2','๓':'3','๔':'4','๕':'5','๖':'6','๗':'7','๘':'8','๙':'9'}[d] || d));
}

function cleanValue(value) {
  return String(value || '')
    .replace(/^[\s:=#-]+/, '')
    .replace(/[\s,;|]+$/, '')
    .trim();
}

function findValue(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanValue(match[1]);
  }
  return '';
}

function extractFields(text) {
  const source = String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n');

  return {
    containerNumber: findValue(source, [
      /CONTAINER\s*(?:NUMBER|NO\.?|#)?\s*[:=\-]?\s*([A-Z]{4}\s*[- ]?\s*[0-9๐-๙]{7})/i,
      /(?:หมายเลขตู้|เลขตู้|ตู้คอนเทนเนอร์|หมายเลขคอนเทนเนอร์)\s*[:=\-]?\s*([A-Z]{4}\s*[- ]?\s*[0-9๐-๙]{7})/i,
      /\b([A-Z]{4}\s*[- ]?\s*[0-9๐-๙]{7})\b/i,
    ]),
    sealNo: findValue(source, [
      /SEAL\s*(?:NUMBER|NO\.?|#)?\s*[:=\-]?\s*([A-Z0-9๐-๙][A-Z0-9๐-๙\-_/]{2,})/i,
      /(?:หมายเลขซีล|เลขซีล|ซีล)\s*[:=\-]?\s*([A-Z0-9๐-๙][A-Z0-9๐-๙\-_/]{2,})/i,
    ]),
    booking: findValue(source, [
      /BOOKING\s*(?:NUMBER|NO\.?|#)?\s*[:=\-]?\s*([A-Z0-9๐-๙][A-Z0-9๐-๙\-_/]{2,})/i,
      /(?:หมายเลขบุ๊กกิ้ง|เลขบุ๊กกิ้ง|บุ๊กกิ้ง|หมายเลขจอง|เลขที่จอง)\s*[:=\-]?\s*([A-Z0-9๐-๙][A-Z0-9๐-๙\-_/]{2,})/i,
    ]),
  };
}

function compare(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return { missing: !na || !nb, match: Boolean(na && nb && na === nb), na, nb };
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
  document.querySelector('#progressBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
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
  input.addEventListener('change', () => setFile(index, input.files?.[0] || null));
  ['dragenter', 'dragover'].forEach((eventName) => drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((eventName) => drop.addEventListener(eventName, (event) => {
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
  document.querySelector(`#fileName${index + 1}`).textContent = file?.name || 'ยังไม่ได้เลือกไฟล์';
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
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const canvas = await renderPdfPage(pdf, 1, 1.15);
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

async function renderPdfPage(pdf, pageNumber, scale = 2) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

async function fileToImages(file) {
  if (file.type.startsWith('image/')) return [file];
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const canvases = [];
    const maxPages = Math.min(pdf.numPages, 10);
    for (let page = 1; page <= maxPages; page += 1) {
      canvases.push(await renderPdfPage(pdf, page, 2));
    }
    return canvases;
  }
  throw new Error('รองรับเฉพาะไฟล์ PDF, JPG, JPEG, PNG และ WEBP');
}

async function runOcrOnFile(file, fileNumber, startPercent, endPercent) {
  const images = await fileToImages(file);
  const worker = await Tesseract.createWorker('eng+tha', 1, {
    logger: (message) => {
      if (message.status === 'recognizing text') {
        const local = message.progress || 0;
        const percent = startPercent + (endPercent - startPercent) * local;
        setProgress(percent, `กำลังอ่านข้อมูล ${fileNumber}: ${Math.round(local * 100)}%`);
      }
    },
  });

  const chunks = [];
  try {
    for (let i = 0; i < images.length; i += 1) {
      const pageStart = startPercent + ((endPercent - startPercent) * i) / images.length;
      setProgress(pageStart, `กำลังอ่านข้อมูล ${fileNumber} หน้า ${i + 1}/${images.length}`);
      const result = await worker.recognize(images[i]);
      chunks.push(result.data.text || '');
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
    const result = compare(state.fields[0][config.key], state.fields[1][config.key]);
    const statusClass = result.missing ? 'missing' : result.match ? 'match' : 'mismatch';
    const statusText = result.missing ? 'ไม่พบข้อมูล' : result.match ? 'ตรงกัน' : 'ไม่ตรงกัน';
    const hint = diffHint(state.fields[0][config.key], state.fields[1][config.key]);

    row.innerHTML = `
      <td>${config.label}</td>
      <td><input data-side="0" data-key="${config.key}" value="${escapeHtml(state.fields[0][config.key])}" aria-label="${config.label} ข้อมูล 1"></td>
      <td><input data-side="1" data-key="${config.key}" value="${escapeHtml(state.fields[1][config.key])}" aria-label="${config.label} ข้อมูล 2"></td>
      <td><span class="status ${statusClass}">${statusText}</span>${hint ? `<div class="char-diff">${hint}</div>` : ''}</td>
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

  const passed = FIELD_CONFIG.every(({ key }) => compare(state.fields[0][key], state.fields[1][key]).match);
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
    setProgress(2, 'กำลังเตรียม OCR สำหรับข้อมูล 1...');
    state.text[0] = await runOcrOnFile(state.files[0], 1, 5, 48);
    setProgress(50, 'กำลังเตรียม OCR สำหรับข้อมูล 2...');
    state.text[1] = await runOcrOnFile(state.files[1], 2, 52, 95);
    state.fields[0] = extractFields(state.text[0]);
    state.fields[1] = extractFields(state.text[1]);

    document.querySelector('#rawText1').textContent = state.text[0];
    document.querySelector('#rawText2').textContent = state.text[1];
    document.querySelector('#reportFile1').textContent = state.files[0].name;
    document.querySelector('#reportFile2').textContent = state.files[1].name;
    document.querySelector('#reportDate').textContent = new Date().toLocaleString('th-TH');
    renderResults();
    document.querySelector('#resultSection').classList.remove('hidden');
    setProgress(100, 'อ่านและเปรียบเทียบเสร็จแล้ว');
    document.querySelector('#resultSection').scrollIntoView({ behavior: 'smooth' });
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
  [1, 2].forEach((number) => {
    document.querySelector(`#file${number}`).value = '';
    document.querySelector(`#fileName${number}`).textContent = 'ยังไม่ได้เลือกไฟล์';
    document.querySelector(`#preview${number}`).innerHTML = '<span>ตัวอย่างเอกสารจะแสดงที่นี่</span>';
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
