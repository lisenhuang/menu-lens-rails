import {escape, icon, mapsLink, notice, pagesBack, pinText} from './ui.js';
const $ = (selector,root=document)=>root.querySelector(selector);

export function mount(main,mode,id) {
const dialog = document.querySelector('#modal');
function localDate() {
  const now = new Date();
  const local = new Date(now.getTime()-now.getTimezoneOffset()*60000);
  return local.toISOString().slice(0,10);
}
const primary = (label,glyph,options='')=>`<button type="button" class="btn primary" ${options}>${glyph ? icon(glyph) : ''}${label}</button>`;

async function api(path,body) {
  const options = body === undefined ? {signal:AbortSignal.timeout(20000)} : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(115000),
  };
  const response = await fetch('/api'+path,options);
  const json = await response.json().catch(()=>null);
  if (!response.ok) {
    const error = new Error(json?.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return json;
}

function uploadPhotos(id,pages,onProgress) {
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();
    request.upload.onprogress=event=>{
      if (event.lengthComputable && event.total>0) onProgress(event.loaded/event.total);
    };
    request.upload.onload=()=>onProgress(1);
    function unconfirmed() {
      const error=new Error('We couldn’t confirm the upload. Check its status before trying again.');
      error.progressPath='/menu/'+id;
      reject(error);
    }
    request.onload=()=>{
      if (request.status===202 && request.response?.id===id) return resolve();
      if (request.response?.code==='generation_paused') return reject(new Error(request.response.error));
      if (!request.response?.error || request.status>=500) return unconfirmed();
      reject(new Error(request.response.error));
    };
    request.onerror=request.ontimeout=unconfirmed;
    request.open('POST','/api/jobs/'+id+'/upload');
    request.responseType='json';
    request.timeout=5*60_000;
    request.setRequestHeader('Content-Type','application/json');
    request.send(JSON.stringify({pages}));
  });
}

function progressFeedback(id) {
  return `<div class="photo-progress" id="${id}" hidden><span role="status"></span>
    <progress class="progress" aria-label="Photo progress"></progress></div>`;
}
function showPhotoProgress(id,message,fraction=null) {
  const box=document.getElementById(id);
  box.hidden=!message;
  const label=box.querySelector('span'),meter=box.querySelector('progress');
  if (label.textContent!==message) label.textContent=message;
  if (fraction===null) meter.removeAttribute('value');else meter.value=fraction;
}

let toastTimer;
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{element.hidden=true;},3000);
}
async function share(label='Menu link') {
  const url = location.href.split('#')[0];
  try {
    await navigator.clipboard.writeText(url);
    toast(label+' copied');
  } catch {
    showModal(label,'link',`<label class="field">${label}<input class="control" value="${escape(url)}" readonly></label>`);
    dialog.querySelector('input').select();
  }
}
function showModal(title,glyph,body) {
  dialog.setAttribute('aria-labelledby','modal-title');
  dialog.innerHTML = `<button class="icon-button modal-close" type="button" aria-label="Close">${icon('close')}</button>
    <div class="modal-icon">${icon(glyph)}</div><h2 id="modal-title">${title}</h2>${body}`;
  $('.modal-close',dialog).addEventListener('click',()=>dialog.close());
  if (!dialog.open) dialog.showModal();
}
function page(title,kicker,intro,body,back='') {
  main.innerHTML = `<div class="page">${back}<div class="page-heading"><p class="eyebrow page-kicker">${kicker}</p>
    <h1 class="page-title">${title}</h1><p class="page-intro">${intro}</p></div>${body}</div>`;
}

