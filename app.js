const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

const state = {
  files: [null, null],
  fields: [emptyFields(), emptyFields()],
  roiImages: [emptyRoiImages(), emptyRoiImages()],
};

const FIELD_CONFIG = [
  { key: 'containerNumber', label: 'CONTAINER NUMBER' },
  { key: 'sealNo', label: 'SEAL NO' },
  { key: 'booking', label: 'BOOKING' },
];

// ROI positions are relative to a normalized full document (x, y, width, height).
// Calibrated from the two real forms supplied by the user.
//
// File 1 — EAR:
// Container Number is left-middle, Seal below it, Booking on the right.
// File 2 — Vehicle Control Form:
// Container / Booking / Seal values are stacked in the left-middle area.
const ROI = [
  {
    containerNumber: { x: 0.045, y: 0.220, w: 0.310, h: 0.060 },
    sealNo:          { x: 0.045, y: 0.255, w: 0.315, h: 0.060 },
    booking:         { x: 0.610, y: 0.235, w: 0.360, h: 0.065 },
  },
  {
    containerNumber: { x: 0.185, y: 0.275, w: 0.270, h: 0.047 },
    booking:         { x: 0.185, y: 0.300, w: 0.270, h: 0.047 },
    sealNo:          { x: 0.185, y: 0.337, w: 0.270, h: 0.047 },
  }
];

const THAI_DIGITS = {
  '๐':'0','๑':'1','๒':'2','๓':'3','๔':'4',
  '๕':'5','๖':'6','๗':'7','๘':'8','๙':'9'
};

function emptyFields() {
  return { containerNumber:'', sealNo:'', booking:'' };
}

