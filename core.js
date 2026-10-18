/* KLAPS browser pilot. Project-owned static adaptation; server endpoints are never called. */
(() => {
  'use strict';
  const DATA = window.KLAPS_DATA;
  if (!DATA?.seed) throw new Error('The bundled pilot data did not load.');
  const KEY = 'klaps-static-pilot-v1:' + location.pathname.replace(/[^/]*$/, '');
  const THEME_KEY = KEY + ':theme';
  const MEDIA_DB = KEY + ':media';
  const clone = value => JSON.parse(JSON.stringify(value));
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const t = (key, vars) => typeof window.KLAPS_T === 'function' ? window.KLAPS_T(key, vars) : key;
  const now = () => new Date().toISOString();
  const uid = prefix => prefix + '-' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
  const PAGES = new Set(['library','source','search','notes','decisions','boards','pitches','team','about']);
  const LANES = ['Research','Develop','Ready'];
  const FIELDS = ['title','logline','synopsis','characters','visualDirection','audience','whyNow','treatment'];
  let storageAvailable = true, dbPromise, rangeEnd = null, lastDialogTrigger, state, route;
  let filteredResults = [], searchMode = 'text', pendingStatus = '', renderNumber = 0, statusTimer;
  const objectUrls = new Map();

  function sanitizeState(input) {
    if (!input || input.schemaVersion !== 1 || typeof input.project !== 'object') throw new Error(t('This is not a KLAPS pilot backup.'));
    const output = clone(DATA.seed);
    output.revision = Number.isSafeInteger(input.revision) ? input.revision : 0;
    for (const field of ['materials','notes','decisions','cards','pitches']) {
      if (!Array.isArray(input[field]) || input[field].length > 2000) throw new Error(t('The backup has an invalid collection.'));
      output[field] = input[field].map(record => {
        if (!record || typeof record !== 'object' || typeof record.id !== 'string' || record.id.length > 160) throw new Error(t('The backup has an invalid record.'));
        if (JSON.stringify(record).length > 150000) throw new Error(t('A backup record is too large.'));
        const clean = {};
        const allowed = field === 'materials' ? ['id','name','kind','description','tags','duration','text','origin','createdAt','mime','size','referenceOnly'] : field === 'pitches' ? ['id','parentId','origin','createdAt','fields','modelId','recordedCase'] : field === 'notes' ? ['id','body','author','source','createdAt'] : field === 'decisions' ? ['id','title','body','rationale','status','author','source','createdAt'] : ['id','title','body','lane','source','createdAt'];
        for (const key of allowed) if (Object.hasOwn(record,key)) clean[key] = clone(record[key]);
        if (field === 'materials') {
          if (!['video','image','audio','document'].includes(clean.kind)) throw new Error(t('Unknown material type in backup.'));
          clean.name = String(clean.name ?? 'Untitled').slice(0,200);
          clean.description = String(clean.description ?? '').slice(0,8000);
          clean.text = typeof clean.text === 'string' ? clean.text.slice(0,100000) : null;
          clean.tags = Array.isArray(clean.tags) ? clean.tags.slice(0,30).map(x=>String(x).slice(0,100)) : [];
          clean.duration = Number.isFinite(clean.duration) && clean.duration >= 0 ? clean.duration : null;
          const bundled = DATA.seed.materials.find(x => x.id === clean.id);
          clean.src = bundled?.src ?? null;
          clean.poster = bundled?.poster ?? null;
          clean.origin = bundled ? 'demo' : 'import';
          if (bundled?.referenceOnly) clean.referenceOnly = true;
        } else if (field === 'pitches') {
          if (!clean.fields || typeof clean.fields !== 'object') throw new Error(t('Pitch fields are missing.'));
          clean.fields = Object.fromEntries(FIELDS.map(key=>[key,String(clean.fields[key] ?? '').slice(0,12000)]));
          clean.origin = clean.origin === 'recorded-ai' ? 'recorded-ai' : 'human';
        } else {
          for (const key of ['title','body','rationale','author']) if (key in clean) clean[key] = String(clean[key] ?? '').slice(0,key==='author'?100:8000);
          if (field === 'cards' && !LANES.includes(clean.lane)) clean.lane='Research';
          if (field === 'decisions') clean.status = clean.status === 'resolved' && clean.rationale?.trim() ? 'resolved' : 'open';
          if (clean.source) clean.source = normalizeSource(clean.source, output.materials);
        }
        return clean;
      });
      if (new Set(output[field].map(x=>x.id)).size !== output[field].length) throw new Error(t('The backup contains duplicate identifiers.'));
    }
    output.preferredPitchId = output.pitches.some(x=>x.id===input.preferredPitchId) ? input.preferredPitchId : null;
    return output;
  }
  function normalizeSource(input, materials = state?.materials ?? DATA.seed.materials) {
    const materialId = String(input.materialId ?? '');
    const material = materials.find(x=>x.id===materialId);
    if (!material) throw new Error(t('Choose an existing source material.'));
    const value = x => x === null || x === undefined || x === '' ? null : Number(x);
    const start=value(input.start), end=value(input.end);
    if ((start === null) !== (end === null) || (start !== null && (!Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start || (material.duration!==null && material.duration!==undefined && end>material.duration+.001)))) throw new Error(t('Use a valid interval: end must follow start and stay within the source duration.'));
    return {materialId,segmentId:input.segmentId ? String(input.segmentId).slice(0,160):null,start,end};
  }
  function load() {
    try { const saved=localStorage.getItem(KEY); return saved ? sanitizeState(JSON.parse(saved)) : clone(DATA.seed); }
    catch { pendingStatus=t('Saved data could not be read. The bundled project is available; keep your JSON backup before resetting.');return clone(DATA.seed); }
  }
  state=load();
  function save(message) {
    state.revision=(state.revision||0)+1;
    try {localStorage.setItem(KEY,JSON.stringify(state)); storageAvailable=true;}
    catch {storageAvailable=false; message=t('Browser storage is unavailable. Changes remain in this tab; download a JSON backup.');}
    if (message) announce(message);
  }
  function announce(message) {
    pendingStatus=message;
    const status=document.getElementById('status');
    if (status) {status.textContent=message;status.classList.add('is-visible');clearTimeout(statusTimer);if(storageAvailable)statusTimer=setTimeout(()=>{status.textContent='';status.classList.remove('is-visible');},6000);}
  }
  function readRoute() {
    try {
      const parts=(location.hash.replace(/^#\/?/,'') || 'library').split('?');
      const path=parts[0].split('/').filter(Boolean);
      return {page:PAGES.has(path[0])?path[0]:'library',id:path[1]?decodeURIComponent(path[1]):null,params:new URLSearchParams(parts.slice(1).join('?'))};
    } catch {return {page:'library',id:null,params:new URLSearchParams()};}
  }
  function url(page,id=null,params={}) {
    const query = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!==null&&v!=='')).toString();
    return '#/'+page+(id?'/'+encodeURIComponent(id):'')+(query?'?'+query:'');
  }
  function navigate(page,id=null,params={}) {const target=url(page,id,params);if(location.hash===target) render();else location.hash=target;}
  const material=id=>state.materials.find(m=>m.id===id);
  function tc(seconds) {if(!Number.isFinite(seconds))return '';const n=Math.floor(seconds);return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(x=>String(x).padStart(2,'0')).join(':');}
  function sourceLabel(source) {const m=source&&material(source.materialId);return m ? m.name+(source.start!==null&&source.start!==undefined?' · '+tc(Number(source.start))+'–'+tc(Number(source.end)):'') : t('Project context');}
  const normalized = str=>String(str??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/ł/g,'l').replace(/[^a-z0-9]+/g,' ').trim();
  function dot(a,b) {let sum=0;for(let i=0;i<a.length;i++)sum+=Math.fround(a[i])*Math.fround(b[i]);return Math.max(-1,Math.min(1,sum));}
  function search(query, currentState=state) {
    const term=normalized(query);
    const vectors=DATA.vectors;
    const preset=term ? vectors?.queries?.find(x=>[x.text,x.query,x.english,x.id].some(v=>typeof v==='string'&&normalized(v)===term)) : null;
    if (preset) {
      const results=vectors.segments.map(s=>{const visualScore=dot(preset.vector,s.v),audioScore=dot(preset.vector,s.a);return {id:s.id,materialId:s.materialId,start:s.start,end:s.end,score:Math.max(visualScore,audioScore),visualScore,audioScore,mode:'recorded-vector',snippet:preset.english};});
      results.sort((a,b)=>b.score-a.score || a.start-b.start);
      return {mode:'recorded-vector',results:results.slice(0,12),query:preset};
    }
    const words=term.split(' ').filter(Boolean);
    const rows=currentState.materials.filter(m=>!m.referenceOnly).map(m=>{
      const related=currentState.notes.filter(n=>n.source?.materialId===m.id).map(n=>n.body).join(' ');
      const haystack=normalized([m.name,m.description,m.text,...(m.tags||[]),related].join(' '));
      const count=words.filter(word=>haystack.includes(word)).length;
      const score=words.length?count/words.length:1;
      return {id:'local-'+m.id,materialId:m.id,start:m.kind==='video'?0:null,end:m.kind==='video'?Math.min(m.duration??8,8):null,score:null,textRank:score,mode:'text',snippet:m.description||m.text?.slice(0,240)||m.name};
    }).filter(r=>!words.length || r.textRank>0).sort((a,b)=>b.textRank-a.textRank);
    return {mode:'text',results:rows,query:null};
  }
  function context() {
    route=readRoute();
    const q=route.params.get('q')||'';
    const found=search(q);filteredResults=q.trim()?found.results:[];searchMode=found.mode;
    const pitches=state.pitches;
    const pitchA=pitches.find(x=>x.id===route.params.get('a')) || pitches[pitches.length-1] || null;
    const pitchB=pitches.find(x=>x.id===route.params.get('b')) || pitches[pitches.length-2] || null;
    const selectedSegment=DATA.vectors?.segments?.find(x=>x.id===route.params.get('segment')) || null;
    return {state,route,q,searchMode,results:filteredResults,selectedSegment,pitchA,pitchB,data:DATA,t,e,url,material,sourceLabel,storageAvailable,tc};
  }
  function render(focus=true) {
    const app=document.getElementById('app');if (!app || !window.KLAPS_VIEWS) return;
    const P=context();const view=window.KLAPS_VIEWS[P.route.page]||window.KLAPS_VIEWS.library;
    app.innerHTML=window.KLAPS_VIEWS.shell(P,view(P));
    renderNumber++;
    document.title='KLAPS · '+(P.route.page==='source'?(material(P.route.id)?.name||'Source'):P.route.page.charAt(0).toUpperCase()+P.route.page.slice(1));
    const theme=document.documentElement.dataset.theme==='daylight';
    document.querySelectorAll('[data-action="theme"]').forEach(b=>{b.setAttribute('aria-pressed',String(theme));if(b.getAttribute('role')==='switch')b.setAttribute('aria-checked',String(theme));});
    if(focus){const h=app.querySelector('h1');if(h){h.tabIndex=-1;h.focus({preventScroll:true});}window.scrollTo(0,0);}
    hydrateMedia(renderNumber);
  }
  function db() {
    if (!globalThis.indexedDB) return Promise.reject(new Error(t('Media storage is unavailable.')));
    if (!dbPromise) dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(MEDIA_DB,1);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('media'))request.result.createObjectStore('media');};
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error(t('Media storage is busy in another tab.')));
    });
    return dbPromise;
  }
  async function blobPut(id,blob) {const store=await db();await new Promise((resolve,reject)=>{const tx=store.transaction('media','readwrite');tx.objectStore('media').put(blob,id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  async function blobGet(id) {const store=await db();return new Promise((resolve,reject)=>{const req=store.transaction('media','readonly').objectStore('media').get(id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
  async function clearMedia() {try{const store=await db();await new Promise((resolve,reject)=>{const tx=store.transaction('media','readwrite');tx.objectStore('media').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}finally{for(const src of objectUrls.values())URL.revokeObjectURL(src);objectUrls.clear();}}
  async function hydrateMedia(token) {
    const current=readRoute();if(current.page!=='source')return;
    const m=material(current.id);if(!m)return;
    let src=m.src;
    // Small bundled demo clips use a Blob URL so interval seeking also works on
    // simple static servers that do not implement HTTP Range requests.
    if(m.origin!=='import'&&src&&(m.kind==='video'||m.kind==='audio')) {
      if(objectUrls.has(m.id))src=objectUrls.get(m.id);
      else try {const response=await fetch(src);if(response.ok){const blob=await response.blob();if(token!==renderNumber)return;src=URL.createObjectURL(blob);objectUrls.set(m.id,src);}}catch{/* Direct static-media playback remains the fallback. */}
    }
    if(m.origin==='import') {
      try {let blob=await blobGet(m.id);if(token!==renderNumber)return;if(blob){if(objectUrls.has(m.id))URL.revokeObjectURL(objectUrls.get(m.id));src=URL.createObjectURL(blob);objectUrls.set(m.id,src);}else src=objectUrls.get(m.id)||null;}
      catch {src=objectUrls.get(m.id)||null;}
      if(!src){const host=document.getElementById('source-preview');if(host&&!m.text)host.innerHTML='<p class="pilot-empty">'+e(t('This local file is not available on this device. Import it again to view it; your notes remain saved.'))+'</p>';return;}
    }
    const el=document.getElementById('source-video') || document.querySelector('[data-source-media]');
    if(el&&src){if(el.tagName==='A')el.href=src;else el.src=src;if(el.tagName==='VIDEO'||el.tagName==='AUDIO') {
      const start=Number(current.params.get('start')||0);
      el.addEventListener('loadedmetadata',()=>{if(rangeEnd===null&&Number.isFinite(start)&&start>=0&&start<el.duration)el.currentTime=start;},{once:true});
      el.addEventListener('timeupdate',()=>{if(rangeEnd!==null&&el.currentTime>=rangeEnd){el.pause();rangeEnd=null;}});
    }}
  }
  function field(name,label,value='',options={}) {
    const {textarea=false,required=false,type='text',maxLength=8000}=options;
    const attrs=`name="${e(name)}" id="dialog-field-${e(name)}"${required?' required':''} maxlength="${maxLength}"`;
    return `<label class="pilot-field" for="dialog-field-${e(name)}"><span>${e(t(label))}</span>${textarea?`<textarea class="kl-input" ${attrs} rows="4">${e(value)}</textarea>`:`<input class="kl-input" ${attrs} type="${e(type)}" value="${e(value)}"${type==='number'?' min="0" step="0.001"':''}>`}</label>`;
  }
  function sourceFields(source={}) {
    return `<label class="pilot-field"><span>${e(t('Source material'))}</span><select class="kl-select" name="materialId" required>${state.materials.map(m=>`<option value="${e(m.id)}"${source.materialId===m.id?' selected':''}>${e(m.name)}</option>`).join('')}</select></label><div class="pilot-fields-row">${field('start','Start, seconds (optional)',source.start??'',{type:'number'})}${field('end','End, seconds (optional)',source.end??'',{type:'number'})}</div>`;
  }
  function showDialog(title,body,formName,submitLabel='Save') {
    const dialog=document.getElementById('pilot-dialog');lastDialogTrigger=document.activeElement;
    dialog.innerHTML=`<div class="pilot-dialog__body kl-on-paper"><header class="pilot-dialog__head"><h2 id="dialog-title">${e(t(title))}</h2><button type="button" class="kl-btn kl-btn--ghost" data-action="close-dialog" aria-label="${e(t('Close'))}">×</button></header><form data-form="${e(formName)}"><div id="dialog-error" class="pilot-error" role="alert" tabindex="-1" hidden></div>${body}<footer class="pilot-dialog__actions"><button type="button" class="kl-btn" data-action="close-dialog">${e(t('Cancel'))}</button><button type="submit" class="kl-btn kl-btn--primary">${e(t(submitLabel))}</button></footer></form></div>`;
    dialog.setAttribute('aria-labelledby','dialog-title');dialog.showModal();
    const first=dialog.querySelector('input:not([type="hidden"]), textarea, select');if(first)first.focus();
  }
  function closeDialog() {const d=document.getElementById('pilot-dialog');if(d?.open)d.close();if(lastDialogTrigger?.isConnected)lastDialogTrigger.focus();}
  function dialogError(error) {const host=(document.getElementById('pilot-dialog')?.open ? document.getElementById('dialog-error'):null) || document.getElementById('form-error');if(host){host.textContent=error.message||String(error);host.hidden=false;host.focus();}else announce(error.message||String(error));}
  function formSource(form) {return normalizeSource({materialId:form.get('materialId'),start:form.get('start'),end:form.get('end')});}
  function value(form,key,max=8000,required=false) {const v=String(form.get(key)??'').trim();if(required&&!v)throw new Error(t('Complete every required field.'));if(v.length>max)throw new Error(t('A field is too long.'));return v;}
  function saveForm(kind,form) {
    if(kind==='note') {const source=formSource(form);state.notes.unshift({id:uid('note'),body:value(form,'body',8000,true),author:value(form,'author',100)||'Director',source,createdAt:now()});save(t('Sourced note saved in this browser.'));return 'notes';}
    if(kind==='decision') {const source=formSource(form);state.decisions.unshift({id:uid('decision'),title:value(form,'title',200,true),body:value(form,'body'),rationale:value(form,'rationale'),status:'open',author:value(form,'author',100)||'Director',source,createdAt:now()});save(t('Decision recorded with its source.'));return 'decisions';}
    if(kind==='resolve') {const decision=state.decisions.find(x=>x.id===value(form,'id'));if(!decision)throw new Error(t('Decision not found.'));const rationale=value(form,'rationale',8000,true);decision.status='resolved';decision.rationale=rationale;save(t('Decision resolved with a rationale.'));return 'decisions';}
    if(kind==='card') {const source=formSource(form),lane=value(form,'lane');state.cards.push({id:uid('card'),title:value(form,'title',200,true),body:value(form,'body'),lane:LANES.includes(lane)?lane:'Research',source,createdAt:now()});save(t('Source added to the production board.'));return 'boards';}
    if(kind==='pitch') {const fields=Object.fromEntries(FIELDS.map(k=>[k,value(form,k,12000,true)]));const parentId=value(form,'parentId',160)||null;if(parentId&&!state.pitches.some(x=>x.id===parentId))throw new Error(t('Parent pitch not found.'));const id=uid('pitch');state.pitches.push({id,parentId,origin:'human',createdAt:now(),fields});save(t('A new pitch version was saved. Earlier versions are preserved.'));return {page:'pitches',id};}
    throw new Error(t('Unknown form.'));
  }
  function download(name,content,type='application/json') {
    const blob=content instanceof Blob?content:new Blob([content],{type});const href=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=href;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(href),15000);
  }
  function preferPitch(id) {if(!state.pitches.some(x=>x.id===id))throw new Error(t('Pitch not found.'));state.preferredPitchId=id;save(t('Preferred pitch selected.'));}
  function moveCard(id,lane) {const card=state.cards.find(x=>x.id===id);if(!card||!LANES.includes(lane))throw new Error(t('Choose an existing board lane.'));card.lane=lane;save(t('Board card moved.'));}
  function useRecorded(id) {const draft=DATA.recordedDrafts?.find(x=>x.id===id)||DATA.recordedDrafts?.[0];if(!draft)throw new Error(t('Recorded draft not found.'));const version=uid('pitch');state.pitches.push({id:version,parentId:state.pitches.at(-1)?.id??null,origin:'recorded-ai',createdAt:now(),fields:clone(draft.fields??draft.content),modelId:draft.modelId,recordedCase:draft.id});save(t('Recorded AI draft added as a local version. No new inference was run.'));return version;}
  function projectBackup() {const backup=sanitizeState(state);return JSON.stringify({...backup,exportedAt:now(),format:'klaps-static-pilot-v1',notice:'Browser-local project. Imported media blobs are not included; re-import source files after moving to another device.'},null,2);}
  function pitchHtml(id) {
    const pitch=state.pitches.find(x=>x.id===id);if(!pitch)throw new Error(t('Pitch not found.'));
    const body=FIELDS.map(key=>`<section><h2>${e(key.replace(/([A-Z])/g,' $1'))}</h2><p>${e(pitch.fields[key]).replace(/\n/g,'<br>')}</p></section>`).join('');
    const sources=state.materials.filter(m=>m.origin==='demo'&&!m.referenceOnly).map(m=>`<li>${e(m.name)} — ${e(m.description)}</li>`).join('');
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(pitch.fields.title)}</title><style>body{font:17px/1.6 Georgia,serif;max-width:820px;margin:48px auto;padding:0 24px;color:#141311;background:#f1ece2}h1,h2{font-family:system-ui}h1{font-size:42px}h2{font-size:18px;margin-top:32px}p{white-space:normal}header{border-bottom:4px solid #f2b33d}small{font:13px/1.6 system-ui}section{break-inside:avoid}</style><header><small>KLAPS · ${e(state.project.studio)} · ${e(state.project.name)}</small><h1>${e(pitch.fields.title)}</h1><p>${e(pitch.origin==='recorded-ai'?'Previously generated AI draft; human editorial review required.':'Human-authored pitch version.')}</p></header>${body}<h2>Selected project context</h2><ul>${sources}</ul><footer><small>Version ${e(pitch.id)} · Parent ${e(pitch.parentId||'none')} · ${e(pitch.createdAt)}<br>Exported from the browser-only KLAPS pilot. Media and server services are not embedded in this reading copy.</small></footer></html>`;
  }
  async function importFiles(files) {
    if(files.length>20)throw new Error(t('Import up to 20 files at a time.'));
    let memoryOnly=false,added=0;
    for(const file of files) {
      if(file.size>250*1024*1024){announce(t('A file exceeds the 250 MB browser import limit.'));continue;}
      const suffix=file.name.split('.').pop().toLowerCase();
      const kind=file.type.startsWith('video/')?'video':file.type.startsWith('audio/')?'audio':file.type.startsWith('image/')?'image':['txt','md','csv','json','pdf'].includes(suffix)?'document':null;
      if(!kind || (kind==='image' && (suffix==='svg'||file.type==='image/svg+xml'))){announce(t('Unsupported file type. Use video, audio, raster images, PDF or plain text.'));continue;}
      // Reselecting an imported file with the same name and size restores its source links.
      const existing=state.materials.find(m=>m.origin==='import'&&m.name===file.name&&m.size===file.size&&m.kind===kind);
      const id=existing?.id||uid('material');let text=null;
      if(kind==='document'&&suffix!=='pdf'){if(file.size>1024*1024){announce(t('Text imports must be at most 1 MB.'));continue;}text=await file.text();if(text.length>100000){announce(t('Text previews support at most 100,000 characters per file.'));continue;}}
      let duration=null;
      if(kind==='video'||kind==='audio') {
        const temp=URL.createObjectURL(file);
        duration=await new Promise(resolve=>{const media=document.createElement(kind);media.preload='metadata';let done=false;const finish=v=>{if(done)return;done=true;media.removeAttribute('src');media.load();URL.revokeObjectURL(temp);resolve(v);};media.onloadedmetadata=()=>finish(Number.isFinite(media.duration)?media.duration:null);media.onerror=()=>finish(null);media.src=temp;setTimeout(()=>finish(null),4000);});
      }
      try {await blobPut(id,file);}catch {objectUrls.set(id,URL.createObjectURL(file));memoryOnly=true;}
      const record={id,name:file.name,kind,description:existing?.description||t('Imported locally. Search uses the file name, description and notes; no AI indexing was run.'),tags:existing?.tags||[],duration,src:null,poster:null,text,origin:'import',mime:file.type,size:file.size,createdAt:existing?.createdAt||now()};
      if(existing)state.materials[state.materials.findIndex(m=>m.id===id)]=record;else state.materials.unshift(record);added++;
    }
    if(added){save(memoryOnly?t('Files preview in this tab. Persistent media storage is unavailable; keep the originals.') : t('Files saved locally on this device. No upload or AI indexing was performed.'));navigate('library');}
  }
  function actionSource(button) {const current=readRoute(),params=current.params;return {materialId:button.dataset.id||current.id||state.materials[0]?.id,start:(current.page==='source'?document.getElementById('range-start')?.value:undefined)??button.dataset.start??params.get('start')??'',end:(current.page==='source'?document.getElementById('range-end')?.value:undefined)??button.dataset.end??params.get('end')??''};}
  async function clickAction(event) {
    const button=event.target.closest('[data-action]');if(!button)return;
    const action=button.dataset.action;
    if(button.tagName==='A' && !['play-range'].includes(action))return;
    try {
      if(action==='theme') {const theme=document.documentElement.dataset.theme==='daylight'?'table':'daylight';document.documentElement.dataset.theme=theme;try{localStorage.setItem(THEME_KEY,theme);}catch{}document.querySelectorAll('[data-action="theme"]').forEach(b=>{b.setAttribute('aria-pressed',String(theme==='daylight'));if(b.getAttribute('role')==='switch')b.setAttribute('aria-checked',String(theme==='daylight'));});return;}
      if(action==='close-dialog'){closeDialog();return;}
      if(action==='skip'){document.getElementById('workspace-main')?.focus();return;}
      if(action==='import'){document.getElementById('import-files').click();return;}
      if(action==='restore-project'){document.getElementById('restore-file').click();return;}
      if(action==='export-project'){download('KLAPS-project-backup.json',projectBackup());announce(t('Project JSON downloaded. Keep imported media originals separately.'));return;}
      if(action==='reset'){showDialog('Reset this browser project?',`<p>${e(t('This replaces notes, decisions, boards and pitches with the bundled example. Download a backup first if you want to keep your changes.'))}</p>`,'reset-confirm','Reset example');return;}
      if(action==='prefer-pitch'){preferPitch(button.dataset.id);render(false);if(event.detail===0){const heading=document.querySelector('.pilot-pitch-title');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}return;}
      if(action==='export-pitch'){const id=button.dataset.id||route.id||state.preferredPitchId||state.pitches.at(-1)?.id;download('KLAPS-pitch.html',pitchHtml(id),'text/html;charset=utf-8');announce(t('Self-contained pitch reading copy downloaded.'));return;}
      if(action==='new-pitch'){navigate('pitches','new',button.dataset.parent?{parent:button.dataset.parent}:{});return;}
      if(action==='compare'){navigate('pitches',null,{a:button.dataset.id||state.pitches.at(-1)?.id,b:button.dataset.parent||state.pitches.at(-2)?.id});return;}
      if(action==='use-recorded') {navigate('pitches',useRecorded(button.dataset.id));return;}
      if(action==='play-range') {const video=document.getElementById('source-video');if(!video)throw new Error(t('No playable source is available.'));const start=Number(document.getElementById('range-start')?.value??button.dataset.start??0),end=Number(document.getElementById('range-end')?.value??button.dataset.end??video.duration);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>video.duration+.01)throw new Error(t('Choose a valid playback interval.'));video.currentTime=start;rangeEnd=end;await video.play();return;}
      if(action==='new-note'||action==='note-from-source') {const s=action==='note-from-source'?actionSource(button):{};showDialog('Add a sourced note',sourceFields(s)+field('body','Note','',{textarea:true,required:true})+field('author','Author','Director',{maxLength:100}),'note');return;}
      if(action==='new-decision'||action==='decision-from-source') {const s=action==='decision-from-source'?actionSource(button):{};showDialog('Record a decision',field('title','Decision title','',{required:true,maxLength:200})+sourceFields(s)+field('body','Proposal','',{textarea:true})+field('author','Author','Director',{maxLength:100}),'decision');return;}
      if(action==='new-card'||action==='card-from-source') {const s=action==='card-from-source'?actionSource(button):{};showDialog('Add a board card',field('title','Card title','',{required:true,maxLength:200})+sourceFields(s)+field('body','Production context','',{textarea:true})+`<label class="pilot-field"><span>${e(t('Lane'))}</span><select class="kl-select" name="lane">${LANES.map(x=>'<option>'+e(x)+'</option>').join('')}</select></label>`,'card');return;}
      if(action==='resolve-decision') {const d=state.decisions.find(x=>x.id===button.dataset.id);if(!d)throw new Error(t('Decision not found.'));showDialog('Resolve with a rationale',`<input type="hidden" name="id" value="${e(d.id)}"><p>${e(d.title)}</p>`+field('rationale','Why this decision?',d.rationale||'',{textarea:true,required:true}),'resolve','Resolve decision');return;}
      if(action==='move-card') {moveCard(button.dataset.id,button.dataset.lane);render(false);if(event.detail===0){const next=[...document.querySelectorAll('[data-action="move-card"]')].find(x=>x.dataset.id===button.dataset.id);next?.focus({preventScroll:true});}return;}
    }catch(error){dialogError(error);}
  }
  async function submit(event) {
    const form=event.target.closest('form[data-form]');if(!form)return;event.preventDefault();if(!form.reportValidity())return;
    try {
      const values=new FormData(form),kind=form.dataset.form;
      if(kind==='search'){navigate('search',null,{q:value(values,'q',500)});return;}
      if(kind==='library-filter'){navigate('library',null,{q:value(values,'q',500),kind:value(values,'kind',30)});return;}
      if(kind==='compare'){navigate('pitches',null,{a:value(values,'a',160),b:value(values,'b',160)});return;}
      if(kind==='reset-confirm'){let mediaCleared=true;try{await clearMedia();}catch{mediaCleared=false;}state=clone(DATA.seed);save(mediaCleared?t('Bundled example restored.'):t('Example restored. Media storage could not be cleared; clear site data in browser settings to remove old file bytes.'));closeDialog();navigate('library');return;}
      const destination=saveForm(kind,values);closeDialog();if(typeof destination==='string')navigate(destination);else navigate(destination.page,destination.id);
    }catch(error){dialogError(error);}
  }
  function boot() {
    try {const theme=localStorage.getItem(THEME_KEY);document.documentElement.dataset.theme=theme==='daylight'?'daylight':'table';}catch{}
    if(!document.getElementById('pilot-dialog')){const dialog=document.createElement('dialog');dialog.id='pilot-dialog';dialog.className='pilot-dialog';document.body.append(dialog);}
    if(!document.getElementById('status')){const status=document.createElement('div');status.id='status';status.className='pilot-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');document.body.append(status);}
    for(const [id,accept,multiple] of [['import-files','video/*,audio/*,image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.json,.pdf',true],['restore-file','.json',false]])if(!document.getElementById(id)){const input=document.createElement('input');input.id=id;input.type='file';input.accept=accept;input.multiple=multiple;input.hidden=true;document.body.append(input);}
    document.addEventListener('click',clickAction);document.addEventListener('submit',submit);
    document.getElementById('import-files').addEventListener('change',async event=>{try{await importFiles([...event.target.files]);}catch(error){announce(error.message);}event.target.value='';});
    document.getElementById('restore-file').addEventListener('change',async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>32*1024*1024)throw new Error(t('Backups must be smaller than 32 MB.'));const incoming=sanitizeState(JSON.parse(await file.text()));showDialog('Restore this project backup?',`<p>${e(t('This replaces the current browser project. Imported media originals must be selected again on a new device.'))}</p>`,'restore-confirm','Restore project');const form=document.querySelector('#pilot-dialog form');form.addEventListener('submit',event=>{event.preventDefault();event.stopImmediatePropagation();state=incoming;save(t('Project restored. Bundled media is available; re-import missing local files as needed.'));closeDialog();navigate('library');},{once:true});}catch(error){announce(error.message);}event.target.value='';});
    document.getElementById('pilot-dialog').addEventListener('close',()=>{if(lastDialogTrigger?.isConnected)lastDialogTrigger.focus();});
    window.addEventListener('hashchange',()=>{rangeEnd=null;render();});
    window.addEventListener('storage',event=>{if(event.key===KEY && event.newValue){if(document.getElementById('pilot-dialog')?.open){announce(t('Another tab changed this project. Finish or cancel this form before reloading.'));return;}state=load();render(false);announce(t('Project updated from another tab.'));}});
    render(false);if(pendingStatus)announce(pendingStatus);
  }
  // Public pure functions support arithmetic/state validation without browser automation.
  window.KLAPS_PILOT={getState:()=>clone(state),getContext:context,navigate,search,saveForm,preferPitch,moveCard,useRecorded,projectBackup,pitchHtml,sanitizeState,normalizeSource,dot,normalized,tc,resetForTest:()=>{state=clone(DATA.seed);}};
  document.addEventListener('DOMContentLoaded',boot,{once:true});
})();