const state = {
  step:1, files:[], preparing:null, name:'',address:'',date:localDate(),place:null, position:null,
  manualPin:'',config:null,
};
let flow,configRequest;
function buildFlow() {
  document.title = 'Create a visual menu · Menu Lens';
  page('Create a visual menu','FROM PAPER TO PICTURE','Upload your photos and choose the restaurant. Menu Lens reads the dishes and prices, illustrates the menu and publishes it for you.',
    `<div class="flow"><section class="panel" id="flow"></section>
      <aside class="panel side-panel"><h3>Before you upload</h3><ul>
      <li>${icon('camera')} <span>Capture the page straight on and check that prices are readable.</span></li>
      <li>${icon('pin')} <span>Use the address of the exact restaurant branch.</span></li>
      <li>${icon('globe')} <span>Finished menus include your original menu photos. Your GPS location stays private.</span></li>
      </ul></aside></div>`);
  flow = $('#flow');
  renderStep();
  configRequest=api('/config').then(config=>{
    state.config=config;
    if (state.step===1) updateUpload();
    if (state.step===2) updateLocation();
  }).catch(()=>{
    state.config={generation:false,places:false};
    if (state.step===1) updateUpload();
    if (state.step===2) updateLocation();
  });

}
function renderStep() {
  const labels = ['Photos','Restaurant'];
  flow.innerHTML = `<div class="steps" aria-label="Submission progress">${labels.map((item,i)=>`<span ${state.step===i+1 ? 'aria-current="step"' : ''}><b>${i+1}</b>${item}</span>`).join('')}</div>`;
  [uploadStep,locationStep][state.step-1]();
}
function go(step) {
  state.step=step;
  renderStep();
  const heading = $('h2',flow);
  heading.tabIndex=-1;
  heading.focus({preventScroll:true});
  if (flow.getBoundingClientRect().top<0) flow.scrollIntoView({block:'start'});
}
function errorAt(element,message) {
  element.textContent = message || '';
  element.hidden = !message;
}

function uploadStep() {
  flow.insertAdjacentHTML('beforeend',`
    <h2>Upload menu photos</h2><p class="muted">Choose a menu where at least one dish is missing a photo. Your original pages will be kept and shared when you publish.</p>
    <div class="dropzone" id="drop-zone">${icon('upload')}<strong>Drop your menu photos here</strong><small>Up to 6 JPG, PNG, WebP or HEIC images</small>
    <div class="inline-actions"><button type="button" class="btn primary" id="choose">${icon('plus')} Choose photos</button>
    <button type="button" class="btn quiet" id="camera">${icon('camera')} Take photo</button></div>
    <input id="files" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden>
    <input id="capture" type="file" accept="image/*" capture="environment" hidden></div>
    ${progressFeedback('prepare-progress')}<p class="error" id="upload-error" role="alert" hidden></p><div class="files" id="selected-files"></div>
    <div id="availability"></div><div class="form-actions"><a href="/explore" class="btn text back">Explore menus</a>
    ${primary('Continue',null,'id="next" disabled')}</div>`);
  const drop=$('#drop-zone');
  for (const item of ['files','capture']) {
    $('#'+item).addEventListener('change',event=>{void addFiles(event.target.files);event.target.value='';});
  }
  $('#choose').onclick=()=>$('#files').click();
  $('#camera').onclick=()=>$('#capture').click();
  drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('active');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('active'));
  drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('active');void addFiles(event.dataTransfer.files);});
  $('#next').onclick=()=>go(2);
  updateUpload();
}
function updateUpload() {
  const list=$('#selected-files');
  if (!list) return;
  list.innerHTML=state.files.map((file,i)=>`<div class="file-row"><img src="${file.url}" alt="Preview ${escape(file.name)}"><span class="truncate">${escape(file.name)}</span>
    <button type="button" class="icon-button" data-remove="${i}" aria-label="Remove ${escape(file.name)}">${icon('close')}</button></div>`).join('');
  const batch=state.preparing;
  if (batch) {
    const slots=6-state.files.length;
    const pending=batch.files.slice(batch.index,batch.index+slots);
    list.insertAdjacentHTML('beforeend',pending.map((file,i)=>`<div class="file-row pending-file">
      ${icon('camera')}<span class="truncate">${escape(file.name || 'Menu photo')}</span><small>${i===0?'Preparing…':'Waiting'}</small></div>`).join(''));
    const total=batch.index+pending.length;
    showPhotoProgress('prepare-progress',`Preparing photo ${batch.index+1} of ${total} on this device…`,batch.index ? batch.index/total : null);
  } else {
    showPhotoProgress('prepare-progress','');
  }
  $('#choose').disabled=$('#camera').disabled=Boolean(batch);
  list.querySelectorAll('button').forEach(button=>button.onclick=()=>{
    URL.revokeObjectURL(state.files[Number(button.dataset.remove)].url);
    state.files.splice(Number(button.dataset.remove),1);
    updateUpload();
  });
  const unavailable=state.config?.generation===false || state.config?.submissionsPaused;
  $('#next').disabled=!state.files.length || Boolean(batch) || Boolean(unavailable);
  $('#availability').innerHTML=unavailable ?
    notice('Menu submissions are temporarily unavailable. Please try again later.') : '';
}
async function addFiles(files) {
  if (state.preparing) return;
  const input=Array.from(files);
  if (!input.length) return;
  const messages=[];
  errorAt($('#upload-error'),'');
  for (const [index,file] of input.entries()) {
    if (state.files.length>=6) {
      messages.push('A submission can include up to six pages.');
      break;
    }
    state.preparing={files:input,index};
    updateUpload();
    try {
      if (file.size>22_000_000) throw new Error('too large');
      const blob=await preparePhoto(file);
      state.files.push({name:file.name || 'Menu photo',blob,url:URL.createObjectURL(blob)});
    } catch {
      messages.push(`${file.name || 'The photo'} could not be opened. Try a JPG, PNG or WebP file under 22 MB.`);
    }
  }
  state.preparing=null;
  updateUpload();
  errorAt($('#upload-error'),messages.join(' '));
}
async function preparePhoto(file) {
  const url=URL.createObjectURL(file);
  try {
    const picture=new Image();
    picture.src=url;
    await picture.decode();
    if (!picture.naturalWidth || !picture.naturalHeight) throw new Error('Image is empty');
    const canvas=document.createElement('canvas');
    const scale=Math.min(1,2000/Math.max(picture.naturalWidth,picture.naturalHeight));
    canvas.width=Math.round(picture.naturalWidth*scale);
    canvas.height=Math.round(picture.naturalHeight*scale);
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#ffffff';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(picture,0,0,canvas.width,canvas.height);
    for (const quality of [.88,.76,.62]) {
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
      if (blob && blob.size<=1_650_000) return blob;
    }
    throw new Error('Image is too large');
  } finally {URL.revokeObjectURL(url);}
}
const dataUrl = blob=>new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onload=()=>resolve(reader.result);
  reader.onerror=reject;
  reader.readAsDataURL(blob);
});