function emptyRoiImages() {
  return { containerNumber:null, sealNo:null, booking:null };
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

function repairContainer(v) {
  const raw = cleanCode(v);
  const matches = raw.match(/[A-Z0-9]{11}/g) || [];
  for (const item of matches.length ? matches : [raw]) {
    if (item.length < 11) continue;
    const s = item.slice(0,11);

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

    const value = prefix + digits;
    if (/^[A-Z]{4}\d{7}$/.test(value)) return value;
  }
  return '';
}

function parseField(fieldKey, rawText) {
  const text = thaiToArabic(String(rawText || '')).toUpperCase();

  if (fieldKey === 'containerNumber') {
    // Prefer exact ISO-like container code from this small ROI.
    const rawCandidates = text.match(/[A-Z0-9][A-Z0-9\s\-]{9,16}/g) || [];
    for (const c of rawCandidates) {
      const repaired = repairContainer(c);
      if (repaired) return repaired;
    }
    return repairContainer(text);
  }

  // ROI contains only the target value area, so choose alphanumeric code
  // rather than searching the whole document.
  const candidates = (text.match(/[A-Z0-9][A-Z0-9\-_/]{4,20}/g) || [])
    .map(cleanCode)
    .filter(v => /[A-Z]/.test(v) && /\d/.test(v));

  if (fieldKey === 'sealNo') {
    const ranked = candidates
      .filter(v => v.length >= 7 && v.length <= 14)
      .sort((a,b) => Math.abs(a.length-9)-Math.abs(b.length-9));
    return ranked[0] || '';
  }

  if (fieldKey === 'booking') {
    const ranked = candidates
      .filter(v => v.length >= 8 && v.length <= 16)
      .sort((a,b) => b.length-a.length);
    return ranked[0] || '';
  }

  return '';
}

function compare(a,b) {
  const na=normalize(a), nb=normalize(b);
  return {
    missing: !na || !nb,
    match: Boolean(na && nb && na === nb)
  };
}

function diffHint(a,b) {
  const na=normalize(a), nb=normalize(b);
  if(!na || !nb || na===nb) return '';

  const positions=[];
  for(let i=0;i<Math.max(na.length,nb.length);i++){
    if((na[i]||'∅') !== (nb[i]||'∅')) positions.push(i+1);
  }

  return `ไม่ตรงกันที่ตำแหน่ง: ${positions.slice(0,12).join(', ')}${positions.length>12?'…':''}`;
}

function isPdf(file) {
  return file.type==='application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

async function renderPdfPage(pdf,pageNumber,scale=3) {
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

async function fileToCanvas(file) {
  if(file.type.startsWith('image/')) {
    return await imageToCanvas(file);
  }

  if(isPdf(file)) {
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    return await renderPdfPage(pdf,1,3.2);
  }

  throw new Error('รองรับเฉพาะ PDF, JPG, JPEG, PNG และ WEBP');
}

function waitForOpenCv(timeoutMs=15000) {
  return new Promise(resolve => {
    const start=Date.now();

    const tick=()=>{
      if(window.cv && window.cv.Mat) {
        resolve(true);
        return;
      }

      if(Date.now()-start > timeoutMs) {
        resolve(false);
        return;
      }

      setTimeout(tick,200);
    };

    tick();
  });
}

function orderQuad(points) {
  // points: [{x,y}, ...]
  const sorted=[...points].sort((a,b)=>(a.x+a.y)-(b.x+b.y));
  const tl=sorted[0];
  const br=sorted[sorted.length-1];

  const remaining=points.filter(p=>p!==tl && p!==br);
  const tr=remaining.reduce((a,b)=>(a.x-a.y)>(b.x-b.y)?a:b);
  const bl=remaining.find(p=>p!==tr);

  return [tl,tr,br,bl];
}

function perspectiveNormalize(inputCanvas) {
  // If OpenCV is unavailable, return original.
  if(!window.cv || !window.cv.Mat) return inputCanvas;

  let src=null, gray=null, blur=null, edges=null, contours=null, hierarchy=null;

  try {
    src=cv.imread(inputCanvas);
    gray=new cv.Mat();
    blur=new cv.Mat();
    edges=new cv.Mat();

    cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray,blur,new cv.Size(5,5),0);
    cv.Canny(blur,edges,50,150);

    contours=new cv.MatVector();
    hierarchy=new cv.Mat();
    cv.findContours(edges,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);

    let best=null;
    let bestArea=0;

    for(let i=0;i<contours.size();i++){
      const cnt=contours.get(i);
      const peri=cv.arcLength(cnt,true);
      const approx=new cv.Mat();
      cv.approxPolyDP(cnt,approx,0.02*peri,true);
      const area=Math.abs(cv.contourArea(approx));

      if(approx.rows===4 && area>bestArea && area>src.rows*src.cols*0.20){
        if(best) best.delete();
        best=approx.clone();
        bestArea=area;
      }

      approx.delete();
      cnt.delete();
    }

    if(!best) return inputCanvas;

    const pts=[];
    for(let i=0;i<4;i++){
      pts.push({
        x:best.intPtr(i,0)[0],
        y:best.intPtr(i,0)[1]
      });
    }
    best.delete();

    const [tl,tr,br,bl]=orderQuad(pts);

    const widthTop=Math.hypot(tr.x-tl.x,tr.y-tl.y);
    const widthBottom=Math.hypot(br.x-bl.x,br.y-bl.y);
    const heightLeft=Math.hypot(bl.x-tl.x,bl.y-tl.y);
    const heightRight=Math.hypot(br.x-tr.x,br.y-tr.y);

    const outW=Math.max(800,Math.round(Math.max(widthTop,widthBottom)));
    const outH=Math.max(1100,Math.round(Math.max(heightLeft,heightRight)));

    const srcPts=cv.matFromArray(4,1,cv.CV_32FC2,[
      tl.x,tl.y, tr.x,tr.y, br.x,br.y, bl.x,bl.y
    ]);

    const dstPts=cv.matFromArray(4,1,cv.CV_32FC2,[
      0,0, outW-1,0, outW-1,outH-1, 0,outH-1
    ]);

    const matrix=cv.getPerspectiveTransform(srcPts,dstPts);
    const warped=new cv.Mat();

    cv.warpPerspective(
      src,warped,matrix,new cv.Size(outW,outH),
      cv.INTER_LINEAR,cv.BORDER_CONSTANT,new cv.Scalar()
    );

    const out=document.createElement('canvas');
    out.width=outW;
    out.height=outH;
    cv.imshow(out,warped);

    srcPts.delete();
    dstPts.delete();
    matrix.delete();
    warped.delete();

    return out;
  } catch(err) {
    console.warn('Perspective normalization skipped:',err);
    return inputCanvas;
  } finally {
    if(src) src.delete();
    if(gray) gray.delete();
    if(blur) blur.delete();
    if(edges) edges.delete();
    if(contours) contours.delete();
    if(hierarchy) hierarchy.delete();
  }
}

function cropCanvas(source, roi, padding=0.01) {
  const x=Math.max(0,Math.round((roi.x-padding)*source.width));
  const y=Math.max(0,Math.round((roi.y-padding)*source.height));
  const w=Math.min(
    source.width-x,
    Math.round((roi.w+padding*2)*source.width)
  );
  const h=Math.min(
    source.height-y,
    Math.round((roi.h+padding*2)*source.height)
  );

  const scale=3;
  const out=document.createElement('canvas');
  out.width=Math.max(1,w*scale);
  out.height=Math.max(1,h*scale);

  const ctx=out.getContext('2d',{willReadFrequently:true});
  ctx.imageSmoothingEnabled=true;
  ctx.drawImage(source,x,y,w,h,0,0,out.width,out.height);

  return out;
}

function preprocessRoi(src, mode) {
  const c=document.createElement('canvas');
  c.width=src.width;
  c.height=src.height;

  const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(src,0,0);

  if(mode==='original') return c;

  const im=ctx.getImageData(0,0,c.width,c.height);
  const d=im.data;

  for(let i=0;i<d.length;i+=4){
    const gray=Math.round(d[i]*.299+d[i+1]*.587+d[i+2]*.114);
    let v=gray;

    if(mode==='contrast'){
      v=Math.max(0,Math.min(255,(gray-128)*2.3+128));
    } else if(mode==='threshold'){
      v=gray<185?0:255;
    }

    d[i]=d[i+1]=d[i+2]=v;
  }

  ctx.putImageData(im,0,0);
  return c;
}

async function recognizeRoi(worker,canvas,fieldKey) {
  const results=[];

  const passes=[
    ['original',7],
    ['contrast',7],
    ['threshold',7],
    ['contrast',8]
  ];

  for(const [mode,psm] of passes){
    const processed=preprocessRoi(canvas,mode);

    await worker.setParameters({
      tessedit_pageseg_mode:String(psm),
      preserve_interword_spaces:'1',
      user_defined_dpi:'300',
      tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/'
    });

    const result=await worker.recognize(processed);
    const text=result.data.text || '';
    const parsed=parseField(fieldKey,text);

    results.push({
      value:parsed,
      text,
      confidence:Number(result.data.confidence || 0)
    });
  }

  // Vote: same parsed value across passes wins.
  const map=new Map();
  for(const r of results){
    if(!r.value) continue;

    const k=normalize(r.value);
    const old=map.get(k) || {value:r.value,count:0,conf:0};
    old.count += 1;
    old.conf += r.confidence;
    map.set(k,old);
  }

  const ranked=[...map.values()]
    .sort((a,b)=>b.count-a.count || b.conf-a.conf);

  return {
    value:ranked[0]?.value || '',
    debug:results
  };
}

async function extractThreeFields(file,side,fileNo,start,end) {
  const input=await fileToCanvas(file);

  setProgress(start+3,`ข้อมูล ${fileNo}: กำลังจัดหน้าเอกสาร...`);
  await waitForOpenCv(5000);
  const normalized = perspectiveNormalize(input);

  const worker=await Tesseract.createWorker('eng',1,{
    logger:m=>{
      if(m.status==='recognizing text'){
        const q=m.progress||0;
        setProgress(
          start+(end-start)*Math.min(.92,q),
          `กำลังอ่านข้อมูล ${fileNo}: ${Math.round(q*100)}%`
        );
      }
    }
  });

  const fields=emptyFields();
  const roiImages=emptyRoiImages();
  const debug=[];

  try {
    let index=0;

    for(const {key,label} of FIELD_CONFIG){
      index += 1;

      setProgress(
        start+(end-start)*(index/4),
        `ข้อมูล ${fileNo}: อ่าน ${label}`
      );

      const crop=cropCanvas(normalized,ROI[side][key],0.012);
      roiImages[key]=crop.toDataURL('image/png');

      const result=await recognizeRoi(worker,crop,key);
      fields[key]=result.value;

      debug.push({
        key,
        label,
        passes:result.debug
      });
    }
  } finally {
    await worker.terminate();
  }

  return {fields,roiImages,debug};
}

function setProgress(p,t){
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
  const missing=[];

  for(const cfg of FIELD_CONFIG){
    const result=compare(state.fields[0][cfg.key],state.fields[1][cfg.key]);

    let statusClass, statusText;

    if(result.missing){
      statusClass='missing';
      statusText='อ่านข้อมูลไม่ครบ';
      missing.push(cfg.label);
    } else if(result.match){
      statusClass='match';
      statusText='ตรงกัน';
    } else {
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
        ${state.roiImages[0][cfg.key]
          ? `<details style="margin-top:6px"><summary style="font-size:11px;color:#667085;cursor:pointer">ดูกรอบที่ระบบอ่าน</summary><img src="${state.roiImages[0][cfg.key]}" style="max-width:260px;margin-top:6px;border:1px solid #d0d5dd;border-radius:8px"></details>`
          : ''}
      </td>

      <td>
        <input data-side="1" data-key="${cfg.key}"
          value="${escapeHtml(state.fields[1][cfg.key])}">
        ${state.roiImages[1][cfg.key]
          ? `<details style="margin-top:6px"><summary style="font-size:11px;color:#667085;cursor:pointer">ดูกรอบที่ระบบอ่าน</summary><img src="${state.roiImages[1][cfg.key]}" style="max-width:260px;margin-top:6px;border:1px solid #d0d5dd;border-radius:8px"></details>`
          : ''}
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

  const overall=document.querySelector('#overallStatus');

  if(!missing.length && !mismatches.length){
    overall.textContent='ผ่านการตรวจสอบ — ทั้ง 3 หัวข้อตรงกัน';
    overall.className='overall pass';
  } else if(missing.length){
    overall.textContent=`ยังตรวจไม่ครบ — อ่านไม่พบ: ${missing.join(', ')}`;
    overall.className='overall fail';
  } else {
    overall.textContent=`ไม่ผ่าน — หัวข้อที่ไม่ตรง: ${mismatches.join(', ')}`;
    overall.className='overall fail';
  }
}

async function renderPreview(index,file){
  const preview=document.querySelector(`#preview${index+1}`);
  preview.innerHTML='';

  if(!file){
    preview.innerHTML='<span>ตัวอย่างเอกสารจะแสดงที่นี่</span>';
    return;
  }

  if(isPdf(file)){
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    preview.append(await renderPdfPage(pdf,1,1.2));
  } else if(file.type.startsWith('image/')){
    const img=new Image();
    img.src=URL.createObjectURL(file);
    img.alt=file.name;
    preview.append(img);
  }
}

async function setFile(index,file){
  state.files[index]=file;
  state.fields[index]=emptyFields();
  state.roiImages[index]=emptyRoiImages();

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

  ['dragenter','dragover'].forEach(name =>
    drop.addEventListener(name,e=>{
      e.preventDefault();
      drop.classList.add('drag');
    })
  );

  ['dragleave','drop'].forEach(name =>
    drop.addEventListener(name,e=>{
      e.preventDefault();
      drop.classList.remove('drag');
    })
  );

  drop.addEventListener('drop',e=>{
    const file=e.dataTransfer?.files?.[0];
    if(file) setFile(index,file);
  });
}

async function checkDocuments(){
  clearError();

  if(!state.files[0] || !state.files[1]){
    showError('กรุณาเลือกไฟล์ข้อมูล 1 และข้อมูล 2 ให้ครบ');
    return;
  }

  const button=document.querySelector('#checkButton');
  button.disabled=true;

  try{
    setProgress(2,'กำลังเตรียมข้อมูล 1 — ใบ EAR...');
    const a=await extractThreeFields(state.files[0],0,1,3,48);

    state.fields[0]=a.fields;
    state.roiImages[0]=a.roiImages;

    setProgress(51,'กำลังเตรียมข้อมูล 2 — แบบฟอร์มควบคุมรถ...');
    const b=await extractThreeFields(state.files[1],1,2,52,97);

    state.fields[1]=b.fields;
    state.roiImages[1]=b.roiImages;

    document.querySelector('#rawText1').textContent =
      JSON.stringify(a.debug,null,2);

    document.querySelector('#rawText2').textContent =
      JSON.stringify(b.debug,null,2);

    document.querySelector('#reportFile1').textContent=state.files[0].name;
    document.querySelector('#reportFile2').textContent=state.files[1].name;
    document.querySelector('#reportDate').textContent =
      new Date().toLocaleString('th-TH');

    renderResults();

    document.querySelector('#resultSection').classList.remove('hidden');
    setProgress(100,'อ่าน 3 ช่องและเปรียบเทียบเสร็จแล้ว');

    document.querySelector('#resultSection')
      .scrollIntoView({behavior:'smooth'});
  } catch(error){
    console.error(error);
    showError(`ไม่สามารถประมวลผลได้: ${error?.message || error}`);
  } finally {
    button.disabled=false;
  }
}

function resetAll(){
  state.files=[null,null];
  state.fields=[emptyFields(),emptyFields()];
  state.roiImages=[emptyRoiImages(),emptyRoiImages()];

  [1,2].forEach(n=>{
    document.querySelector(`#file${n}`).value='';
    document.querySelector(`#fileName${n}`).textContent='ยังไม่ได้เลือกไฟล์';
    document.querySelector(`#preview${n}`).innerHTML=
      '<span>ตัวอย่างเอกสารจะแสดงที่นี่</span>';
  });

  document.querySelector('#resultSection').classList.add('hidden');
  document.querySelector('#progressWrap').classList.add('hidden');
  clearError();
}

attachUpload(0);
attachUpload(1);

document.querySelector('#checkButton')
  .addEventListener('click',checkDocuments);

document.querySelector('#resetButton')
  .addEventListener('click',resetAll);

document.querySelector('#printButton')
  .addEventListener('click',()=>window.print());
