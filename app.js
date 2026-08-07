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

const THAI_DIGITS = {
  '๐': '0','๑': '1','๒': '2','๓': '3','๔': '4',
  '๕': '5','๖': '6','๗': '7','๘': '8','๙': '9'
};

function emptyFields() {
  return { containerNumber: '', sealNo: '', booking: '' };
}

function thaiToArabic(v) {
  return String(v || '').replace(/[๐-๙]/g, d => THAI_DIGITS[d] || d);
}

function normalize(v) {
  return thaiToArabic(v)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[-_/.:,;|()[\]{}‐‑‒–—]/g, '');
}

function cleanCode(v) {
  return thaiToArabic(v)
    .toUpperCase()
    .replace(/[“”"'`]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function labelFix(v) {
  return thaiToArabic(v)
    .toUpperCase()
    .replace(/C[0O]NTA[I1L]NER/g, 'CONTAINER')
    .replace(/B[0O][0O]K[I1L]NG/g, 'BOOKING')
    .replace(/SEA[I1L]/g, 'SEAL')
    .replace(/N[0O]\.?/g, 'NO');
}

function repairContainer(v) {
  const c = cleanCode(v);
  if (c.length < 11) return c;
  const s = c.slice(0, 11);
  const p = s.slice(0, 4)
    .replace(/0/g,'O')
    .replace(/1/g,'I')
    .replace(/5/g,'S')
    .replace(/8/g,'B');
  const n = s.slice(4)
    .replace(/O/g,'0')
    .replace(/[IL]/g,'1')
    .replace(/Z/g,'2')
    .replace(/S/g,'5')
    .replace(/B/g,'8')
    .replace(/G/g,'6');
  return p + n;
}

function levenshtein(a, b) {
  a = normalize(a); b = normalize(b);
  const m = Array.from({length: a.length + 1}, () => Array(b.length + 1).fill(0));
  for (let i=0;i<=a.length;i++) m[i][0]=i;
  for (let j=0;j<=b.length;j++) m[0][j]=j;
  for (let i=1;i<=a.length;i++) {
    for (let j=1;j<=b.length;j++) {
      m[i][j] = Math.min(
        m[i-1][j] + 1,
        m[i][j-1] + 1,
        m[i-1][j-1] + (a[i-1]===b[j-1] ? 0 : 1)
      );
    }
  }
  return m[a.length][b.length];
}

function codeTokens(text) {
  const src = thaiToArabic(String(text || '')).toUpperCase();
  return src.match(/[A-Z0-9][A-Z0-9\-_/]{4,23}/g) || [];
}

function contextWindows(text, regex, radius=90) {
  const src = labelFix(String(text || ''));
  const out = [];
  let m;
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const rx = new RegExp(regex.source, flags);
  while ((m = rx.exec(src))) {
    out.push(src.slice(Math.max(0, m.index-radius), Math.min(src.length, m.index+m[0].length+radius)));
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return out;
}

const LABEL_RX = {
  containerNumber: /(CONTAINER\s*(?:NUMBER|NO|#)?|หมายเลข\s*ตู้|เลข\s*ตู้|ตู้\s*คอนเทนเนอร์|หมายเลข\s*คอนเทนเนอร์)/gi,
  sealNo: /(SEAL\s*(?:NUMBER|NO|#)?|หมายเลข\s*ซีล|เลข\s*ซีล|ซีล)/gi,
  booking: /(BOOKING\s*(?:NUMBER|NO|#)?|หมายเลข\s*บุ๊กกิ้ง|เลข\s*บุ๊กกิ้ง|บุ๊กกิ้ง|หมายเลข\s*จอง|เลขที่\s*จอง|เลข\s*จอง)/gi
};

function penaltyForNoise(v) {
  let p = 0;
  const s = cleanCode(v);
  if (/^\d{6,}$/.test(s)) p += 20;
  if (/^(19|20)\d{6,}$/.test(s)) p += 20;
  if (/^\d{8,10}$/.test(s)) p += 15;
  if (/^(RO|PI|INV|ORDER)/.test(s)) p += 8;
  return p;
}

function collectCandidates(allTexts, fieldKey) {
  const list = [];
  const push = (raw, score, source) => {
    let value = fieldKey === 'containerNumber' ? repairContainer(raw) : cleanCode(raw);
    if (!value) return;

    if (fieldKey === 'containerNumber') {
      if (!/^[A-Z]{4}\d{7}$/.test(value)) return;
      score += 100;
      if (/^[A-Z]{3}U\d{7}$/.test(value)) score += 10;
    } else {
      if (value.length < 5 || value.length > 20 || !/\d/.test(value)) return;
      if (!/[A-Z]/.test(value)) score -= 15;
      score -= penaltyForNoise(value);
      if (fieldKey === 'booking' && value.length >= 10) score += 8;
      if (fieldKey === 'sealNo' && value.length >= 7 && value.length <= 12) score += 8;
    }
    list.push({ value, score, source });
  };

  for (const obj of allTexts) {
    const text = obj.text || '';

    // Strongest: exact label neighborhood.
    const windows = contextWindows(text, LABEL_RX[fieldKey], 110);
    for (const w of windows) {
      for (const t of codeTokens(w)) push(t, 80, `${obj.source}:label`);
    }

    // Container can safely use global ISO-style fallback.
    if (fieldKey === 'containerNumber') {
      const src = thaiToArabic(text).toUpperCase();
      const matches = src.match(/\b[A-Z0-9]{4}[\s\-]?[A-Z0-9]{7}\b/g) || [];
      for (const m of matches) push(m, 35, `${obj.source}:global`);
    }

    // Code-only OCR pass: weaker candidate source for seal/booking.
    if (obj.kind === 'codes' && fieldKey !== 'containerNumber') {
      for (const t of codeTokens(text)) push(t, 18, `${obj.source}:codes`);
    }
  }

  // deduplicate, keep best score
  const best = new Map();
  for (const item of list) {
    const k = normalize(item.value);
    const old = best.get(k);
    if (!old || item.score > old.score) best.set(k, item);
  }
  return [...best.values()].sort((a,b) => b.score - a.score || b.value.length - a.value.length);
}

function chooseInitialFields(texts) {
  const candidates = {};
  for (const {key} of FIELD_CONFIG) {
    candidates[key] = collectCandidates(texts, key);
  }

  const fields = emptyFields();
  fields.containerNumber = candidates.containerNumber[0]?.value || '';

  // For seal/booking we prefer label-anchored candidate; otherwise leave blank
  // rather than confidently selecting Order/Invoice/phone.
  for (const key of ['sealNo','booking']) {
    const anchored = candidates[key].find(x => x.source.includes(':label'));
    fields[key] = anchored?.value || candidates[key][0]?.value || '';
  }

  // Prevent the same code being assigned to multiple fields.
  if (normalize(fields.sealNo) === normalize(fields.booking)) {
    const alt = candidates.booking.find(x => normalize(x.value) !== normalize(fields.sealNo));
    if (alt) fields.booking = alt.value;
  }

  return { fields, candidates };
}

function compare(a,b) {
  const na = normalize(a), nb = normalize(b);
  return { missing: !na || !nb, match: !!(na && nb && na === nb), na, nb };
}

function diffHint(a,b) {
  const na=normalize(a), nb=normalize(b);
  if (!na || !nb || na===nb) return '';
  const pos=[];
  const max=Math.max(na.length,nb.length);
  for(let i=0;i<max;i++) if((na[i]||'∅')!==(nb[i]||'∅')) pos.push(i+1);
  const d=levenshtein(na,nb);
  return `ต่างกัน ${d} ตัวอักษร — ตำแหน่ง ${pos.slice(0,12).join(', ')}${pos.length>12?'…':''}`;
}

function isPdf(file) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

async function renderPdfPage(pdf,pageNumber,scale=2.8) {
  const page=await pdf.getPage(pageNumber);
  const viewport=page.getViewport({scale});
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  canvas.width=Math.ceil(viewport.width);
  canvas.height=Math.ceil(viewport.height);
  await page.render({canvasContext:ctx,viewport}).promise;
  return canvas;
}

async function nativePdfText(file) {
  if(!isPdf(file)) return '';
  const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
  const pages=[];
  for(let p=1;p<=Math.min(pdf.numPages,10);p++){
    const page=await pdf.getPage(p);
    const c=await page.getTextContent();
    pages.push(c.items.map(x=>'str' in x?x.str:'').join(' '));
  }
  return pages.join('\n');
}

async function imageToCanvas(file) {
  const bmp=await createImageBitmap(file);
  const maxSide=3200;
  const sc=Math.min(4,Math.max(1.5,maxSide/Math.max(bmp.width,bmp.height)));
  const c=document.createElement('canvas');
  c.width=Math.round(bmp.width*sc); c.height=Math.round(bmp.height*sc);
  c.getContext('2d',{willReadFrequently:true}).drawImage(bmp,0,0,c.width,c.height);
  bmp.close(); return c;
}

async function fileCanvases(file) {
  if(file.type.startsWith('image/')) return [await imageToCanvas(file)];
  if(isPdf(file)) {
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    const arr=[];
    for(let p=1;p<=Math.min(pdf.numPages,10);p++) arr.push(await renderPdfPage(pdf,p,3.1));
    return arr;
  }
  throw new Error('รองรับเฉพาะ PDF, JPG, JPEG, PNG และ WEBP');
}

function preprocess(src,mode) {
  const c=document.createElement('canvas');
  c.width=src.width;c.height=src.height;
  const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(src,0,0);
  if(mode==='original') return c;

  const im=ctx.getImageData(0,0,c.width,c.height),d=im.data;
  for(let i=0;i<d.length;i+=4){
    const g=Math.round(d[i]*.299+d[i+1]*.587+d[i+2]*.114);
    let v=g;
    if(mode==='contrast') v=Math.max(0,Math.min(255,(g-128)*1.9+128));
    if(mode==='threshold') v=g<195?0:255;
    d[i]=d[i+1]=d[i+2]=v;
  }
  ctx.putImageData(im,0,0);return c;
}

async function recognize(worker,canvas,psm,whitelist='') {
  const params={
    tessedit_pageseg_mode:String(psm),
    preserve_interword_spaces:'1',
    user_defined_dpi:'300'
  };
  if(whitelist) params.tessedit_char_whitelist=whitelist;
  else params.tessedit_char_whitelist='';
  await worker.setParameters(params);
  const r=await worker.recognize(canvas);
  return r.data.text||'';
}

function setProgress(p,t) {
  document.querySelector('#progressWrap').classList.remove('hidden');
  document.querySelector('#progressBar').style.width=`${Math.max(0,Math.min(100,p))}%`;
  document.querySelector('#progressPercent').textContent=`${Math.round(p)}%`;
  document.querySelector('#progressText').textContent=t;
}
function showError(m){const b=document.querySelector('#errorBox');b.textContent=m;b.classList.remove('hidden');}
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
      const normalPasses=[
        ['original',6,'ต้นฉบับ'],
        ['contrast',6,'เพิ่มความคม'],
        ['contrast',11,'ค้นหาข้อความกระจาย'],
        ['threshold',11,'ขาวดำ']
      ];
      for(let j=0;j<normalPasses.length;j++){
        const [mode,psm,name]=normalPasses[j];
        setProgress(start+(end-start)*((i*6+j+1)/(canvases.length*6)),
          `ข้อมูล ${fileNo} หน้า ${i+1}: ${name}`);
        const text=await recognize(worker,preprocess(page,mode),psm,'');
        outputs.push({source:`p${i+1}-${name}`,kind:'normal',text});
      }

      // Dedicated code OCR: English A-Z + digits only.
      for(const [mode,name] of [['contrast','รหัสตัวอักษร'],['threshold','รหัสขาวดำ']]){
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

function escapeHtml(v){
  return String(v||'').replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

function renderResults() {
  const body=document.querySelector('#resultBody'); body.innerHTML='';
  for(const cfg of FIELD_CONFIG){
    const result=compare(state.fields[0][cfg.key],state.fields[1][cfg.key]);
    const cls=result.missing?'missing':result.match?'match':'mismatch';
    const txt=result.missing?'ไม่พบข้อมูล':result.match?'ตรงกัน':'ไม่ตรงกัน';
    const hint=diffHint(state.fields[0][cfg.key],state.fields[1][cfg.key]);

    const r=document.createElement('tr');
    r.innerHTML=`
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
    body.append(r);
  }

  body.querySelectorAll('input').forEach(input=>{
    input.addEventListener('input',()=>{
      state.fields[Number(input.dataset.side)][input.dataset.key]=input.value;
      renderResults();
    });
  });
  body.querySelectorAll('button[data-candidate]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const side=Number(btn.dataset.side),key=btn.dataset.key;
      state.fields[side][key]=btn.dataset.candidate;
      renderResults();
    });
  });

  const ok=FIELD_CONFIG.every(({key})=>compare(state.fields[0][key],state.fields[1][key]).match);
  const overall=document.querySelector('#overallStatus');
  overall.textContent=ok?'ผ่านการตรวจสอบ':'ไม่ผ่านการตรวจสอบ';
  overall.className=`overall ${ok?'pass':'fail'}`;
}

function candidateHtml(side,key){
  const arr=(state.candidates[side]?.[key]||[]).slice(0,3);
  if(!arr.length) return '';
  return `<div style="margin-top:6px;font-size:11px;color:#667085">
    OCR candidates:
    ${arr.map(x=>`<button type="button" data-side="${side}" data-key="${key}"
      data-candidate="${escapeHtml(x.value)}"
      style="border:0;background:#eef4ff;color:#175cd3;border-radius:8px;padding:3px 6px;margin:2px;cursor:pointer">
      ${escapeHtml(x.value)}
    </button>`).join('')}
  </div>`;
}

async function renderPreview(index,file){
  const p=document.querySelector(`#preview${index+1}`);p.innerHTML='';
  if(!file){p.innerHTML='<span>ตัวอย่างเอกสารจะแสดงที่นี่</span>';return;}
  if(isPdf(file)){
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    p.append(await renderPdfPage(pdf,1,1.2));
  } else if(file.type.startsWith('image/')){
    const img=new Image();img.src=URL.createObjectURL(file);img.alt=file.name;p.append(img);
  }
}

async function setFile(index,file){
  state.files[index]=file;
  state.texts[index]=[];
  state.fields[index]=emptyFields();
  state.candidates[index]={};
  document.querySelector(`#fileName${index+1}`).textContent=file?.name||'ยังไม่ได้เลือกไฟล์';
  document.querySelector('#resultSection').classList.add('hidden');
  await renderPreview(index,file);
}

function attachUpload(index){
  const input=document.querySelector(`#file${index+1}`);
  const drop=document.querySelector(`#drop${index+1}`);
  input.addEventListener('change',()=>setFile(index,input.files?.[0]||null));
  ['dragenter','dragover'].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.add('drag')}));
  ['dragleave','drop'].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.remove('drag')}));
  drop.addEventListener('drop',e=>{const f=e.dataTransfer?.files?.[0];if(f)setFile(index,f)});
}

async function checkDocuments(){
  clearError();
  if(!state.files[0]||!state.files[1]){showError('กรุณาเลือกไฟล์ทั้ง 2 ฝั่ง');return;}
  const btn=document.querySelector('#checkButton');btn.disabled=true;
  try{
    setProgress(2,'กำลังอ่านข้อมูล 1...');
    state.texts[0]=await readHybrid(state.files[0],1,3,48);
    setProgress(50,'กำลังอ่านข้อมูล 2...');
    state.texts[1]=await readHybrid(state.files[1],2,52,97);

    for(let side=0;side<2;side++){
      const picked=chooseInitialFields(state.texts[side]);
      state.fields[side]=picked.fields;
      state.candidates[side]=picked.candidates;
    }

    document.querySelector('#rawText1').textContent =
      state.texts[0].map(x=>`--- ${x.source} ---\n${x.text}`).join('\n\n');
    document.querySelector('#rawText2').textContent =
      state.texts[1].map(x=>`--- ${x.source} ---\n${x.text}`).join('\n\n');

    document.querySelector('#reportFile1').textContent=state.files[0].name;
    document.querySelector('#reportFile2').textContent=state.files[1].name;
    document.querySelector('#reportDate').textContent=new Date().toLocaleString('th-TH');

    renderResults();
    document.querySelector('#resultSection').classList.remove('hidden');
    setProgress(100,'อ่านและเปรียบเทียบเสร็จแล้ว');
    document.querySelector('#resultSection').scrollIntoView({behavior:'smooth'});
  }catch(e){
    console.error(e);showError(`ไม่สามารถประมวลผลได้: ${e?.message||e}`);
  }finally{btn.disabled=false;}
}

function resetAll(){
  state.files=[null,null];state.texts=[[],[]];state.fields=[emptyFields(),emptyFields()];
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

attachUpload(0);attachUpload(1);
document.querySelector('#checkButton').addEventListener('click',checkDocuments);
document.querySelector('#resetButton').addEventListener('click',resetAll);
document.querySelector('#printButton').addEventListener('click',()=>window.print());
