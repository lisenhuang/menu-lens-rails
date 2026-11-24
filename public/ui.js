import {icons} from './icons.js';
const icon = name=>`<span data-icon="${name}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg></span>`;
const escape = value=>String(value ?? '').replace(/[&<>"']/g, character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
function dateLabel(date) {
  return new Intl.DateTimeFormat('en-NZ',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(date+'T00:00:00Z'));
}
function pinText(pin) {
  return Number.isFinite(pin?.lat) && Number.isFinite(pin?.lng) ? pin.lat+', '+pin.lng : '';
}
function mapsUrl(name,address='',id='',pin) {
  const params = new URLSearchParams({api:'1',query:pinText(pin) || [name,address].filter(Boolean).join(', ')});
  if (id && !/^(osm|venue)-/.test(id)) params.set('query_place_id',id);
  return 'https://www.google.com/maps/search/?'+params;
}
function mapsLink(name,address,id,pin,label='Google Maps') {
  return `<a class="text-link" href="${escape(mapsUrl(name,address,id,pin))}" target="_blank" rel="noopener noreferrer">${label} ${icon('external')}</a>`;
}
const notice = (text,name='info')=>`<p class="notice">${icon(name)}<span>${escape(text)}</span></p>`;
const pagesBack = (href,label)=>`<a class="breadcrumb" href="${href}">${icon('back')} ${label}</a>`;
export {escape, icon, dateLabel, pinText, mapsLink, notice, pagesBack};
