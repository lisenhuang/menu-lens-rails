import {Turbo} from '/turbo.min.js';
import {Application, Controller} from '/stimulus.min.js';
import {icons} from '/icons.js';

const app = Application.start();

class SearchController extends Controller {
  submit() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.element.requestSubmit(), 180);
  }
  disconnect() { clearTimeout(this.timer); }
}
app.register('search', SearchController);

function enhance(root) {
  for (const element of root.querySelectorAll('[data-icon]:empty')) {
    const drawing = icons[element.dataset.icon];
    if (drawing) element.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+drawing+'</svg>';
  }
}
class ShellController extends Controller {
  connect() {
    this.abort = new AbortController();
    const on = (el,type,fn) => el.addEventListener(type,fn,{signal:this.abort.signal});
    const picker = this.element.querySelector('.theme');
    const sync = () => {
      const mode = document.documentElement.dataset.theme || 'system';
      const radio = picker.querySelector('input[value="'+mode+'"]');
      radio.checked = true;
      const trigger = picker.querySelector('summary');
      trigger.innerHTML = '<span data-icon="'+({system:'sunMoon',light:'sun',dark:'moon'}[mode])+'"></span>';
      trigger.setAttribute('aria-label','Change theme (currently '+mode+')');
      enhance(picker);
    };
    sync();
    on(picker,'change',event=>{
      const mode = event.target.value;
      if (mode==='system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme=mode;
      try { localStorage.setItem('menu-lens-theme',mode); } catch {}
      picker.open=false;
      sync();
    });
    on(document,'click',event=>{ if (!picker.contains(event.target)) picker.open=false; });
    on(picker,'focusout',event=>{ if (event.relatedTarget && !picker.contains(event.relatedTarget)) picker.open=false; });
    on(picker,'keydown',event=>{ if(event.key==='Escape'){picker.open=false;picker.querySelector('summary').focus();} });
    enhance(this.element);
    on(document,'turbo:frame-load',event=>enhance(event.target));
    const viewer=this.element.querySelector('#image-viewer');
    const stage=viewer.querySelector('.image-stage');
    const photo=stage.querySelector('img');
    on(this.element,'click',event=>{
      const link=event.target.closest('a[data-view-image]');
      if (!link || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      this.opener=link;
      photo.src=link.href;
      photo.alt=link.querySelector('img')?.alt || '';
      viewer.showModal();
      if (document.fullscreenEnabled) stage.requestFullscreen().catch(()=>{});
    });
    on(stage,'click',()=>viewer.close());
    on(document,'fullscreenchange',()=>{
      if(document.fullscreenElement===stage) this.fullscreen=true;
      else if(this.fullscreen && viewer.open){this.fullscreen=false;viewer.close();}
    });
    on(viewer,'close',()=>{
      if(document.fullscreenElement===stage) document.exitFullscreen().catch(()=>{});
      photo.removeAttribute('src');
      this.opener?.focus({preventScroll:true});
    });
  }
  disconnect() { this.abort.abort(); }
}
app.register('shell', ShellController);

class MenuController extends Controller {
  static values = {id:String,live:Boolean};
  connect() {
    if (!this.liveValue) return;
    this.source=new EventSource('/api/jobs/'+this.idValue+'/events?view=turbo');
    Turbo.connectStreamSource(this.source);
    this.observer=new MutationObserver(()=>{
      this.filter();
      enhance(this.element);
      if(this.element.querySelector('#visual-menu')?.dataset.state==='complete') this.disconnect();
    });
    this.observer.observe(this.element,{childList:true,subtree:true,attributes:true,attributeFilter:['data-state']});
  }
  disconnect() {
    this.observer?.disconnect();
    if(this.source){Turbo.disconnectStreamSource(this.source);this.source.close();this.source=null;}
  }
  filter(){
    const checkbox=this.element.querySelector('#ready-filter');
    this.readyOnly=checkbox ? (document.activeElement===checkbox ? checkbox.checked : this.readyOnly ?? checkbox.checked) : false;
    if(checkbox) checkbox.checked=this.readyOnly;
    for(const section of this.element.querySelectorAll('.menu-section')){
      const cards=Array.from(section.querySelectorAll('.dish-card'));
      for(const card of cards) card.hidden=Boolean(this.readyOnly && card.querySelector('.dish-pending'));
      section.hidden=cards.every(card=>card.hidden);
    }
  }
  async share(){
    const url=location.href.split('#')[0], toast=document.querySelector('#toast');
    try{await navigator.clipboard.writeText(url);toast.textContent='Menu link copied';toast.hidden=false;setTimeout(()=>toast.hidden=true,3000);}
    catch{window.prompt('Copy menu link',url);}
  }
  async retry(event){
    event.target.disabled=true;
    try{
      const response=await fetch('/api/jobs/'+this.idValue+'/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if(!response.ok) throw new Error((await response.json()).error);
    }catch(error){event.target.disabled=false;const toast=document.querySelector('#toast');toast.textContent=error.message;toast.hidden=false;}
  }
}
app.register('menu',MenuController);

class WorkspaceController extends Controller {
  static values={mode:String,id:String};
  async connect() {
    const {mount}=await import('/workspace.js');
    if(this.element.isConnected) mount(this.element,this.modeValue,this.idValue);
  }
}
app.register('workspace',WorkspaceController);