function locationStep() {
  flow.insertAdjacentHTML('beforeend',`
    <h2>Find the restaurant</h2><p class="muted">Search by name, then choose a branch to fill in its location.</p>
    <form id="location-form" class="fields">
      <fieldset id="restaurant-fields" class="restaurant-fields">
      <label class="field">Restaurant name<input class="control" id="restaurant-name" required maxlength="180" enterkeyhint="search" value="${escape(state.name)}" placeholder="e.g. Ortega Fish Shack"></label>
      <div class="inline-actions">
        <button type="button" class="btn quiet small" id="place-search">${icon('search')} Search restaurants</button>
        <button type="button" class="btn quiet small" id="gps">${icon('locate')} Use my location</button>
        <span id="map-link"></span>
      </div>
      <div id="place-results" class="search-results" aria-live="polite"></div>
      <p id="location-status" class="field-hint" aria-live="polite"></p>
      <label class="field">Restaurant address <span class="field-hint">Optional. A street or suburb helps identify the branch.</span><input class="control" id="restaurant-address" maxlength="400" value="${escape(state.address)}" placeholder="Street address, city"></label>
      <details id="pin-details"><summary class="field-hint">Restaurant map pin</summary>
        <label class="field">Map coordinates <span class="field-hint">Copy latitude and longitude from the restaurant pin.</span>
          <input class="control" id="pin-coordinates" value="${escape(state.manualPin || '')}" placeholder="-41.294, 174.784" autocomplete="off">
        </label>
      </details>
      <label class="field">Date photographed<input class="control" type="date" id="menu-date" min="1900-01-01" max="${localDate()}" required value="${escape(state.date)}"></label>
      <div id="distance"></div></fieldset>
      <p class="field-hint">We check the restaurant name and address against public sources before uploading your photos.</p>
      <p>By choosing <strong>Generate &amp; publish</strong>, you agree to make the restaurant details, dish prices and your original menu photos public. Your menu is public as soon as the first dish photo is ready. The original pages appear when all illustrations are ready. Only upload photos you have permission to share.</p>
      <div id="challenge" aria-label="Human verification"></div>
      <div id="address-review" hidden></div>
      ${progressFeedback('transfer-progress')}<p class="error" id="step-error" role="alert" hidden></p>
      <div class="form-actions"><button type="button" class="btn text back" id="back">${icon('back')} Photos</button>
        <button type="submit" id="generate" class="btn primary" disabled>${icon('sparkles')} Generate &amp; publish</button></div>
    </form>`);
  let searchVersion=0;
  const results=$('#place-results');
  function clearResults() {
    searchVersion++;
    results.replaceChildren();
    $('#place-search').disabled=false;
  }
  function captureEdit(key,field) {
    $(field).addEventListener('input',event=>{
      clearResults();
      if (key==='manualPin' && state.manualPin && state.address===state.manualPin) {
        state.address=$('#restaurant-address').value=event.target.value;
      }
      if (key==='name' && state.place) state.address=$('#restaurant-address').value='';
      const addingStreetAddress=key==='address' && state.place?.fullAddress===false;
      if (!addingStreetAddress) {
        if (state.place && key!=='manualPin') state.manualPin=$('#pin-coordinates').value='';
        state.place=null;
      }
      state[key]=event.target.value;
      updateLocation();
    });
  }
  captureEdit('name','#restaurant-name');
  captureEdit('address','#restaurant-address');
  captureEdit('manualPin','#pin-coordinates');
  $('#menu-date').addEventListener('input',event=>{state.date=event.target.value;});
  const searchButton=$('#place-search');
  async function findPlaces() {
    if (searchButton.disabled) return;
    const query=state.name.trim();
    if (query.length<2) {
      results.textContent='Enter at least two characters to search.';
      return;
    }
    const version=++searchVersion;
    searchButton.disabled=true;
    results.textContent='Searching restaurants…';
    try {
      const result=await api('/places',{query});
      if (results.isConnected && version===searchVersion) renderPlaces(results,result);
    } catch {
      if (results.isConnected && version===searchVersion) results.textContent='Restaurant search is unavailable. Try again or enter the address below.';
    } finally {
      if (version===searchVersion) searchButton.disabled=false;
    }
  }
  searchButton.onclick=findPlaces;
  $('#restaurant-name').onkeydown=event=>{
    if (event.key==='Enter' && !event.isComposing && !searchButton.hidden) {
      event.preventDefault();
      void findPlaces();
    }
  };
  $('#gps').onclick=requestLocation;
  setupGeneration($('#location-form'));
  updateLocation();
}
function restaurantPin() {
  const source=state.place;
  if (Number.isFinite(source?.lat) && Number.isFinite(source?.lng)) return {lat:source.lat,lng:source.lng};
  const match=state.manualPin?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match || Math.abs(+match[1])>90 || Math.abs(+match[2])>180) return null;
  return {lat:+match[1],lng:+match[2]};
}
function distanceMessage() {
  const pin=restaurantPin();
  const gps=state.position;
  if (!gps || !pin) return '';
  const radians=degrees=>degrees*Math.PI/180;
  const deltaLat=radians(pin.lat-gps.lat);
  const deltaLng=radians(pin.lng-gps.lng);
  const a=Math.sin(deltaLat/2)**2+Math.cos(radians(gps.lat))*Math.cos(radians(pin.lat))*Math.sin(deltaLng/2)**2;
  const distance=12742*Math.asin(Math.min(1,Math.sqrt(a)));
  const km = distance<.1 ? 'less than 100 m' : new Intl.NumberFormat('en-NZ',{maximumFractionDigits:distance<20?1:0}).format(distance)+' km';
  return gps.accuracy>1500 ? `Based on your approximate location, this branch is about ${km} away.` :
    `This restaurant is ${km} from your location.`;
}
function updateLocation() {
  if (!$('#map-link')) return;
  const name=state.name.trim();
  $('#map-link').innerHTML=name ? mapsLink(name,state.address || 'New Zealand',state.place?.id,restaurantPin(),
    state.place ? 'View branch on Google Maps' : 'Search Google Maps') : '';
  $('#place-search').hidden=state.config?.places===false;
  $('#location-status').textContent=state.gpsMessage || (state.config?.places===false ?
    'Use the Google Maps link to look up the address, then enter it here.' :
    'Location helps check the distance to the branch. Your GPS stays on this device.');
  const message=distanceMessage();
  $('#distance').textContent=message;
}
function requestLocation() {
  if (!navigator.geolocation) {
    state.gpsMessage='Location is unavailable. You can enter the address directly.';
    return updateLocation();
  }
  $('#gps').disabled=true;
  $('#location-status').textContent='Checking your location…';
  const finish=()=>{
    if (state.step===2) {
      $('#gps').disabled=false;
      updateLocation();
    }
  };
  navigator.geolocation.getCurrentPosition(({coords})=>{
    state.position={lat:coords.latitude,lng:coords.longitude,accuracy:coords.accuracy};
    state.gpsMessage='Location is available for this submission.';
    finish();
  },()=>{
    state.gpsMessage='Location was unavailable. You can enter the address directly.';
    finish();
  },{enableHighAccuracy:false,timeout:10000,maximumAge:120000});
}
function renderPlaces(list,{places,source}) {
  if (!places.length) {
    list.textContent='No matches in this directory. Try a suburb or city, or use Search Google Maps above.';
    return;
  }
  list.innerHTML=`<strong>${places.length===1?'1 match':places.length+' matches'} · Choose your branch</strong>`
    + places.map((place,i)=>`<button type="button" class="place-result" data-place="${i}">${icon('pin')}<span><strong>${escape([place.name,place.branch].filter(Boolean).join(' · '))}</strong><small>${escape(place.address || 'Map pin · '+pinText(place))}</small></span></button>`).join('')
    + (source==='osm' ? '<a class="maps-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>' :
      source==='google' ? '<span class="maps-attribution" translate="no">Google Maps</span>' : '');
  const attributions=new Map(places.flatMap(place=>place.attributions||[]).map(item=>[item.provider,item.providerUri]));
  for (const [name,url] of attributions) {
    if (name && /^https?:\/\//.test(url)) list.insertAdjacentHTML('beforeend',`<a class="maps-attribution" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(name)}</a>`);
  }
  list.querySelectorAll('button').forEach(button=>button.onclick=()=>{
    const place=places[Number(button.dataset.place)];
    state.place=place;
    state.manualPin=$('#pin-coordinates').value=pinText(place);
    state.name=$('#restaurant-name').value=place.name;
    state.address=$('#restaurant-address').value=place.address || state.manualPin;
    list.textContent=place.fullAddress===false ? 'Restaurant pin selected. You can add a street address if you know it.' : 'Branch location filled in.';
    errorAt($('#step-error'),'');
    updateLocation();
    $('#menu-date').focus({preventScroll:true});
  });
}

let turnstileScript;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileScript) turnstileScript=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async=true;
    script.onload=resolve;
    script.onerror=()=>{turnstileScript=null;script.remove();reject(new Error('The human check could not load.'));};
    document.head.append(script);
  });
  return turnstileScript;
}
function showAddressReview(review,check,restaurant) {
  const copy={
    ambiguous:['Which branch is on your menu?', 'Choose the location where this menu was photographed.'],
    mismatch:['Check the restaurant address', 'We found a published address for this restaurant. Choose the address to show on the menu.'],
    unverified:['Confirm the restaurant address', 'We couldn’t verify this location from public sources. You can confirm it yourself and continue.'],
  };
  const [title,hint]=copy[check.status];
  const options=check.options.map(({label,address,sourceUrl},i)=>`
    <div class="address-option"><label><input type="radio" name="address-choice" value="${i}">
      <span><strong>${escape(label)}</strong><span>${escape(address)}</span></span></label>
      <a class="text-link address-source" href="${escape(sourceUrl)}" target="_blank" rel="noopener noreferrer">Source · ${escape(new URL(sourceUrl).hostname.replace(/^www\./,''))}</a></div>`).join('');
  review.innerHTML=`<fieldset class="address-panel" aria-describedby="address-hint">
    <legend tabindex="-1">${title}</legend><p id="address-hint" class="muted">${hint}</p>
    ${options}
    <div class="address-option"><label><input type="radio" name="address-choice" value="entered">
      <span><strong>${restaurant.address?'Use the address I entered':'Confirm an address myself'}</strong>
      ${restaurant.address?'<span>'+escape(restaurant.address)+'</span>':''}</span></label>
      ${restaurant.address?'':'<label class="field manual-address" hidden>Restaurant street address<input id="confirmed-address" class="control" maxlength="400" placeholder="Street address, city"></label>'}</div>
    <button type="button" id="edit-restaurant" class="text-link">Edit restaurant details</button></fieldset>`;
  review.hidden=false;
  review.querySelector('legend').focus();
}
async function setupGeneration(form) {
  const target=$('#challenge',form);
  const error=$('#step-error',form);
  const button=$('#generate',form);
  const back=$('#back',form);
  const fields=$('#restaurant-fields',form);
  const review=$('#address-review',form);
  let token='',widget,busy=false,verified=null,confirmed=false;
  const selected=()=>review.querySelector('input[name="address-choice"]:checked')?.value;
  function sync() {
    const manual=$('#confirmed-address',form);
    const choice=selected();
    if (manual) manual.closest('label').hidden=choice!=='entered';
    const canSubmit=verified ? confirmed || (choice!==undefined && (choice!=='entered' || !manual || manual.value.trim())) : token;
    button.disabled=busy || !canSubmit;
    back.disabled=busy;
    const panel=review.querySelector('fieldset');
    if (panel) panel.disabled=busy;
  }
  function editRestaurant() {
    verified=null;
    confirmed=false;
    fields.disabled=false;
    review.hidden=true;
    review.replaceChildren();
    target.hidden=false;
    token='';
    errorAt(error,'');
    window.turnstile.reset(widget);
    button.innerHTML=icon('sparkles')+' Generate &amp; publish';
    sync();
    $('#restaurant-address',form).focus();
  }
  review.oninput=sync;
  back.onclick=()=>{
    if (busy) return;
    if (widget!==undefined) window.turnstile.remove(widget);
    go(1);
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    if (busy || button.disabled) return;
    if (!verified && state.manualPin.trim() && !restaurantPin()) {
      errorAt(error,'Use a latitude and longitude separated by a comma, such as -41.294, 174.784.');
      return;
    }
    errorAt(error,'');
    busy=true;
    fields.disabled=true;
    sync();
    try {
      if (!verified) {
        button.textContent='Checking address…';
        showPhotoProgress('transfer-progress','Checking the restaurant address against public sources…');
        verified=await api('/verify',{name:state.name,address:state.address,date:state.date,
          placeId:state.place?.id,pin:restaurantPin(),consent:true,shareOriginals:true,autoPublish:true,token});
        target.hidden=true;
        confirmed=verified.addressCheck.status==='match';
        if (!confirmed) {
          showPhotoProgress('transfer-progress','');
          showAddressReview(review,verified.addressCheck,state);
          $('#edit-restaurant',form).onclick=editRestaurant;
          button.textContent='Confirm & publish';
          return;
        }
      }
      if (!confirmed) {
        const choice=selected();
        await api('/jobs/'+verified.id+'/confirm-address',{choice:choice==='entered'?choice:Number(choice),
          address:$('#confirmed-address',form)?.value.trim()});
        confirmed=true;
      }
      review.hidden=true;
      button.textContent='Submitting…';
      showPhotoProgress('transfer-progress','Preparing upload…');
      const pages=await Promise.all(state.files.map(file=>dataUrl(file.blob)));
      showPhotoProgress('transfer-progress','Uploading photos…');
      await uploadPhotos(verified.id,pages,fraction=>{
        if (fraction>=1) showPhotoProgress('transfer-progress','Saving uploaded photos…');
        else showPhotoProgress('transfer-progress',`Uploading photos · ${Math.floor(fraction*100)}%`,fraction);
      });
      location.assign('/menu/'+verified.id);
    } catch(err) {
      showPhotoProgress('transfer-progress','');
      if (!verified) editRestaurant();
      if (confirmed) button.textContent='Retry upload';
      errorAt(error,err.message);
      if (err.progressPath) {
        const link=document.createElement('a');
        link.className='text-link';
        link.href=err.progressPath;
        link.textContent='Open upload progress';
        error.append(' ',link);
      }
    } finally {
      busy=false;
      sync();
    }
  };
  await configRequest;
  if (!form.isConnected) return;
  if (!state.config?.generation || state.config.submissionsPaused) {
    errorAt(error,'New menu generation is temporarily unavailable.');
    return;
  }
  try {
    await loadTurnstile();
    if (!form.isConnected) return;
    widget=window.turnstile.render(target,{
      sitekey:state.config.siteKey,action:'menu_submit',theme:getComputedStyle(document.documentElement).colorScheme==='dark'?'dark':'light',
      size:matchMedia('(max-width: 375px)').matches?'compact':'normal',
      callback:value=>{token=value;sync();},
      'expired-callback':()=>{token='';sync();},
      'error-callback':()=>{token='';sync();errorAt(error,'The human check failed to load. Please try again.');},
    });
  } catch(err) {if (form.isConnected) errorAt(error,err.message);}
}

