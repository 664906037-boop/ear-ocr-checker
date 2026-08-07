const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

const state = {
  files: [null, null],
  texts: [[], []],
  fields: [emptyFields(), emptyFields()],
  candidates: [{}, {}],
};

const FIELD_CONFIG = [
  { key: 'containerNumber', label: 'CONTAINER NUMBER' },
  { key: 'sealNo', label: 'SEAL NO' },
  { key: 'booking', label: 'BOOKING' },
];

// IMPORTANT:
// side 0 = File 1 (EAR)
// side 1 = File 2 (Vehicle Control Form)
//
// We intentionally use DIFFERENT label maps for each document type.
// This prevents the parser from assuming that headings must be identical.
const SIDE_LABELS = [
  {
    containerNumber: [
      /CONTAINER\s*NUMBER/i,
      /CONTAINER\s*NO\.?/i,
      /หมายเลข\s*ตู้/i,
      /เลข\s*ตู้/i
    ],
    sealNo: [
      /SEAL\s*NO\.?/i,
      /SEAL\s*NUMBER/i,
      /หมายเลข\s*ซีล/i,
      /เลข\s*ซีล/i
    ],
    booking: [
      /BOOKING\b/i,
      /BOOKING\s*NO\.?/i,
      /BOOKING\s*NUMBER/i,
      /หมายเลข\s*จอง/i,
      /เลข\s*บุ๊กกิ้ง/i
    ]
  },
  {
    containerNumber: [
      /CONTAINER\s*NO\.?/i,
      /CONTAINER\s*NUMBER/i,
      /CONTAINER\b/i,
      /หมายเลข\s*ตู้/i,
      /เลข\s*ตู้/i
    ],
    sealNo: [
      /^SEAL\b/i,
      /SEAL\s*NO\.?/i,
      /SEAL\s*NUMBER/i,
      /หมายเลข\s*ซีล/i,
      /เลข\s*ซีล/i
    ],
    booking: [
      /BOOKING\s*NO\.?/i,
      /BOOKING\s*NUMBER/i,
      /BOOKING\b/i,
      /หมายเลข\s*จอง/i,
      /เลข\s*บุ๊กกิ้ง/i
    ]
  }
];

const THAI_DIGITS = {
  '๐':'0','๑':'1','๒':'2','๓':'3','๔':'4',
  '๕':'5','๖':'6','๗':'7','๘':'8','๙':'9'
};

function emptyFields() {
  return { containerNumber:'', sealNo:'', booking:'' };
}

function thaiToArabic(v) {
  return String(v || '').replace(/[๐-๙]/g, d => THAI_DIGITS[d] || d);
}

function normalize(v) {
  return thaiToArabic(v)
    .toUpperCase()
    .replace(/\s+/g,'')
    .replace(/[-_/.:,;|()[\]{}‐‑‒–—]/g,'');
}

