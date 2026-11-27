export async function openAdmin({api,page,loadTurnstile,escape}) {
  const guide='https://developers.openai.com/api/docs/guides/image-generation#calculating-costs';
  document.title='Generation settings · Menu Lens';
  function view(title,intro,content) {
    page(title,'MENU LENS ADMIN',intro,content);
  }
  async function login() {
    view('Admin sign-in','Sign in to manage how menus are generated.',`
      <form class="panel admin-panel fields" id="admin-login" method="post" action="/api/admin/login">
        <label class="field">PIN<input class="control" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6}" maxlength="6" required></label>
        <div id="admin-check" aria-label="Human verification"></div>
        <p class="error" role="alert" id="login-message"></p>
        <button class="btn primary" type="submit" disabled>Sign in</button>
      </form>`);
    const form=document.querySelector('#admin-login');
    const pin=form.elements.pin;
    const button=form.querySelector('button');
    const message=form.querySelector('#login-message');
    let token='',busy=false,widget;
    const sync=()=>{button.disabled=busy || !token || !pin.validity.valid;};
    pin.addEventListener('input',sync);
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if (busy || !token || !pin.validity.valid) return;
      busy=true;
      sync();
      message.textContent='';
      try {
        await api('/admin/login',{pin:pin.value,token});
        pin.value='';
        window.turnstile.remove(widget);
        await loadSettings();
      } catch(error) {
        message.textContent=error.message;
        pin.value='';
        pin.focus();
        token='';
        window.turnstile.reset(widget);
      } finally {busy=false;sync();}
    });
    try {
      const {siteKey}=await api('/config');
      if (!siteKey) throw new Error('Human verification is unavailable.');
      await loadTurnstile();
      widget=window.turnstile.render('#admin-check',{sitekey:siteKey,action:'admin_login',theme:'auto',size:'flexible',
        callback:value=>{token=value;message.textContent='';sync();},
        'expired-callback':()=>{token='';sync();},
        'error-callback':()=>{token='';message.textContent='Human verification could not load. Refresh to try again.';sync();},
      });
    } catch(error) {message.textContent=error.message;}
  }
  function settingsForm(data) {
    const {imageModels,readingModels}=data;
    let saved=data.settings;
    const options=values=>values.map(v=>`<option value="${escape(v)}">${escape(v)}</option>`).join('');
    view('Generation dashboard','Manage generation settings and review costs for each menu.',`
      <div class="admin-layout"><form class="panel admin-panel fields" id="admin-settings">
        <h2>Dish illustrations</h2>
        <label class="field">Image model<select class="control" name="model">${options(Object.keys(imageModels))}</select></label>
        <label class="field">Image quality<select class="control" name="quality"></select></label>
        <div class="admin-estimate"><span>Estimated image output</span>
          <strong><output id="estimate" aria-live="polite"></output> <small>USD / image</small></strong>
          <p>1024 × 1024. Prompt tokens and menu reading are billed separately. <a class="text-link" href="${guide}" target="_blank" rel="noopener noreferrer">OpenAI pricing calculator</a></p>
        </div>
        <h2>Menu reading</h2>
        <label class="field">Menu-reading model<select class="control" name="readingModel">${options(Object.keys(readingModels))}</select></label>
        <small class="field-hint" id="reading-rates"></small>
        <label class="field">Thinking level<select class="control" name="reasoning"></select></label>
        <p class="field-hint">Applies the next time menu photos are read, including retries.</p>
        <p id="admin-message" role="status"></p>
        <div class="inline-actions"><button class="btn primary" type="submit" disabled>Save settings</button>
        <button class="btn quiet" type="button" id="sign-out">Sign out</button></div>
      </form>
      <section class="panel history-panel" aria-labelledby="history-heading">
        <section class="billing-credit" aria-labelledby="billing-heading"><h2 id="billing-heading">OpenAI credit balance</h2>
          <strong id="credit-value"></strong><p class="field-hint" id="credit-checked"></p><p id="credit-cutoff"></p>
          <div><a class="text-link" href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">Open OpenAI Billing ↗</a></div>
        </section>
        <div class="history-heading"><h2 id="history-heading">Generation history</h2><button type="button" id="refresh-history" class="btn quiet small">Refresh</button></div>
        <p class="field-hint">Estimated USD at standard API rates. Open a menu to see each request, including retries.</p>
        <div id="history-list"></div><p id="history-message" role="status"></p>
        <button id="history-more" class="btn quiet small" type="button" hidden>Load older menus</button>
      </section></div>`);
    const form=document.querySelector('#admin-settings');
    const {model,quality,readingModel,reasoning}=form.elements;
    const save=form.querySelector('[type="submit"]'),message=form.querySelector('#admin-message');
    model.value=saved.model;
    readingModel.value=saved.readingModel;
    function reasoningOptions(preferred) {
      const {efforts:levels,input,output}=readingModels[readingModel.value];
      reasoning.innerHTML=options(levels);
      reasoning.value=levels.includes(preferred) ? preferred : 'medium';
      form.querySelector('#reading-rates').textContent=Number.isFinite(input) ?
        `US$${input} per million input tokens and US$${output} per million output tokens at standard rates.` : '';
    }
    reasoningOptions(saved.reasoning);
    function qualityOptions(preferred) {
      const levels=Object.keys(imageModels[model.value]);
      quality.innerHTML=options(levels);
      quality.value=levels.includes(preferred) ? preferred : 'high';
    }
    qualityOptions(saved.quality);
    function sync() {
      const cost=imageModels[model.value][quality.value]*data.outputUsdPerMillion/1e6;
      form.querySelector('#estimate').textContent='$'+cost.toFixed(5);
      save.disabled=model.value===saved.model && quality.value===saved.quality && readingModel.value===saved.readingModel && reasoning.value===saved.reasoning;
    }
    form.addEventListener('change',event=>{
      if (event.target===model) qualityOptions(quality.value);
      if (event.target===readingModel) reasoningOptions(reasoning.value);
      message.textContent='';sync();
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      save.disabled=true;
      try {
        const result=await api('/admin/settings',{model:model.value,quality:quality.value,readingModel:readingModel.value,reasoning:reasoning.value});
        saved=result.settings;
        message.textContent='Settings saved.';
      } catch(error) {
        if (error.status===401) return login();
        message.textContent=error.message;
      } finally {sync();}
    });
    form.querySelector('#sign-out').onclick=async()=>{
      try {await api('/admin/logout',{});await login();}
      catch(error) {if(error.status===401) return login();message.textContent=error.message;}
    };
    sync();
    showBalance(data);
    showHistory();
  }
  function showBalance({balance:record,estimatedBalanceUsd,minimumBalanceUsd,providerBillingBlocked,balanceFeedStatus}) {
    const usd=new Intl.NumberFormat('en-NZ',{style:'currency',currency:'USD',roundingMode:'floor'});
    document.querySelector('#credit-value').textContent=record ? usd.format(record.cents/100) : 'Awaiting first check';
    const checked=record && new Date(record.checked).toLocaleString('en-NZ',{dateStyle:'medium',timeStyle:'short',timeZone:'Pacific/Auckland'});
    const cutoff=document.querySelector('#credit-cutoff');
    if (providerBillingBlocked) {
      cutoff.textContent='AI requests paused by OpenAI billing. Check the credits and limits for this project, then record a fresh balance.';
    } else if (balanceFeedStatus==='stale') {
      cutoff.textContent='AI requests paused. Publish a fresh balance update to resume.';
    } else if (['waiting','unreachable'].includes(balanceFeedStatus)) {
      cutoff.textContent='AI requests paused while waiting for a valid balance feed response.';
    } else if (estimatedBalanceUsd == null) {
      cutoff.textContent='AI requests paused until the credit balance can be verified.';
    } else {
      const status=estimatedBalanceUsd<minimumBalanceUsd ? 'paused' : 'enabled';
      cutoff.textContent=`AI requests ${status}. Estimated available credit ${usd.format(estimatedBalanceUsd)}. Cutoff ${usd.format(minimumBalanceUsd)}.`;
    }
    if (balanceFeedStatus!=='manual') {
      document.querySelector('#credit-checked').textContent=record ? `Balance feed · Reported ${checked} (NZ time)` : 'Waiting for the first balance update.';
      return;
    }
    document.querySelector('#credit-checked').textContent=record ?
      `${record.organization} · Manually checked ${checked} (NZ time)` : 'Check your organization’s balance in OpenAI Billing.';
  }
  function showHistory() {
    const list=document.querySelector('#history-list'),more=document.querySelector('#history-more');
    const refresh=document.querySelector('#refresh-history'),message=document.querySelector('#history-message');
    let cursor=null;
    const currency=amount=>'$'+amount.toFixed(6).replace(/0+$/,'').replace(/\.$/,'.00');
    const when=value=>new Date(value).toLocaleString('en-NZ',{dateStyle:'medium',timeStyle:'short'});
    function entry(run) {
      const partial=run.legacy || run.priced<run.attempts;
      const amount=run.usd===null ? 'Not recorded' : currency(run.usd);
      const basis=run.usd===null ? (run.legacy?'Historical menu':'No priced calls yet') :
        partial ? 'Partial estimate' : run.estimates ? 'Includes output estimates' : 'From reported usage';
      const reference=run.benchmark ? `<p class="field-hint">Output-only benchmark for ${run.benchmark.count} saved images at ${escape(run.benchmark.model)} / ${escape(run.benchmark.quality)}: ${currency(run.benchmark.usd)}. Actual historical charges are unavailable.</p>` : '';
      return `<details class="history-run" data-run="${escape(run.id)}"><summary>
        <span><strong>${escape(run.restaurant)}</strong><small>${escape(when(run.recorded))} · ${escape(run.state)}</small></span>
        <span class="history-price"><strong>${amount}</strong><small>${basis}</small></span></summary>
        <div class="history-details"><p><strong>IP address</strong> ${escape(run.uploadIp || run.imageIp || 'Not recorded')} · <strong>City</strong> ${escape(run.ipCity || 'Not recorded')}</p>
        ${reference}<div class="history-calls"></div></div></details>`;
    }
    function callRow(call) {
      const amount=call.usd===null ? 'Cost unknown' : currency(call.usd);
      return `<li><div><strong>${escape(call.label)}</strong><small>${escape(when(call.started))} · ${escape(call.state)}</small>
        <small>${escape(call.model)} · ${escape(call.level)}</small></div>
        <span class="history-price"><strong>${amount}</strong><small>${escape(call.basis)}</small></span></li>`;
    }
    async function load(older,refreshBalance=false) {
      more.disabled=refresh.disabled=true;
      message.textContent='Loading history…';
      try {
        if (refreshBalance) showBalance(await api('/admin/settings'));
        const {runs,next}=await api('/admin/history'+(older ? '?before='+cursor : ''));
        if (!older) list.replaceChildren();
        for (const run of runs) {
          list.insertAdjacentHTML('beforeend',entry(run));
          const details=list.lastElementChild;
          details.addEventListener('toggle',async()=>{
            if (!details.open || details.dataset.loaded) return;
            const target=details.querySelector('.history-calls');
            details.dataset.loaded='loading';
            target.textContent='Loading requests…';
            try {
              const {calls}=await api('/admin/history/'+run.id);
              target.innerHTML=calls.length ? '<ul>'+calls.map(callRow).join('')+'</ul>' : '<p>No recorded API requests.</p>';
              details.dataset.loaded='yes';
            } catch(error) {
              if (error.status===401) return login();
              delete details.dataset.loaded;
              target.textContent='Could not load requests. Close and reopen to retry.';
            }
          });
        }
        cursor=next;more.hidden=!next;
        message.textContent=list.children.length ? '' : 'No generations yet.';
      } catch(error) {
        if (error.status===401) return login();
        message.textContent=error.message;
      } finally {more.disabled=refresh.disabled=false;}
    }
    more.onclick=()=>load(true);
    refresh.onclick=()=>load(false,true);
    void load(false);
  }
  async function loadSettings() {
    try {settingsForm(await api('/admin/settings'));}
    catch(error) {
      if (error.status===401) return login();
      view('Admin unavailable',escape(error.message),'<a class="btn quiet" href="/admin">Try again</a>');
    }
  }
  view('Generation settings','Loading…','');
  await loadSettings();
}
