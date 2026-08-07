const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

const state = {
  files: [null, null],
  fields: [emptyFields(), emptyFields()],
  debug: [[], []],
};

const FIELD_CONFIG = [
  { key: 'containerNumber', label: 'CONTAINER NUMBER' },
  { key: 'sealNo', label: 'SEAL NO' },
  { key: 'booking', label: 'BOOKING' },
];

// File 1 = EAR, File 2 = Vehicle Control Form.
// Labels are intentionally different between the two files.
const LABEL_ALIASES = [
  {
    containerNumber: ['CONTAINER NUMBER', 'CONTAINER NO', 'หมายเลขตู้', 'เลขตู้'],
    sealNo: ['SEAL NO', 'SEAL NUMBER', 'หมายเลขซีล', 'เลขซีล'],
    booking: ['BOOKING', 'BOOKING NO', 'BOOKING NUMBER', 'หมายเลขจอง', 'เลขบุ๊กกิ้ง']
  },
  {
    containerNumber: ['CONTAINER NO', 'CONTAINER NUMBER', 'หมายเลขตู้', 'เลขตู้'],
    sealNo: ['SEAL', 'SEAL NO', 'SEAL NUMBER', 'หมายเลขซีล', 'เลขซีล'],
    booking: ['BOOKING NO', 'BOOKING NUMBER', 'BOOKING', 'หมายเลขจอง', 'เลขบุ๊กกิ้ง']
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

function fixLabel(v) {
  return thaiToArabic(v)
    .toUpperCase()
    .replace(/C[0O]NTA[I1L]NER/g,'CONTAINER')
    .replace(/B[0O][0O]K[I1L]NG/g,'BOOKING')
    .replace(/SEA[I1L]/g,'SEAL')
    .replace(/\bN[0O]\b/g,'NO')
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

function isValidValue(fieldKey, raw) {
  const v = fieldKey === 'containerNumber'
    ? repairContainer(raw)
    : cleanCode(raw);

  if (fieldKey === 'containerNumber') {
    return /^[A-Z]{4}\d{7}$/.test(v);
  }

  if (!/[A-Z]/.test(v) || !/\d/.test(v)) return false;

  if (fieldKey === 'sealNo') {
    return v.length >= 7 && v.length <= 14;
  }

  if (fieldKey === 'booking') {
    return v.length >= 8 && v.length <= 16;
  }

  return false;
}

function valueFor(fieldKey, raw) {
  return fieldKey === 'containerNumber'
    ? repairContainer(raw)
    : cleanCode(raw);
}

function levenshtein(a, b) {
  a = fixLabel(a); b = fixLabel(b);
  const m = Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++) m[i][0]=i;
  for(let j=0;j<=b.length;j++) m[0][j]=j;
  for(let i=1;i<=a.length;i++){
    for(let j=1;j<=b.length;j++){
      m[i][j]=Math.min(
        m[i-1][j]+1,
        m[i][j-1]+1,
        m[i-1][j-1]+(a[i-1]===b[j-1]?0:1)
      );
    }
  }
  return m[a.length][b.length];
}

function similarity(a,b) {
  a=fixLabel(a); b=fixLabel(b);
  if(!a || !b) return 0;
  return 1 - levenshtein(a,b)/Math.max(a.length,b.length);
}

function wordBox(word) {
  const b = word.bbox || {};
  const x0 = b.x0 ?? 0, y0 = b.y0 ?? 0, x1 = b.x1 ?? 0, y1 = b.y1 ?? 0;
  return {
    x0,y0,x1,y1,
    cx:(x0+x1)/2,
    cy:(y0+y1)/2,
    w:Math.max(1,x1-x0),
    h:Math.max(1,y1-y0)
  };
}

function usableWords(words) {
  return (words || [])
    .filter(w => w && String(w.text || '').trim())
    .map(w => ({
      text:String(w.text || '').trim(),
      conf:Number(w.confidence ?? w.conf ?? 0),
      ...wordBox(w)
    }))
    .filter(w => w.conf >= 18);
}

function groupLines(words) {
  const sorted=[...words].sort((a,b)=>a.cy-b.cy || a.x0-b.x0);
  const lines=[];

  for(const word of sorted){
    let best=null, bestDist=Infinity;

    for(const line of lines){
      const tol=Math.max(12, Math.max(line.avgH,word.h)*0.7);
      const d=Math.abs(line.cy-word.cy);
      if(d<=tol && d<bestDist){
        best=line;bestDist=d;
      }
    }

    if(!best){
      lines.push({
        words:[word],
        cy:word.cy,
        avgH:word.h
      });
    }else{
      best.words.push(word);
      best.cy=best.words.reduce((s,x)=>s+x.cy,0)/best.words.length;
      best.avgH=best.words.reduce((s,x)=>s+x.h,0)/best.words.length;
    }
  }

  for(const line of lines){
    line.words.sort((a,b)=>a.x0-b.x0);
    line.text=line.words.map(w=>w.text).join(' ');
  }

  return lines.sort((a,b)=>a.cy-b.cy);
}

function findLabelSpan(line, aliases) {
  const words=line.words;

  // Test 1-3 consecutive OCR words. This handles "BOOKING NO", "SEAL NO",
  // "CONTAINER NUMBER" while preserving their true bounding box.
  let best=null;

  for(let start=0;start<words.length;start++){
    for(let count=1;count<=3 && start+count<=words.length;count++){
      const seq=words.slice(start,start+count);
      const text=seq.map(w=>w.text).join(' ');

      for(const alias of aliases){
        const sim=similarity(text,alias);
        const threshold = alias.length <= 5 ? 0.72 : 0.66;

        if(sim >= threshold && (!best || sim>best.sim)){
          best={
            sim,
            start,
            count,
            x0:seq[0].x0,
            x1:seq[seq.length-1].x1,
            cy:seq.reduce((s,w)=>s+w.cy,0)/seq.length,
            h:seq.reduce((s,w)=>s+w.h,0)/seq.length,
            text
          };
        }
      }
    }
  }

  return best;
}

function codeFromWords(words, fieldKey) {
  // Try individual words first, then two adjacent words (useful for TCKU- 4852578).
  const attempts=[];

  for(let i=0;i<words.length;i++){
    attempts.push(words[i].text);
    if(i+1<words.length){
      attempts.push(words[i].text + words[i+1].text);
    }
  }

  for(const raw of attempts){
    if(isValidValue(fieldKey,raw)) return valueFor(fieldKey,raw);
  }

  return '';
}

function spatialExtract(words, side, fieldKey) {
  const lines=groupLines(usableWords(words));
  const aliases=LABEL_ALIASES[side][fieldKey];
  const hits=[];

  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const label=findLabelSpan(line,aliases);
    if(!label) continue;

    // PRIMARY RULE:
    // choose only words to the RIGHT of this label on the SAME row.
    const sameRow = line.words.filter(w =>
      w.x0 >= label.x1 - 3 &&
      Math.abs(w.cy-label.cy) <= Math.max(label.h,w.h)*0.9
    );

    const sameValue=codeFromWords(sameRow,fieldKey);
    if(sameValue){
      hits.push({
        value:sameValue,
        score:200 + label.sim*50,
        why:`same-row ${label.text}`
      });
      continue;
    }

    // SECONDARY RULE:
    // Some PDFs/OCR put the value just below the label.
    // Search only a narrow region under this label, not the whole page.
    const below=[];
    for(let j=i+1;j<Math.min(lines.length,i+3);j++){
      const next=lines[j];
      const dy=next.cy-label.cy;
      if(dy<0 || dy>Math.max(70,label.h*3.0)) continue;

      for(const w of next.words){
        const horizontallyRelated =
          w.x0 >= label.x0 - label.h*1.5 &&
          w.x0 <= label.x1 + Math.max(260,label.h*12);
        if(horizontallyRelated) below.push(w);
      }
    }

    const belowValue=codeFromWords(below,fieldKey);
    if(belowValue){
      hits.push({
        value:belowValue,
        score:130 + label.sim*40,
        why:`below ${label.text}`
      });
    }
  }

  hits.sort((a,b)=>b.score-a.score);
  return hits;
}

function compare(a,b) {
  const na=normalize(a), nb=normalize(b);
  return {
    missing:!na || !nb,
    match:!!(na && nb && na===nb)
  };
}

function diffHint(a,b) {
  const na=normalize(a), nb=normalize(b);
  if(!na || !nb || na===nb) return '';
  const positions=[];
  for(let i=0;i<Math.max(na.length,nb.length);i++){
    if((na[i]||'∅')!==(nb[i]||'∅')) positions.push(i+1);
  }
  return `ไม่ตรงกันที่ตำแหน่ง: ${positions.slice(0,12).join(', ')}${positions.length>12?'…':''}`;
}

function isPdf(file) {
  return file.type==='application/pdf' || file.name.toLowerCase().endsWith('.pdf');
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

async function imageToCanvas(file) {
  const bmp=await createImageBitmap(file);
  const maxSide=3600;
  const scale=Math.min(4.5,Math.max(2,maxSide/Math.max(bmp.width,bmp.height)));
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(bmp.width*scale);
  canvas.height=Math.round(bmp.height*scale);
  canvas.getContext('2d',{willReadFrequently:true})
    .drawImage(bmp,0,0,canvas.width,canvas.height);
  bmp.close();
  return canvas;
}

async function fileCanvases(file) {
  if(file.type.startsWith('image/')) return [await imageToCanvas(file)];

  if(isPdf(file)){
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    const out=[];
    for(let p=1;p<=Math.min(pdf.numPages,10);p++){
      out.push(await renderPdfPage(pdf,p,3.2));
    }
    return out;
  }

  throw new Error('รองรับเฉพาะ PDF, JPG, JPEG, PNG และ WEBP');
}

function preprocess(src,mode) {
  const c=document.createElement('canvas');
  c.width=src.width;c.height=src.height;
  const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(src,0,0);

  if(mode==='original') return c;

  const im=ctx.getImageData(0,0,c.width,c.height);
  const d=im.data;

  for(let i=0;i<d.length;i+=4){
    const gray=Math.round(d[i]*.299+d[i+1]*.587+d[i+2]*.114);
    let v=gray;

    if(mode==='contrast'){
      v=Math.max(0,Math.min(255,(gray-128)*2.1+128));
    }else if(mode==='threshold'){
      v=gray<195?0:255;
    }

    d[i]=d[i+1]=d[i+2]=v;
  }

  ctx.putImageData(im,0,0);
  return c;
}

async function runSpatialOcr(file,side,fileNo,start,end) {
  const canvases=await fileCanvases(file);
  const worker=await Tesseract.createWorker('eng+tha',1,{
    logger:m=>{
      if(m.status==='recognizing text'){
        const q=m.progress||0;
        setProgress(
          start+(end-start)*Math.min(.9,q),
          `กำลังอ่านข้อมูล ${fileNo}: ${Math.round(q*100)}%`
        );
      }
    }
  });

  const allPasses=[];

  try{
    for(let p=0;p<canvases.length;p++){
      const page=canvases[p];

      // PSM 6: blocks / form rows.
      // PSM 11: sparse text, useful for photographed forms.
      const passes=[
        ['original',6,'ต้นฉบับ'],
        ['contrast',6,'เพิ่มความคม'],
        ['contrast',11,'อ่านข้อความกระจาย'],
        ['threshold',11,'ขาวดำ']
      ];

      for(let k=0;k<passes.length;k++){
        const [mode,psm,name]=passes[k];

        setProgress(
          start+(end-start)*((p*passes.length+k+1)/(canvases.length*passes.length)),
          `ข้อมูล ${fileNo} หน้า ${p+1}: ${name}`
        );

        await worker.setParameters({
          tessedit_pageseg_mode:String(psm),
          preserve_interword_spaces:'1',
          user_defined_dpi:'300'
        });

        const result=await worker.recognize(preprocess(page,mode));

        allPasses.push({
          page:p+1,
          name,
          text:result.data.text || '',
          words:result.data.words || []
        });
      }
    }
  }finally{
    await worker.terminate();
  }

  const fields=emptyFields();
  const debug={};

  for(const {key} of FIELD_CONFIG){
    const candidates=[];

    for(const pass of allPasses){
      const hits=spatialExtract(pass.words,side,key);
      for(const hit of hits){
        candidates.push({
          ...hit,
          source:`หน้า ${pass.page} ${pass.name}`
        });
      }
    }

    // Deduplicate and keep highest-confidence spatial result.
    const bestMap=new Map();
    for(const c of candidates){
      const n=normalize(c.value);
      const old=bestMap.get(n);
      if(!old || c.score>old.score) bestMap.set(n,c);
    }

    const ranked=[...bestMap.values()].sort((a,b)=>b.score-a.score);
    fields[key]=ranked[0]?.value || '';
    debug[key]=ranked.slice(0,5);
  }

  return {fields,debug,passes:allPasses};
}

function setProgress(p,t) {
  document.querySelector('#progressWrap').classList.remove('hidden');
  document.querySelector('#progressBar').style.width =
    `${Math.max(0,Math.min(100,p))}%`;
  document.querySelector('#progressPercent').textContent=`${Math.round(p)}%`;
  document.querySelector('#progressText').textContent=t;
}

function showError(m){
  const box=document.querySelector('#errorBox');
  box.textContent=m;
  box.classList.remove('hidden');
}

function clearError(){
  document.querySelector('#errorBox').classList.add('hidden');
}

function escapeHtml(v){
  return String(v||'')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function renderResults(){
  const body=document.querySelector('#resultBody');
  body.innerHTML='';

  const mismatches=[];

  for(const cfg of FIELD_CONFIG){
    const result=compare(state.fields[0][cfg.key],state.fields[1][cfg.key]);

    let statusClass, statusText;
    if(result.missing){
      statusClass='missing';
      statusText='อ่านข้อมูลไม่ครบ';
    }else if(result.match){
      statusClass='match';
      statusText='ตรงกัน';
    }else{
      statusClass='mismatch';
      statusText='ไม่ตรงกัน';
      mismatches.push(cfg.label);
    }

    const hint=diffHint(state.fields[0][cfg.key],state.fields[1][cfg.key]);

    const row=document.createElement('tr');
    row.innerHTML=`
      <td>${cfg.label}</td>
      <td>
        <input data-side="0" data-key="${cfg.key}"
          value="${escapeHtml(state.fields[0][cfg.key])}">
      </td>
      <td>
        <input data-side="1" data-key="${cfg.key}"
          value="${escapeHtml(state.fields[1][cfg.key])}">
      </td>
      <td>
        <span class="status ${statusClass}">${statusText}</span>
        ${hint?`<div class="char-diff">${hint}</div>`:''}
      </td>
    `;
    body.append(row);
  }

  body.querySelectorAll('input').forEach(input=>{
    input.addEventListener('input',()=>{
      state.fields[Number(input.dataset.side)][input.dataset.key]=input.value;
      renderResults();
    });
  });

  const complete=FIELD_CONFIG.every(({key}) =>
    normalize(state.fields[0][key]) && normalize(state.fields[1][key])
  );
  const passed=complete && FIELD_CONFIG.every(({key}) =>
    compare(state.fields[0][key],state.fields[1][key]).match
  );

  const overall=document.querySelector('#overallStatus');

  if(passed){
    overall.textContent='ผ่านการตรวจสอบ — ทั้ง 3 หัวข้อตรงกัน';
    overall.className='overall pass';
  }else if(!complete){
    overall.textContent='ยังตรวจไม่ครบ — มีข้อมูลที่อ่านไม่พบ';
    overall.className='overall fail';
  }else{
    overall.textContent=`ไม่ผ่าน — ไม่ตรงกัน: ${mismatches.join(', ')}`;
    overall.className='overall fail';
  }
}

async function renderPreview(index,file){
  const p=document.querySelector(`#preview${index+1}`);
  p.innerHTML='';

  if(!file){
    p.innerHTML='<span>ตัวอย่างเอกสารจะแสดงที่นี่</span>';
    return;
  }

  if(isPdf(file)){
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    p.append(await renderPdfPage(pdf,1,1.2));
  }else if(file.type.startsWith('image/')){
    const img=new Image();
    img.src=URL.createObjectURL(file);
    img.alt=file.name;
    p.append(img);
  }
}

async function setFile(index,file){
  state.files[index]=file;
  state.fields[index]=emptyFields();
  state.debug[index]=[];

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
    setProgress(2,'กำลังอ่านข้อมูล 1 — ใบ EAR...');
    const r1=await runSpatialOcr(state.files[0],0,1,3,48);
    state.fields[0]=r1.fields;
    state.debug[0]=r1.debug;

    setProgress(50,'กำลังอ่านข้อมูล 2 — แบบฟอร์มควบคุมรถ...');
    const r2=await runSpatialOcr(state.files[1],1,2,52,97);
    state.fields[1]=r2.fields;
    state.debug[1]=r2.debug;

    document.querySelector('#rawText1').textContent =
      r1.passes.map(x=>`--- ${x.name} ---\n${x.text}`).join('\n\n');
    document.querySelector('#rawText2').textContent =
      r2.passes.map(x=>`--- ${x.name} ---\n${x.text}`).join('\n\n');

    document.querySelector('#reportFile1').textContent=state.files[0].name;
    document.querySelector('#reportFile2').textContent=state.files[1].name;
    document.querySelector('#reportDate').textContent =
      new Date().toLocaleString('th-TH');

    renderResults();
    document.querySelector('#resultSection').classList.remove('hidden');
    setProgress(100,'อ่านและเปรียบเทียบเสร็จแล้ว');
    document.querySelector('#resultSection').scrollIntoView({behavior:'smooth'});
  }catch(e){
    console.error(e);
    showError(`ไม่สามารถประมวลผลได้: ${e?.message || e}`);
  }finally{
    btn.disabled=false;
  }
}

function resetAll(){
  state.files=[null,null];
  state.fields=[emptyFields(),emptyFields()];
  state.debug=[[],[]];

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