function cleanCode(v) {
  return thaiToArabic(v)
    .toUpperCase()
    .replace(/[“”"'`]/g,'')
    .replace(/[^A-Z0-9]/g,'');
}

function fixLabelText(v) {
  return thaiToArabic(v)
    .toUpperCase()
    .replace(/C[0O]NTA[I1L]NER/g,'CONTAINER')
    .replace(/B[0O][0O]K[I1L]NG/g,'BOOKING')
    .replace(/SEA[I1L]/g,'SEAL')
    .replace(/N[0O]\.?/g,'NO')
    .replace(/\s+/g,' ')
    .trim();
}

function repairContainer(v) {
  const raw = cleanCode(v);
  if (raw.length < 11) return raw;
  const s = raw.slice(0,11);
  const prefix = s.slice(0,4)
    .replace(/0/g,'O')
    .replace(/1/g,'I')
    .replace(/5/g,'S')
    .replace(/8/g,'B');
  const digits = s.slice(4)
    .replace(/O/g,'0')
    .replace(/[IL]/g,'1')
    .replace(/Z/g,'2')
    .replace(/S/g,'5')
    .replace(/B/g,'8')
    .replace(/G/g,'6');
  return prefix + digits;
}

function codeTokens(text) {
  const src = thaiToArabic(String(text || '')).toUpperCase();
  return src.match(/[A-Z0-9][A-Z0-9\-_/]{4,23}/g) || [];
}

function lineList(text) {
  return String(text || '')
    .replace(/\r/g,'\n')
    .split(/\n+/)
    .map(x => x.replace(/[ \t]+/g,' ').trim())
    .filter(Boolean);
}

function isFieldLabel(line, side) {
  const fixed = fixLabelText(line);
  return Object.values(SIDE_LABELS[side]).some(arr =>
    arr.some(rx => rx.test(fixed))
  );
}

function fieldLabelMatch(line, side, fieldKey) {
  const fixed = fixLabelText(line);
  return SIDE_LABELS[side][fieldKey].some(rx => rx.test(fixed));
}

function stripLabel(line, side, fieldKey) {
  const fixed = fixLabelText(line);

  for (const rx of SIDE_LABELS[side][fieldKey]) {
    const match = fixed.match(rx);
    if (!match || match.index == null) continue;

    let tail = fixed.slice(match.index + match[0].length);

    // Stop before known headings from the same form so we do not steal
    // values belonging to another column/field.
    const stops = [
      'CONTAINER','SEAL','BOOKING',
      'ORDER','INVOICE','LINER','REMARK','LOCATION','STATUS',
      'SIZE','DATE','GENERATOR','OWNER','AGENT','SHIPPER'
    ];

    let stopAt = tail.length;
    for (const token of stops) {
      const idx = tail.indexOf(token);
      if (idx > 0 && idx < stopAt) stopAt = idx;
    }
    tail = tail.slice(0, stopAt);

    return tail.replace(/^[\s:=#\-–—.]+/,'').trim();
  }

  return '';
}

function validContainer(v) {
  return /^[A-Z]{4}\d{7}$/.test(repairContainer(v));
}

function validGeneric(v, fieldKey) {
  const c = cleanCode(v);
  if (c.length < 5 || c.length > 20) return false;
  if (!/\d/.test(c)) return false;

  // These fields in the user's forms are alphanumeric codes.
  // Require at least one alphabetic character to avoid phone/date/order numbers.
  if (!/[A-Z]/.test(c)) return false;

  if (fieldKey === 'sealNo' && (c.length < 7 || c.length > 14)) return false;
  if (fieldKey === 'booking' && (c.length < 8 || c.length > 16)) return false;

  return true;
}

function extractFieldFromText(text, side, fieldKey) {
  const lines = lineList(text);

  for (let i=0; i<lines.length; i++) {
    if (!fieldLabelMatch(lines[i], side, fieldKey)) continue;

    // A) Same line as the exact mapped heading.
    const tail = stripLabel(lines[i], side, fieldKey);
    for (const token of codeTokens(tail)) {
      if (fieldKey === 'containerNumber') {
        if (validContainer(token)) return repairContainer(token);
      } else if (validGeneric(token, fieldKey)) {
        return cleanCode(token);
      }
    }

    // B) OCR often puts the value on the next line.
    // Inspect ONLY the next 2 lines, and stop as soon as another known heading appears.
    for (let step=1; step<=2; step++) {
      const next = lines[i+step] || '';
      if (!next) break;
      if (isFieldLabel(next, side)) break;

      for (const token of codeTokens(next)) {
        if (fieldKey === 'containerNumber') {
          if (validContainer(token)) return repairContainer(token);
        } else if (validGeneric(token, fieldKey)) {
          return cleanCode(token);
        }
      }
    }
  }

  // Only container number gets a global fallback because its structure is
  // distinctive enough to safely identify without the label.
  if (fieldKey === 'containerNumber') {
    const src = thaiToArabic(String(text || '')).toUpperCase();
    const matches = src.match(/\b[A-Z0-9]{4}[\s\-]?[A-Z0-9]{7}\b/g) || [];
    for (const x of matches) {
      if (validContainer(x)) return repairContainer(x);
    }
  }

  return '';
}

function getCandidates(texts, side, fieldKey) {
  const out = [];
  const push = (value, source, score) => {
    if (!value) return;
    const v = fieldKey === 'containerNumber' ? repairContainer(value) : cleanCode(value);

    const valid = fieldKey === 'containerNumber'
      ? validContainer(v)
      : validGeneric(v, fieldKey);

    if (!valid) return;

    out.push({ value:v, source, score });
  };

  for (const obj of texts) {
    const exact = extractFieldFromText(obj.text, side, fieldKey);
    if (exact) push(exact, `${obj.source}:mapped`, 100);

    // Code-only OCR can help if normal OCR sees the label but mangles the value.
    // Keep these candidates low priority.
    if (obj.kind === 'codes') {
      for (const t of codeTokens(obj.text)) {
        push(t, `${obj.source}:codes`, 20);
      }
    }
  }

  const best = new Map();
  for (const x of out) {
    const k = normalize(x.value);
    const prev = best.get(k);
    if (!prev || x.score > prev.score) best.set(k,x);
  }
  return [...best.values()].sort((a,b)=>b.score-a.score);
}

function chooseFields(texts, side) {
  const fields = emptyFields();
  const candidates = {};

  for (const {key} of FIELD_CONFIG) {
    candidates[key] = getCandidates(texts, side, key);
    fields[key] = candidates[key][0]?.value || '';
  }

  // Never allow one detected code to populate two different logical fields.
  const used = new Set();
  for (const {key} of FIELD_CONFIG) {
    const current = normalize(fields[key]);
    if (!current) continue;
    if (!used.has(current)) {
      used.add(current);
      continue;
    }
    const alt = candidates[key].find(x => !used.has(normalize(x.value)));
    fields[key] = alt?.value || '';
    if (fields[key]) used.add(normalize(fields[key]));
  }

  return { fields, candidates };
}

function compare(a,b) {
  const na=normalize(a), nb=normalize(b);
  return { missing:!na||!nb, match:!!(na&&nb&&na===nb) };
}

function diffHint(a,b) {
  const na=normalize(a), nb=normalize(b);
  if (!na || !nb || na===nb) return '';
  const p=[];
  const max=Math.max(na.length,nb.length);
  for(let i=0;i<max;i++) if((na[i]||'∅')!==(nb[i]||'∅')) p.push(i+1);
  return `ต่างกันที่ตำแหน่ง: ${p.slice(0,15).join(', ')}${p.length>15?'…':''}`;
}

function isPdf(file) {
  return file.type==='application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

async function renderPdfPage(pdf,pageNumber,scale=2.8) {
  const page=await pdf.getPage(pageNumber);
  const viewport=page.getViewport({scale});
  const c=document.createElement('canvas');
  const ctx=c.getContext('2d',{willReadFrequently:true});
  c.width=Math.ceil(viewport.width);
  c.height=Math.ceil(viewport.height);
  await page.render({canvasContext:ctx,viewport}).promise;
  return c;
}

async function nativePdfText(file) {
  if (!isPdf(file)) return '';
  const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
  const pages=[];

  for(let p=1;p<=Math.min(pdf.numPages,10);p++){
    const page=await pdf.getPage(p);
    const content=await page.getTextContent();

    // Preserve item boundaries as separate lines. This improves label/value mapping.
    pages.push(content.items
      .map(x => ('str' in x ? x.str : ''))
      .filter(Boolean)
      .join('\n'));
  }
  return pages.join('\n');
}

async function imageToCanvas(file) {
  const bmp=await createImageBitmap(file);
  const maxSide=3400;
  const sc=Math.min(4.2,Math.max(1.8,maxSide/Math.max(bmp.width,bmp.height)));
  const c=document.createElement('canvas');
  c.width=Math.round(bmp.width*sc);
  c.height=Math.round(bmp.height*sc);
  c.getContext('2d',{willReadFrequently:true}).drawImage(bmp,0,0,c.width,c.height);
  bmp.close();
  return c;
}

async function fileCanvases(file) {
  if (file.type.startsWith('image/')) return [await imageToCanvas(file)];
  if (isPdf(file)) {
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    const arr=[];
    for(let p=1;p<=Math.min(pdf.numPages,10);p++) {
      arr.push(await renderPdfPage(pdf,p,3.2));
    }
    return arr;
  }
  throw new Error('รองรับเฉพาะ PDF, JPG, JPEG, PNG และ WEBP');
}

function preprocess(src,mode) {
  const c=document.createElement('canvas');
  c.width=src.width;c.height=src.height;
  const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(src,0,0);

  if (mode==='original') return c;

  const im=ctx.getImageData(0,0,c.width,c.height);
  const d=im.data;

  for(let i=0;i<d.length;i+=4){
    const g=Math.round(d[i]*.299+d[i+1]*.587+d[i+2]*.114);
    let v=g;
    if(mode==='contrast') v=Math.max(0,Math.min(255,(g-128)*2.0+128));
    if(mode==='threshold') v=g<195?0:255;
    d[i]=d[i+1]=d[i+2]=v;
  }

  ctx.putImageData(im,0,0);
  return c;
}

async function recognize(worker,canvas,psm,whitelist='') {
  const params={
    tessedit_pageseg_mode:String(psm),
    preserve_interword_spaces:'1',
    user_defined_dpi:'300'
  };
  params.tessedit_char_whitelist = whitelist || '';
  await worker.setParameters(params);
  const result=await worker.recognize(canvas);
  return result.data.text || '';
}

function setProgress(p,t) {
  document.querySelector('#progressWrap').classList.remove('hidden');
  document.querySelector('#progressBar').style.width=`${Math.max(0,Math.min(100,p))}%`;
  document.querySelector('#progressPercent').textContent=`${Math.round(p)}%`;
  document.querySelector('#progressText').textContent=t;
}

function showError(m) {
  const b=document.querySelector('#errorBox');
  b.textContent=m;
  b.classList.remove('hidden');
}
function clearError(){document.querySelector('#errorBox').classList.add('hidden');}

async function readHybrid(file,fileNo,start,end) {
  const outputs=[];
  const native=await nativePdfText(file).catch(()=> '');
  if(native.trim()) outputs.push({source:'PDF text',kind:'normal',text:native});

  const canvases=await fileCanvases(file);
  const worker=await Tesseract.createWorker('eng+tha',1,{
    logger:m=>{
      if(m.status==='recognizing text'){
        const q=m.progress||0;
        setProgress(start+(end-start)*Math.min(.9,q),
          `กำลังอ่านข้อมูล ${fileNo}: ${Math.round(q*100)}%`);
      }
    }
  });

  try{
    for(let i=0;i<canvases.length;i++){
      const page=canvases[i];
      const passes=[
        ['original',6,'ต้นฉบับ'],
        ['contrast',6,'เพิ่มความคม'],
        ['contrast',11,'ข้อความกระจาย'],
        ['threshold',11,'ขาวดำ']
      ];

      for(let j=0;j<passes.length;j++){
        const [mode,psm,name]=passes[j];
        const text=await recognize(worker,preprocess(page,mode),psm,'');
        outputs.push({source:`p${i+1}-${name}`,kind:'normal',text});
      }

      for(const [mode,name] of [['contrast','code'],['threshold','code-bw']]){
        const text=await recognize(
          worker,
          preprocess(page,mode),
          11,
          'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/'
        );
        outputs.push({source:`p${i+1}-${name}`,kind:'codes',text});
      }
    }
  } finally {
    await worker.terminate();
  }

  return outputs;
}

function escapeHtml(v) {
  return String(v||'')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function candidateHtml(side,key) {
  const arr=(state.candidates[side]?.[key]||[]).slice(0,3);
  if (!arr.length) return '';
  return `<div style="margin-top:6px;font-size:11px;color:#667085">
    พบจาก OCR:
    ${arr.map(x=>`<button type="button"
      data-side="${side}" data-key="${key}"
      data-candidate="${escapeHtml(x.value)}"
      style="border:0;background:#eef4ff;color:#175cd3;border-radius:8px;padding:3px 6px;margin:2px;cursor:pointer">
      ${escapeHtml(x.value)}
    </button>`).join('')}
  </div>`;
}

function renderResults() {
  const body=document.querySelector('#resultBody');
  body.innerHTML='';

  for(const cfg of FIELD_CONFIG){
    const result=compare(state.fields[0][cfg.key],state.fields[1][cfg.key]);
    const cls=result.missing?'missing':result.match?'match':'mismatch';
    const txt=result.missing?'ไม่พบข้อมูล':result.match?'ตรงกัน':'ไม่ตรงกัน';
    const hint=diffHint(state.fields[0][cfg.key],state.fields[1][cfg.key]);

    const row=document.createElement('tr');
    row.innerHTML=`
      <td>${cfg.label}</td>
      <td>
        <input data-side="0" data-key="${cfg.key}"
          value="${escapeHtml(state.fields[0][cfg.key])}">
        ${candidateHtml(0,cfg.key)}
      </td>
      <td>
        <input data-side="1" data-key="${cfg.key}"
          value="${escapeHtml(state.fields[1][cfg.key])}">
        ${candidateHtml(1,cfg.key)}
      </td>
      <td>
        <span class="status ${cls}">${txt}</span>
        ${hint?`<div class="char-diff">${hint}</div>`:''}
      </td>`;
    body.append(row);
  }

  body.querySelectorAll('input').forEach(input=>{
    input.addEventListener('input',()=>{
      state.fields[Number(input.dataset.side)][input.dataset.key]=input.value;
      renderResults();
    });
  });

  body.querySelectorAll('button[data-candidate]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const side=Number(btn.dataset.side);
      const key=btn.dataset.key;
      state.fields[side][key]=btn.dataset.candidate;
      renderResults();
    });
  });

  const passed=FIELD_CONFIG.every(({key}) =>
    compare(state.fields[0][key],state.fields[1][key]).match
  );

  const overall=document.querySelector('#overallStatus');
  overall.textContent=passed?'ผ่านการตรวจสอบ':'ไม่ผ่านการตรวจสอบ';
  overall.className=`overall ${passed?'pass':'fail'}`;
}

async function renderPreview(index,file) {
  const p=document.querySelector(`#preview${index+1}`);
  p.innerHTML='';

  if(!file){
    p.innerHTML='<span>ตัวอย่างเอกสารจะแสดงที่นี่</span>';
    return;
  }

  if(isPdf(file)){
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    p.append(await renderPdfPage(pdf,1,1.2));
  } else if(file.type.startsWith('image/')){
    const img=new Image();
    img.src=URL.createObjectURL(file);
    img.alt=file.name;
    p.append(img);
  }
}

async function setFile(index,file){
  state.files[index]=file;
  state.texts[index]=[];
  state.fields[index]=emptyFields();
  state.candidates[index]={};

  document.querySelector(`#fileName${index+1}`).textContent =
    file?.name || 'ยังไม่ได้เลือกไฟล์';

  document.querySelector('#resultSection').classList.add('hidden');
  await renderPreview(index,file);
}

function attachUpload(index){
  const input=document.querySelector(`#file${index+1}`);
  const drop=document.querySelector(`#drop${index+1}`);

  input.addEventListener('change',()=>{
    setFile(index,input.files?.[0]||null);
  });

  ['dragenter','dragover'].forEach(n =>
    drop.addEventListener(n,e=>{
      e.preventDefault();
      drop.classList.add('drag');
    })
  );

  ['dragleave','drop'].forEach(n =>
    drop.addEventListener(n,e=>{
      e.preventDefault();
      drop.classList.remove('drag');
    })
  );

  drop.addEventListener('drop',e=>{
    const f=e.dataTransfer?.files?.[0];
    if(f) setFile(index,f);
  });
}

async function checkDocuments(){
  clearError();

  if(!state.files[0] || !state.files[1]){
    showError('กรุณาเลือกไฟล์ทั้ง 2 ฝั่ง');
    return;
  }

  const btn=document.querySelector('#checkButton');
  btn.disabled=true;

  try{
    setProgress(2,'กำลังอ่านข้อมูล 1 (ใบ EAR)...');
    state.texts[0]=await readHybrid(state.files[0],1,3,48);

    setProgress(50,'กำลังอ่านข้อมูล 2 (แบบฟอร์มควบคุมรถ)...');
    state.texts[1]=await readHybrid(state.files[1],2,52,97);

    for(let side=0;side<2;side++){
      const picked=chooseFields(state.texts[side],side);
      state.fields[side]=picked.fields;
      state.candidates[side]=picked.candidates;
    }

    document.querySelector('#rawText1').textContent =
      state.texts[0].map(x=>`--- ${x.source} ---\n${x.text}`).join('\n\n');

    document.querySelector('#rawText2').textContent =
      state.texts[1].map(x=>`--- ${x.source} ---\n${x.text}`).join('\n\n');

    document.querySelector('#reportFile1').textContent=state.files[0].name;
    document.querySelector('#reportFile2').textContent=state.files[1].name;
    document.querySelector('#reportDate').textContent =
      new Date().toLocaleString('th-TH');

    renderResults();
    document.querySelector('#resultSection').classList.remove('hidden');
    setProgress(100,'อ่านและเปรียบเทียบเสร็จแล้ว');
    document.querySelector('#resultSection').scrollIntoView({behavior:'smooth'});
  } catch(e) {
    console.error(e);
    showError(`ไม่สามารถประมวลผลได้: ${e?.message || e}`);
  } finally {
    btn.disabled=false;
  }
}

function resetAll(){
  state.files=[null,null];
  state.texts=[[],[]];
  state.fields=[emptyFields(),emptyFields()];
  state.candidates=[{},{}];

  [1,2].forEach(n=>{
    document.querySelector(`#file${n}`).value='';
    document.querySelector(`#fileName${n}`).textContent='ยังไม่ได้เลือกไฟล์';
    document.querySelector(`#preview${n}`).innerHTML='<span>ตัวอย่างเอกสารจะแสดงที่นี่</span>';
  });

  document.querySelector('#resultSection').classList.add('hidden');
  document.querySelector('#progressWrap').classList.add('hidden');
  clearError();
}

attachUpload(0);
attachUpload(1);
document.querySelector('#checkButton').addEventListener('click',checkDocuments);
document.querySelector('#resetButton').addEventListener('click',resetAll);
document.querySelector('#printButton').addEventListener('click',()=>window.print());