const labels={waiting:'Waiting to read',reading:'Reading the menu',review:'Ready to generate',
  uploading:'Uploading photos',already_illustrated:'Every dish already has a photo',read_error:'Menu reading stopped',queued:'Waiting for illustrations',running:'Illustrating dishes',
  error:'Images need attention',complete:'Published'};
const imageCount=job=>`${job.completed} of ${job.total} dish images ready`;
const liveStates=new Set(['uploading','waiting','reading','queued','running']);
function statusLabel(job) {
  if (job.state==='running') return job.completed===job.total?'Publishing menu':imageCount(job);
  if (job.state==='reading') {
    const count=job.pageCount;
    if (!job.transcribing) return 'Opening menu photos';
    return count ? `Reading ${count} menu ${count===1?'photo':'photos'}` : 'Reading menu photos';
  }
  return labels[job.state] || 'Checking progress';
}

// Reconnect from a full snapshot so missed events and server restarts need no replay.
function watchJob(id,onStatus,onError) {
  const path='/jobs/'+id;
  let source,timer,last,revision=0,finished=false;
  function disconnect() {
    revision++;
    clearTimeout(timer);
    source?.close();
    source=null;
  }
  function stop() {
    finished=true;
    disconnect();
    document.removeEventListener('visibilitychange',resume);
    window.removeEventListener('pagehide',disconnect);
    window.removeEventListener('pageshow',resume);
    window.removeEventListener('online',resume);
  }
  function failure(error,rev) {
    if (rev!==revision || finished) return;
    last=undefined;
    disconnect();
    onError(error);
    if (error.status===404 || error.status===403) return stop();
    if (!document.hidden) timer=setTimeout(refresh,4000);
  }
  async function accept(job,rev) {
    if (rev!==revision || finished) return;
    const active=liveStates.has(job.state) || (job.state==='error' && job.completed>0);
    if (!active) {source?.close();source=null;}
    const signature=JSON.stringify(job);
    if (last!==signature) {
      await onStatus(job);
      if (rev!==revision) return;
      last=signature;
    }
    if (!active) return stop();
    if (source) return;
    if (!window.EventSource) {timer=setTimeout(refresh,3500);return;}
    source=new EventSource('/api'+path+'/events');
    let delivery=Promise.resolve();
    source.onmessage=event=>{
      delivery=delivery.then(()=>accept(JSON.parse(event.data),rev)).catch(error=>failure(error,rev));
    };
    source.onerror=()=>failure(new Error('Live connection interrupted.'),rev);
  }
  async function refresh() {
    disconnect();
    const rev=revision;
    if (finished || document.hidden) return;
    try {await accept(await api(path),rev);}
    catch(error) {failure(error,rev);}
  }
  function resume() {if (!finished) void refresh();}
  document.addEventListener('visibilitychange',resume);
  window.addEventListener('pagehide',disconnect);
  window.addEventListener('pageshow',resume);
  window.addEventListener('online',resume);
  void refresh();
  return stop;
}
async function openSubmission(id) {
  const path='/jobs/'+id;
  const back=pagesBack('/explore','Explore menus');
  watchJob(id,async job=>{
    if (job.completed>0 || job.state==='complete') {
      location.reload();
      return;
    }
    const images=Number.isInteger(job.total);
    const active=liveStates.has(job.state);
    const publishing=job.state==='running' && job.completed===job.total;
    const title=publishing?'Publishing menu':job.state==='running'?'Illustrating dishes':statusLabel(job);
    const messages={
      uploading:'Keep the upload page open until your photos have been received.',
      waiting:'Your photos are saved. Reading will start when the previous menu finishes.',
      reading:job.transcribing?'Checking dish names, prices and which dishes already have photos.':'Retrieving your photos for menu reading.',
      review:'This saved draft is private. Generate and publish it to share the dishes, prices and original photos.',
      queued:'Your menu is in the illustration queue.',
      running:job.illustrating?.length ? 'Working on '+job.illustrating.join(' and ')+'.' : 'Preparing the next illustrations for your menu.',
      error:'Generation stopped before all the images were ready. Completed illustrations have been saved.',
    };
    const message=publishing?'All dish images are ready.':job.error || messages[job.state] || '';
    if (!$('#job-panel')) {
      page(escape(job.name),'MENU SUBMISSION','',`<section class="panel progress-panel" id="job-panel">
        <ol class="job-stages" aria-label="Menu progress">${['Read menu','Illustrate','Publish'].map(label=>`<li><span></span>${label}</li>`).join('')}</ol>
        <div aria-live="polite" aria-atomic="true"><h2 id="job-title"></h2><p id="job-message" class="muted"></p><strong id="image-count"></strong></div>
        <progress id="job-meter" class="progress" aria-label="Menu progress"></progress>
        <p class="field-hint" id="job-return"></p><p class="error" id="job-error" role="status" hidden></p>
        <div class="inline-actions"><button class="btn quiet" id="save-link">${icon('link')} Copy return link</button>
        ${primary('Generate &amp; publish','sparkles','id="generate-draft" hidden')}
        ${primary('Retry remaining images','sparkles','id="retry" hidden')}<a class="btn primary" href="/create" id="new-upload" hidden>Upload another menu</a></div></section>`,back);
      $('#save-link').onclick=()=>share('Return link');
    }
    const step=publishing?2:images?1:0;
    document.querySelectorAll('.job-stages li').forEach((el,i)=>{
      el.classList.toggle('past',i<step);
      el.classList.toggle('stopped',i===step && !active);
      if (i===step) el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');
    });
    $('#job-title').textContent=title;
    $('#job-message').textContent=message;
    $('#image-count').textContent=images?imageCount(job):'';
    const meter=$('#job-meter');
    meter.hidden=!active && !images;
    if (images) {meter.max=job.total;meter.value=job.completed;} else meter.removeAttribute('value');
    $('#job-return').textContent=active && job.state!=='uploading' ? 'You can close this page. Save the link to return to your menu.' : '';
    if (job.state==='read_error' && job.pageCount) {
      const until=new Date(job.expires).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
      $('#job-return').textContent=`Your photos are private until ${until}. `+(job.canRetryRead?'You can retry with these photos.':'This draft has used all three reading attempts.');
    }
    const generate=$('#generate-draft');
    generate.hidden=job.state!=='review';
    generate.onclick=async()=>{
      generate.disabled=true;
      try {
        await api(path+'/publish',{useTranscription:true});
        void openSubmission(id);
      } catch(error) {errorAt($('#job-error'),error.message);generate.disabled=false;}
    };
    const retry=$('#retry');
    retry.hidden=!job.canRetry && !job.canRetryRead;
    retry.textContent=job.canRetryRead?'Retry reading menu':'Retry remaining images';
    retry.onclick=async()=>{
      retry.disabled=true;
      try {
        if (job.canRetryRead) await api(path+'/retry-read',{attempt:job.readAttempt});
        else await api(path+'/retry',{});
        void openSubmission(id);
      } catch(error) {errorAt($('#job-error'),error.message);retry.disabled=false;}
    };
    $('#new-upload').textContent=job.pageCount && job.state==='read_error'?'Choose different photos':job.state==='read_error'?'Upload photos again':'Upload another menu';
    $('#new-upload').className=job.canRetryRead?'btn quiet':'btn primary';
    $('#new-upload').hidden=!['already_illustrated','read_error'].includes(job.state);
    errorAt($('#job-error'),'');
    document.title=title+' · '+job.name+' · Menu Lens';
  },error=>{
    if (error.status===404 || error.status===403) {
      page('Menu unavailable','MENU LENS','Open private drafts in the browser you used to upload. Drafts expire after 24 hours.',
        '<a href="/explore" class="btn quiet">Explore published menus</a>',back);
    } else if ($('#live-message')) {
      errorAt($('#live-message'),'Reconnecting to photo updates…');
    } else if ($('#job-error')) {
      errorAt($('#job-error'),'Connection interrupted. Reconnecting…');
    } else {
      page('Checking your menu','MENU LENS','Reconnecting to your submission…','',back);
    }
  });
}


if (mode==='admin') void import('./admin.js').then(({openAdmin})=>openAdmin({api,page,loadTurnstile,escape}));
else if (mode==='create') buildFlow();
else if (mode==='progress') void openSubmission(id);
}
