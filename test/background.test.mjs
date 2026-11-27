import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomInt,scryptSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {createInterface} from 'node:readline';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const menu={isMenu:true,transcript:'Soup $9',notes:'',warnings:[],dishes:[
  {hasDishPhoto:false,name:'Soup',price:'$9',section:'Lunch',description:''},
]};
const photo='data:image/jpeg;base64,/9j/2Q==';
const webpFixture=Buffer.from('RIFF0000WEBPfixture').toString('base64');

test('private uploads and approved illustrations finish with no client connected and survive restarts',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'menu-lens-'));
  const pin=String(randomInt(1_000_000)).padStart(6,'0');
  const salt=randomBytes(16);
  const verifier=salt.toString('hex')+':'+scryptSync(pin,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('hex');
  const usedChallenges=new Set();
  const objects=new Map();
  let visionResult=menu;
  let readingRequest,imageRequest;
  const imageGates=new Map();
  let imageFails=true;
  let holdImages=true;
  let holdBread=false;
  let holdRead=true;
  let imageCalls=0;
  let readCalls=0;
  let failReading=false;
  let readingBillingError=false;
  let addressReply=null;
  let addressRequests=0;
  const sourceUrl='https://restaurant.example/locations';
  let googleResults=[], placesRequest;
  let feedReport,feedReads=0;
  const provider=createServer(async (req,res)=>{
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const bytes=Buffer.concat(chunks);
    if (req.url==='/credit-feed') {
      feedReads++;
      assert.equal(req.method,'GET');
      assert.equal(req.headers.authorization,undefined);
      assert.equal(req.headers.cookie,undefined);
      res.writeHead(feedReport ? 200 : 503,{'Content-Type':'application/json'});
      return res.end(JSON.stringify(feedReport));
    }
    if (req.url.startsWith('/__storage/')) {
      assert.equal(req.headers.authorization,'Bearer test-storage');
      if (req.method==='PUT') objects.set(req.url,bytes);
      if (req.method==='DELETE') objects.delete(req.url);
      if (['GET','HEAD'].includes(req.method) && !objects.has(req.url)) res.statusCode=404;
      return res.end(req.method==='GET' ? objects.get(req.url) : undefined);
    }
    const body=bytes.toString();
    let response;
    if (req.url==='/turnstile/v0/siteverify') {
      const token=new URLSearchParams(body).get('response');
      const isAdmin=token.startsWith('admin-');
      response={success:!isAdmin || !usedChallenges.has(token),hostname:'localhost',action:isAdmin?'admin_login':'menu_submit'};
      usedChallenges.add(token);
    } else if (req.url==='/v1/places:searchText') {
      placesRequest=JSON.parse(body);
      response={places:googleResults};
    } else if (req.url==='/v1/responses' && JSON.parse(body).tools) {
      const check=JSON.parse(body);
      assert.equal(check.tool_choice,'required');
      const {name,address,...extra}=JSON.parse(check.input);
      assert.deepEqual(extra,{});
      assert.equal(check.store,false);
      addressRequests++;
      if (addressReply?.error) {
        res.statusCode=addressReply.httpStatus;
        return res.end(JSON.stringify({status:'failed',error:addressReply.error}));
      }
      if (addressReply==='offline') {res.statusCode=503;return res.end('{}');}
      const verdict=addressReply || {status:'match',options:[{label:name,address,sourceUrl}]};
      response={status:'completed',usage:{input_tokens:100,output_tokens:20},output:[
        {type:'web_search_call',action:{type:'search',sources:[{url:sourceUrl}]}},
        {content:[{type:'output_text',text:JSON.stringify(verdict)}]},
      ]};
    } else if (req.url==='/v1/responses') {
      readingRequest=JSON.parse(body);
      readCalls++;
      while (holdRead && !res.destroyed) await delay(10);
      if (readingBillingError) {
        res.statusCode=429;
        return res.end(JSON.stringify({error:{code:'insufficient_quota'}}));
      }
      if (failReading) {res.statusCode=503;return res.end('{}');}
      response={status:'completed',usage:{input_tokens:400,input_tokens_details:{cached_tokens:80},output_tokens:95},output:[{content:[{type:'output_text',text:JSON.stringify(visionResult)}]}]};
    } else if (req.url==='/v1/images/generations') {
      imageRequest=JSON.parse(body);
      imageCalls++;
      const {prompt}=imageRequest;
      const bread=prompt.includes('"name":"Bread"');
      while ((holdImages || (holdBread && bread)) && !res.destroyed) await delay(10);
      for (const [name,gate] of imageGates) {
        if (prompt.includes('"name":'+JSON.stringify(name))) {
          gate.calls++;
          res.statusCode=await gate.promise;
          break;
        }
      }
      if (imageFails) res.statusCode=503;
      response=res.statusCode!==200 ? {error:{}} : {data:[{b64_json:webpFixture}],usage:{input_tokens:200,output_tokens:1200}};
    } else throw new Error('Unhandled test provider path');
    res.end(JSON.stringify(response));
  });
  provider.listen(0,'127.0.0.1');
  await once(provider,'listening');
  const providerPort=provider.address().port;
  const reserve=createServer().listen(0,'127.0.0.1');
  await once(reserve,'listening');
  const port=reserve.address().port;
  await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port;
  let child;
  async function stop() {
    if (!child || child.exitCode!==null || child.signalCode) return;
    const stopped=once(child,'exit');
    child.kill('SIGKILL');
    await stopped;
  }
  t.after(async()=>{
    holdRead=false;holdImages=false;holdBread=false;
    await stop();
    provider.closeAllConnections();
    await new Promise(resolve=>provider.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  async function until(fn) {
    for (let i=0;i<600;i++) {
      const result=await fn();
      if (result) return result;
      await delay(25);
    }
    assert.fail('Timed out waiting for the job');
  }
  async function start(creditFeed='') {
    child=spawn('bundle',['exec','puma','-C','config/puma.rb'],{stdio:['ignore','ignore','pipe'],
      env:{...process.env,RAILS_ENV:"test",CREDIT_BALANCE_FEED_URL:creditFeed,CREDIT_BALANCE_MAX_AGE_SECONDS:'86400',MOCK_PROVIDER_ORIGIN:"http://127.0.0.1:"+providerPort,MENU_IMAGE_CONCURRENCY:'',MENU_READ_CONCURRENCY:'',R2_GATEWAY_URL:'http://localhost/__storage/',R2_GATEWAY_SECRET:'test-storage',OPENAI_IMAGE_MODEL:'',OPENAI_VISION_MODEL:'',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,PUBLIC_ORIGIN:origin,
        OPENAI_API_KEY:'test',GOOGLE_PLACES_API_KEY:'test',TURNSTILE_SECRET:'test',TURNSTILE_SITE_KEY:'test',TURNSTILE_HOSTNAME:'localhost',TURNSTILE_TEST:'0',ADMIN_PIN_VERIFIER:verifier,TRUST_CLOUDFLARE:'1'},
    });
    child.stderr.on('data',bytes=>process.stderr.write(bytes));
    await until(()=>fetch(origin+'/healthz').then(r=>r.ok).catch(()=>false));
  }
  function request(path,cookie='',body,ip='192.0.2.45',city) {
    const headers={cookie,origin,'cf-connecting-ip':ip,'content-type':'application/json'};
    if (city) headers['cf-ipcity']=Buffer.from(city,'utf8').toString('latin1');
    return fetch(origin+path,{headers,method:body?'POST':'GET',body:body&&JSON.stringify(body)});
  }
  async function events(path,cookie='') {
    const abort=new AbortController();
    const response=await fetch(origin+path+'/events',{headers:{cookie},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(8000)])});
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/text\/event-stream/);
    assert.match(response.headers.get('cache-control'),/no-store/);
    const lines=createInterface({input:Readable.fromWeb(response.body),crlfDelay:Infinity});
    const iterator=lines[Symbol.asyncIterator]();
    return {
      close(){abort.abort();},
      async next(when) {
        for (;;) {
          const {value,done}=await iterator.next();
          assert.ok(!done,'Stream ended before expected update');
          if (value.startsWith('data: ')) {
            const job=JSON.parse(value.slice(6));
            if (when(job)) return job;
          }
        }
      },
    };
  }
  async function verify(name,restaurantPin,autoPublish=false,ip) {
    const r=await request('/api/verify','',{name,address:'Example Street',date:'2025-01-01',
      pin:restaurantPin,autoPublish,consent:true,shareOriginals:true,token:'test'},ip);
    assert.equal(r.status,200);
    const {id}=await r.json();
    const cookie=r.headers.getSetCookie().find(value=>value.startsWith('ml_job=')).split(';')[0];
    return {id,cookie};
  }
  await start();
  await t.test('restaurant name search lists distinct branches and accepts suburb names',async()=>{
    const search=async query=>(await request('/api/places','',{query})).json();
    const {places}=await search('mibo');
    assert.deepEqual(places.map(p=>p.branch).sort(),['Milford','Mount Eden','Wynyard Quarter']);
    assert.deepEqual((await search('MIBO Bakery Mt Eden')).places.map(p=>p.branch),['Mount Eden']);
    const eden=places.find(p=>p.branch==='Mount Eden');
    googleResults=[{id:'google-test-eden',displayName:{text:'MIBO'},formattedAddress:eden.address,
      location:{latitude:eden.lat,longitude:eden.lng}}];
    const mixed=await search('mibo');
    assert.equal(placesRequest.regionCode,'NZ');
    assert.equal(placesRequest.includedType,undefined);
    assert.equal(placesRequest.pageSize,20);
    assert.equal(mixed.source,'google');
    assert.equal(mixed.places[0].id,'google-test-eden');
    assert.deepEqual(mixed.places.map(p=>p.branch).sort(),['Milford','Mount Eden','Wynyard Quarter']);
    googleResults=[];
  });
  const settingsPath='/api/admin/settings';
  const login=body=>request('/api/admin/login','',body);
  assert.equal((await request('/api/admin/history')).status,401);
  const newSettings={model:'gpt-image-2.5-sunburst',quality:'xhigh',readingModel:'gpt-5-mini',reasoning:'low'};
  assert.equal((await request(settingsPath)).status,401);
  assert.equal((await request(settingsPath,'',newSettings)).status,401);
  assert.equal((await login({pin,token:''})).status,403);
  assert.equal((await login({pin,token:'menu-only'})).status,403);
  const wrongPin=String((Number(pin)+1)%1_000_000).padStart(6,'0');
  assert.equal((await login({pin:wrongPin,token:'admin-wrong'})).status,401);
  assert.equal((await login({pin,token:'admin-wrong'})).status,403);
  const ok=await login({pin,token:'admin-valid'});
  assert.equal(ok.status,200);
  const cookie=ok.headers.getSetCookie()[0];
  assert.match(cookie,/HttpOnly; SameSite=Strict/i);
  const admin=cookie.split(';')[0];
  assert.equal((await login({pin,token:'admin-valid'})).status,403);
  const defaults=await (await request(settingsPath,admin)).json();
  assert.equal(defaults.balance,null);
  const creditCheck=(ip='192.0.2.201')=>request('/api/verify','',{name:'Credit test',address:'Example Street',date:'2025-01-01',
    consent:true,shareOriginals:true,autoPublish:true,token:'test'},ip);
  assert.equal((await creditCheck()).status,503);
  assert.equal(addressRequests,0);
  assert.equal((await request('/api/admin/balance',admin,{organization:'Example',usd:'12.34'})).status,404);
  assert.equal((await (await request('/api/config')).json()).balance,undefined);
  assert.deepEqual(defaults.settings,{model:'gpt-image-2.6-sunburst',quality:'high',readingModel:'gpt-6.1-terra',reasoning:'medium'});
  assert.equal(defaults.imageModels[defaults.settings.model].high*defaults.outputUsdPerMillion/1e6,0.05268);
  const {readingModel:defaultReadingModel,...olderSettings}=defaults.settings;
  olderSettings.reasoning='low';
  const previousDatabase=new DatabaseSync(join(dir,'menu.sqlite'));
  previousDatabase.prepare('INSERT INTO generation_settings VALUES (1,?)').run(JSON.stringify(olderSettings));
  const recorded={cents:12345,organization:'Example billing account',checked:'2026-11-21T01:00:00.000Z'};
  previousDatabase.prepare('INSERT INTO billing_snapshot VALUES (1,?,?,?)').run(recorded.cents,recorded.organization,recorded.checked);
  previousDatabase.close();
  assert.deepEqual((await (await request(settingsPath,admin)).json()).balance,recorded);
  assert.deepEqual((await (await request(settingsPath,admin)).json()).settings,{...olderSettings,readingModel:defaultReadingModel});
  assert.equal((await request(settingsPath,admin,{...newSettings,model:'gpt-image-2'})).status,400);
  assert.equal((await request(settingsPath,admin,{...newSettings,readingModel:'invalid'})).status,400);
  assert.equal((await request(settingsPath,admin,{...newSettings,readingModel:'gpt-6.2-astra',reasoning:'none'})).status,400);
  assert.equal((await request(settingsPath,admin,newSettings)).status,200);
  const legacySave=await request(settingsPath,admin,{model:newSettings.model,quality:newSettings.quality,reasoning:newSettings.reasoning});
  assert.deepEqual((await legacySave.json()).settings,newSettings);
  const restaurantPin={lat:-41.3,lng:174.7};
  const first=await verify('Test kitchen',restaurantPin);
  const api='/api/jobs/'+first.id;
  assert.equal((await request(api+'/upload',first.cookie,{pages:[photo]},'192.0.2.45','Whangārei')).status,202);
  const adminScript=await request('/admin.js');
  assert.match(adminScript.headers.get('content-type'),/javascript/);
  assert.match(await adminScript.text(),/export async function openAdmin/);
  const retiredPage=await fetch(origin+'/submissions',{redirect:'manual'});
  assert.equal(retiredPage.status,301);
  assert.equal(retiredPage.headers.get('location'),'/explore');
  assert.doesNotMatch(await (await request('/explore')).text(),/href="\/submissions"/);
  assert.equal((await request('/api/job',first.cookie)).status,404);
  await until(()=>readCalls===1);
  assert.equal((await request(api)).status,404);
  assert.equal((await request(api+'/events')).status,404);
  assert.doesNotMatch(await (await request('/menu/'+first.id)).text(),/Test kitchen/);
  assert.equal((await request('/menu/'+first.id)).headers.get('x-robots-tag'),'noindex');
  await stop();
  holdRead=false;
  await start();
  await until(async()=> (await (await request(api,first.cookie)).json()).state==='review');
  assert.equal(readingRequest.reasoning.effort,newSettings.reasoning);
  assert.equal(readingRequest.model,newSettings.readingModel);
  assert.deepEqual((await (await request(settingsPath,admin)).json()).settings,newSettings);
  const second=await verify('Second kitchen');
  assert.equal((await request(api,second.cookie)).status,404);
  assert.equal((await request('/originals/'+first.id+'/0.jpg')).status,404);
  assert.equal((await request(api+'/photos/0')).status,404);
  assert.equal((await request(api+'/photos/0',first.cookie)).headers.get('content-type'),'image/jpeg');
  assert.deepEqual((await (await request(api+'/review',first.cookie)).json()).dishes,menu.dishes);
  assert.equal((await request(api+'/publish',first.cookie,{...menu,reviewed:false})).status,403);
  assert.equal((await request(api+'/publish',second.cookie,{...menu,reviewed:true})).status,403);
  const publications=await Promise.all([1,2].map(()=>request(api+'/publish',first.cookie,{...menu,reviewed:true})));
  for (const publication of publications) {
    assert.equal(publication.status,202);
    assert.equal((await publication.json()).id,first.id);
  }
  assert.equal((await request(api+'/photos/0',first.cookie)).status,404);
  assert.deepEqual(await (await request('/api/menus')).json(),[]);
  await until(()=>imageCalls===1);
  assert.equal(imageRequest.model,newSettings.model);
  assert.equal(imageRequest.quality,newSettings.quality);
  assert.equal((await request(settingsPath,admin,defaults.settings)).status,200);
  assert.equal((await request('/api/admin/logout',admin,{})).status,200);
  assert.equal((await request(settingsPath,admin)).status,401);
  await stop();
  holdImages=false;
  await start();
  await until(async()=> (await (await request(api)).json()).state==='error');
  assert.equal((await (await request(api)).json()).canRetry,false);
  assert.equal((await request(api+'/retry',second.cookie,{})).status,403);
  assert.equal((await (await request(api,first.cookie)).json()).canRetry,true);
  imageFails=false;
  assert.equal((await request(api+'/retry',first.cookie,{},'2001:db8::7','Wellington')).status,202);
  await until(async()=> (await (await request(api)).json()).state==='complete');
  const result=await (await request('/api/menus/'+first.id)).json();
  assert.deepEqual(result.restaurant.pin,restaurantPin);
  assert.equal(imageRequest.model,newSettings.model);
  assert.equal(imageRequest.quality,newSettings.quality);
  const fresh=await login({pin,token:'admin-history'});
  const historyCookie=fresh.headers.getSetCookie()[0].split(';')[0];
  const {runs}=await (await request('/api/admin/history',historyCookie)).json();
  const run=runs.find(run=>run.id===first.id);
  assert.equal(runs.length,2);
  assert.equal(run.id,first.id);
  assert.equal(run.uploadIp,'192.0.2.45');
  assert.equal(run.imageIp,'2001:db8::7');
  assert.equal(run.ipCity,'Whangārei');
  assert.equal(run.state,'complete');
  assert.equal(run.priced,3);
  assert.equal(run.attempts,6);
  assert.ok(Math.abs(run.usd-(0.037272+0.0102))<1e-9);
  const {calls}=await (await request('/api/admin/history/'+first.id,historyCookie)).json();
  assert.deepEqual(calls.map(x=>x.state),['complete','interrupted','complete','interrupted','failed','complete']);
  assert.deepEqual(calls.map(x=>x.basis),['usage','unknown','usage','unknown','unknown','usage']);
  assert.equal(calls[2].model,newSettings.readingModel);
  assert.equal(calls[2].level,newSettings.reasoning);
  assert.equal(calls[0].ip,'192.0.2.45');
  assert.equal(calls.at(-1).ip,'2001:db8::7');
  assert.equal((await request('/api/admin/history/'+first.id)).status,401);
  assert.ok(!JSON.stringify(result).includes('Whangārei'));
  assert.ok(!JSON.stringify(result).includes('192.0.2.45') && !JSON.stringify(result).includes('2001:db8::7'));
  assert.equal(result.dishes[0].price,'$9');
  assert.equal(result.transcript,undefined);
  assert.deepEqual(result.originals,['/originals/'+first.id+'/0.jpg']);
  assert.deepEqual(Buffer.from(await (await request(result.originals[0])).arrayBuffer()),Buffer.from(photo.split(',')[1],'base64'));
  assert.equal((await request(result.dishes[0].image)).headers.get('content-type'),'image/webp');
  assert.equal((await (await request('/api/menus')).json()).length,1);
  const imagesBefore=imageCalls;
  visionResult={...menu,dishes:menu.dishes.map(d=>({...d,hasDishPhoto:true}))};
  const maxObjects=objects.size;
  const illustrated='/api/jobs/'+second.id;
  assert.equal((await request(illustrated+'/upload',second.cookie,{pages:[photo]})).status,202);
  await until(async()=> (await (await request(illustrated,second.cookie)).json()).state==='already_illustrated');
  assert.equal((await request(illustrated+'/publish',second.cookie,{...menu,reviewed:true})).status,403);
  await until(()=>objects.size===maxObjects);
  assert.equal(imageCalls,imagesBefore);
  visionResult={...menu,dishes:[{...menu.dishes[0],name:'Bread',hasDishPhoto:false},...visionResult.dishes]};
  holdRead=true;
  const mixed=await verify('Mixed photos',undefined,true);
  const mixedPath='/api/jobs/'+mixed.id;
  assert.equal((await request(mixedPath+'/upload',mixed.cookie,{pages:[photo,photo]})).status,202);
  const reading=await events(mixedPath,mixed.cookie);
  const readStatus=await reading.next(job=>job.state==='reading' && job.transcribing);
  assert.equal(readStatus.pageCount,2);
  holdImages=true;
  holdBread=true;
  holdRead=false;
  await reading.next(job=>job.state==='running');
  reading.close();
  const images=await events(mixedPath);
  await images.next(job=>job.illustrating?.includes('Soup') && job.illustrating.includes('Bread'));
  holdImages=false;
  const partial=await images.next(job=>job.completed===1);
  assert.equal(partial.total,2);
  assert.deepEqual(partial.illustrating,['Bread']);
  assert.deepEqual(partial.readyPositions,[1]);
  assert.deepEqual(partial.activePositions,[0]);
  const liveMenu=await (await request('/api/menus/'+mixed.id)).json();
  assert.equal(liveMenu.dishes[0].image,null);
  assert.equal(liveMenu.cover,liveMenu.dishes[1].image);
  assert.equal(liveMenu.dishes[0].price,'$9');
  assert.deepEqual(liveMenu.originals,[]);
  assert.equal((await request('/originals/'+mixed.id+'/0.jpg')).status,404);
  assert.equal((await request(liveMenu.cover)).status,200);
  assert.equal((await request('/media/'+mixed.id+'/0.webp')).status,404);
  const listed=(await (await request('/api/menus')).json()).find(row=>row.id===mixed.id);
  assert.equal(listed.cover,liveMenu.cover);
  const html=await (await request('/menu/'+mixed.id)).text();
  assert.match(html,/1 of 2 photos ready/);
  assert.match(html,/1 generating/);
  assert.ok(html.includes(liveMenu.cover) && html.includes('Bread') && html.includes('Soup'));
  const results=await fetch(origin+'/explore?q=Bread',{headers:{'Turbo-Frame':'menu-results'}});
  const frame=await results.text();
  assert.match(frame,/<turbo-frame id="menu-results"/);
  assert.ok(frame.includes(mixed.id) && !frame.includes('<html'));
  const controller=new AbortController();
  try {
    const stream=await fetch(origin+mixedPath+'/events?view=turbo',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])});
    assert.match(stream.headers.get('content-type'),/text\/event-stream/);
    let fragment='';
    const reader=stream.body.getReader();
    const decoder=new TextDecoder();
    while (!fragment.includes('\n\n')) {
      const {value,done}=await reader.read();
      if (done) break;
      fragment+=decoder.decode(value,{stream:true});
    }
    assert.match(fragment,/<turbo-stream[^>]*target="visual-menu"/);
    assert.match(fragment,/<article/);
    assert.ok(fragment.includes(liveMenu.cover));
  } finally {
    controller.abort();
  }
  images.close();
  const resumed=await events(mixedPath);
  await resumed.next(job=>job.state==='running' && job.completed===1);
  imageFails=true;
  holdBread=false;
  assert.equal((await resumed.next(job=>job.state==='error')).canRetry,false);
  assert.equal((await request(liveMenu.cover)).status,200);
  assert.equal((await request('/originals/'+mixed.id+'/0.jpg')).status,404);
  assert.equal((await (await request(mixedPath,mixed.cookie)).json()).canRetry,true);
  const atRetry=imageCalls;
  imageFails=false;
  assert.equal((await request(mixedPath+'/retry',mixed.cookie,{})).status,202);
  await resumed.next(job=>job.state==='running');
  assert.equal((await resumed.next(job=>job.state==='complete')).completed,2);
  assert.equal(imageCalls,atRetry+1);
  assert.equal((await request('/originals/'+mixed.id+'/0.jpg')).status,200);
  assert.equal(imageRequest.quality,'high');
  assert.equal(imageRequest.model,'gpt-image-2.6-sunburst');
  assert.equal(readingRequest.reasoning.effort,'medium');
  assert.equal(readingRequest.model,defaults.settings.readingModel);

  // A failed read keeps its R2 keys private across restarts. Duplicate retries
  // reuse the same attempt, even when the new read has already failed.
  const kept=await verify('Retry kitchen');
  const keptPath='/api/jobs/'+kept.id;
  const savedPages=[photo,'data:image/jpeg;base64,/9j/3Q=='];
  const status=async()=> (await request(keptPath,kept.cookie)).json();
  failReading=true;
  assert.equal((await request(keptPath+'/upload',kept.cookie,{pages:savedPages})).status,202);
  await until(async()=> (await status()).state==='read_error');
  assert.equal((await status()).pageCount,2);
  assert.equal((await status()).canRetryRead,true);
  assert.equal((await status()).readAttempt,1);
  assert.equal((await request(keptPath,first.cookie)).status,404);
  assert.equal((await request(keptPath+'/retry-read','',{attempt:1})).status,403);
  assert.equal((await request(keptPath+'/retry-read',first.cookie,{attempt:1})).status,403);
  assert.equal((await request('/originals/'+kept.id+'/0.jpg')).status,404);
  assert.equal((await request('/api/menus/'+kept.id)).status,404);
  assert.equal((await request(keptPath+'/publish',kept.cookie,{...menu,reviewed:true})).status,403);
  await stop();
  await start();
  const beforeRetry=readCalls;
  const retryRead=attempt=>request(keptPath+'/retry-read',kept.cookie,{attempt},'2001:db8::9');
  const retries=await Promise.all([retryRead(1),retryRead(1)]);
  assert.ok(retries.every(r=>r.status===202));
  await until(async()=> (await status()).state==='read_error');
  assert.equal((await retryRead(1)).status,202);
  assert.equal(readCalls,beforeRetry+1);
  assert.equal((await status()).readAttempt,2);
  failReading=false;
  assert.equal((await retryRead(2)).status,202);
  await until(async()=> (await status()).state==='review');
  assert.deepEqual(readingRequest.input[0].content.filter(c=>c.type==='input_image').map(c=>c.image_url),savedPages);
  assert.equal((await request('/originals/'+kept.id+'/1.jpg')).status,404);
  assert.equal((await request(keptPath+'/photos/1',first.cookie)).status,404);
  assert.equal((await request(keptPath+'/photos/1',kept.cookie)).status,200);
  const ledger=new DatabaseSync(join(dir,'menu.sqlite'));
  const readIps=ledger.prepare("SELECT ip FROM generation_calls WHERE run_id=? AND kind='read' ORDER BY seq").all(kept.id);
  assert.deepEqual(readIps.map(c=>c.ip),['192.0.2.45','2001:db8::9','2001:db8::9']);
  ledger.prepare("UPDATE drafts SET state='read_error' WHERE id=?").run(kept.id);
  assert.equal((await status()).canRetryRead,false);
  assert.equal((await retryRead(3)).status,429);
  ledger.prepare("UPDATE sessions SET reads=1 WHERE id=(SELECT owner FROM drafts WHERE id=?)").run(kept.id);
  ledger.prepare("UPDATE drafts SET pages='[]' WHERE id=?").run(kept.id);
  assert.equal((await status()).canRetryRead,false);
  assert.equal((await retryRead(1)).status,409);
  ledger.prepare("UPDATE sessions SET expires=0 WHERE id=(SELECT owner FROM drafts WHERE id=?)").run(kept.id);
  assert.equal((await request(keptPath,kept.cookie)).status,404);
  assert.equal((await retryRead(1)).status,403);
  // Older installations can still have a full image counter when they upgrade.
  ledger.prepare("INSERT OR REPLACE INTO counters(id,count,expires) VALUES ('images:daily',120,?)").run(Date.now()+86_400_000);
  ledger.close();
  await t.test('automatic publication survives a restart without a client or a second submission',async()=>{
    visionResult=menu;
    holdRead=true;
    const auto=await verify('Automatic kitchen',undefined,true);
    const path='/api/jobs/'+auto.id;
    const upload=()=>request(path+'/upload',auto.cookie,{pages:[photo]},'192.0.2.100');
    const startReads=readCalls;
    assert.equal((await upload()).status,202);
    await until(()=>readCalls===startReads+1);
    assert.equal((await upload()).status,202);
    assert.equal((await request('/api/menus/'+auto.id)).status,404);
    await stop();
    holdRead=false;
    const beforeImages=imageCalls;
    await start();
    await until(async()=> (await request('/api/menus/'+auto.id)).ok);
    const result=await (await request('/api/menus/'+auto.id)).json();
    assert.equal(result.dishes[0].name,'Soup');
    assert.equal(result.dishes[0].price,'$9');
    assert.equal(result.originals.length,1);
    const {runs}=await (await request('/api/admin/history',historyCookie)).json();
    assert.equal(runs.find(run=>run.id===auto.id).ipCity,null);
    assert.equal((await upload()).status,202);
    assert.equal(imageCalls,beforeImages+1);
    assert.equal(readCalls,startReads+2);
  });
  await t.test('homepage includes every published menu and links cover images to its menu',async()=>{
    const catalog=new DatabaseSync(join(dir,'menu.sqlite'));
    const id='eeeeeeeeeeeeeeeeeeee';
    catalog.prepare('INSERT INTO menus SELECT ?,?,restaurant_key,date,created,payload,state,attempts FROM menus WHERE id=?').run(id,'homepage-test',first.id);
    catalog.prepare('INSERT INTO dish_objects SELECT ?,position,object_key FROM dish_objects WHERE menu_id=?').run(id,first.id);
    catalog.close();
    const menus=await (await request('/api/menus')).json();
    assert.ok(menus.length>3);
    const html=await (await request('/')).text();
    assert.match(html,/>Published menus<\/h2>/);
    assert.equal((html.match(/class="menu-card-link"/g)||[]).length,menus.length);
    for (const menu of menus) assert.ok(html.includes('class="menu-card-link" href="/menu/'+menu.id+'"'));
    assert.ok(!html.includes('data-view-image'));
  });
  await t.test('Explore searches the full public menu and shows matching dishes',async()=>{
    const catalog=new DatabaseSync(join(dir,'menu.sqlite'));
    const id='eeeeeeeeeeeeeeeeeeee';
    const row=catalog.prepare('SELECT payload FROM menus WHERE id=?').get(id);
    const payload=JSON.parse(row.payload);
    payload.dishes=[{name:'Salmon sushi',section:'Mains',description:'Seasoned rice and salmon',price:'$16'}];
    payload.notes='Takeaway available';
    catalog.prepare('UPDATE menus SET payload=? WHERE id=?').run(JSON.stringify(payload),id);
    catalog.close();
    for (const query of ['SUSHI','rice','mains','rice salmon','test kitchen rice']) {
      const result=await (await request('/api/menus?q='+encodeURIComponent(query))).json();
      assert.deepEqual(result.map(menu=>menu.id),[id]);
      assert.deepEqual(result[0].matchedDishes,['Salmon sushi']);
    }
    assert.ok((await (await request('/api/menus?q=takeaway')).json()).some(menu=>menu.id===id));
    assert.deepEqual(await (await request('/api/menus?q=sushi%20missingingredient')).json(),[]);
    assert.match(await (await request('/')).text(),/class="source-link"[^>]+target="_blank"[^>]+noopener/);
  });
  await t.test('address checks gate generation and preserve the selected branch on retry',async()=>{
    const ip='192.0.2.123';
    async function begin(address) {
      const reply=await request('/api/verify','',{name:'Branch Cafe',address,pin:restaurantPin,placeId:'old-place',
        date:'2025-01-01',consent:true,shareOriginals:true,token:'test'},ip);
      assert.equal(reply.status,200);
      const {id,addressCheck}=await reply.json();
      const cookie=reply.headers.getSetCookie().find(value=>value.startsWith('ml_job=')).split(';')[0];
      return {id,addressCheck,post:(action,body,auth=cookie)=>request('/api/jobs/'+id+'/'+action,auth,body,ip)};
    }
    const options=['12 Jellicoe Street','30 Enfield Street'].map(address=>({label:'Branch Cafe',address,sourceUrl}));
    addressReply={status:'mismatch',options:options.slice(0,1)};
    const wrong=await begin('99 Wrong Street');
    assert.deepEqual(wrong.addressCheck,addressReply);
    const reads=readCalls;
    assert.equal((await wrong.post('upload',{pages:[photo]})).status,409);
    assert.equal(readCalls,reads);
    assert.equal((await wrong.post('confirm-address',{choice:0},first.cookie)).status,403);
    assert.equal((await wrong.post('confirm-address',{choice:7})).status,400);
    assert.equal((await wrong.post('confirm-address',{choice:0})).status,200);
    assert.equal((await wrong.post('confirm-address',{choice:0})).status,200);
    assert.equal((await wrong.post('confirm-address',{choice:'entered'})).status,409);
    assert.equal((await wrong.post('upload',{pages:[photo]})).status,202);
    const catalog=new DatabaseSync(join(dir,'menu.sqlite'));
    const saved=catalog.prepare("SELECT details FROM sessions JOIN drafts ON sessions.id=drafts.owner WHERE drafts.id=?").get(wrong.id);
    await until(()=>catalog.prepare('SELECT state FROM drafts WHERE id=?').get(wrong.id)?.state==='review');
    const restaurant=JSON.parse(saved.details).restaurant;
    assert.equal(restaurant.address,options[0].address);
    assert.equal(restaurant.placeId,'');
    assert.equal(restaurant.pin,undefined);
    catalog.close();
    addressReply={status:'ambiguous',options};
    const branches=await begin('');
    assert.deepEqual(branches.addressCheck,addressReply);
    assert.equal((await branches.post('confirm-address',{choice:1})).status,200);
    addressReply={status:'mismatch',options:[{...options[0],sourceUrl:'https://uncited.example/venue'}]};
    const uncertain=await begin('7 Local Street');
    assert.deepEqual(uncertain.addressCheck,{status:'unverified',options:[]});
    assert.equal((await uncertain.post('confirm-address',{choice:'entered'})).status,200);
    addressReply='offline';
    const offline=await begin('');
    assert.equal(offline.addressCheck.status,'unverified');
    assert.equal((await offline.post('confirm-address',{choice:'entered',address:''})).status,400);
    assert.equal((await offline.post('confirm-address',{choice:'entered',address:'8 Local Street'})).status,200);
    const before=addressRequests;
    assert.equal((await request('/api/verify','',{name:'Bot',address:'Auckland',date:'2025-01-01',consent:true,shareOriginals:true,token:''},ip)).status,403);
    assert.equal(addressRequests,before);
  });
  await t.test('menus share rolling image and transcription slots and retry only missing dishes',async t=>{
    addressReply=null;
    visionResult=menu;
    const ip='192.0.2.210';
    const uploads=[];
    const status=async job=>(await request('/api/jobs/'+job.id,job.cookie)).json();
    const post=(job,action,body)=>request('/api/jobs/'+job.id+'/'+action,job.cookie,body,ip);
    const before=readCalls;
    holdRead=true;
    for (const name of ['Large','Small','Third']) {
      const job=await verify(name,undefined,false,ip);
      uploads.push(job);
      assert.equal((await post(job,'upload',{pages:[photo,photo]})).status,202);
    }
    await until(()=>readCalls===before+2);
    assert.equal((await status(uploads[2])).state,'waiting');
    assert.equal(readingRequest.input[0].content.filter(item=>item.type==='input_image').length,2);
    holdRead=false;
    for (const job of uploads) await until(async()=>(await status(job)).state==='review');
    assert.equal(readCalls,before+3);

    const [large,small]=uploads;
    const largeNames=Array.from({length:8},(_,i)=>'Large dish '+i);
    const smallName='Small dish';
    function gate(name) {
      const control={...Promise.withResolvers(),calls:0};
      imageGates.set(name,control);
      return control;
    }
    const gates=largeNames.map(gate);
    const smallGate=gate(smallName);
    t.after(()=>{for (const control of imageGates.values()) control.resolve(200);});
    const publish=(job,names)=>post(job,'publish',{...menu,reviewed:true,
      dishes:names.map(name=>({...menu.dishes[0],name}))});
    assert.equal((await publish(large,largeNames)).status,202);
    await until(()=>gates.slice(0,4).every(control=>control.calls===1));
    assert.equal((await publish(small,[smallName])).status,202);
    assert.equal(smallGate.calls,0);
    assert.equal((await status(small)).state,'queued');
    assert.deepEqual((await status(large)).activePositions,[0,1,2,3]);

    // Dishes 0 and 3 stay in flight. Two freed slots serve both menus.
    gates[1].resolve(200);
    gates[2].resolve(200);
    await until(()=>gates[4].calls===1 && smallGate.calls===1);
    assert.deepEqual((await status(large)).readyPositions,[1,2]);
    assert.deepEqual((await status(large)).activePositions,[0,3,4]);
    gates[4].resolve(503);
    await until(async()=>!(await status(large)).activePositions.includes(4));
    assert.equal((await status(large)).state,'running');
    smallGate.resolve(200);
    await until(async()=>(await status(small)).state==='complete');
    gates[0].resolve(200);
    gates[3].resolve(200);
    await until(async()=>(await status(large)).state==='error');
    assert.deepEqual((await status(large)).readyPositions,[0,1,2,3]);
    assert.deepEqual(gates.map(control=>control.calls),[1,1,1,1,1,0,0,0]);

    const retry=gate(largeNames[4]);
    for (const control of imageGates.values()) control.resolve(200);
    assert.equal((await post(large,'retry',{})).status,202);
    await until(async()=>(await status(large)).state==='complete');
    assert.equal(retry.calls,1);
    assert.deepEqual(gates.map(control=>control.calls),[1,1,1,1,1,1,1,1]);
    const published=await (await request('/api/menus/'+large.id)).json();
    assert.deepEqual(published.dishes.map(d=>d.name),largeNames);
  });
  await t.test('credit cutoff guards concurrent requests, queued images and retries',async t=>{
    const db=new DatabaseSync(join(dir,'menu.sqlite'));
    t.after(()=>db.close());
    function record(cents) {
      db.prepare('UPDATE billing_snapshot SET cents=?,checked=? WHERE id=1').run(cents,new Date().toISOString());
    }
    const before=addressRequests;
    record(999);
    assert.equal((await creditCheck()).status,503);
    assert.equal(addressRequests,before);
    record(1000);
    const runCount=()=>db.prepare("SELECT COUNT(*) AS n FROM generation_runs").get().n;
    const beforeRuns=runCount();
    const attempts=await Promise.all(Array.from({length:3},()=>creditCheck()));
    assert.equal(runCount(),beforeRuns+1);
    assert.deepEqual(attempts.map(r=>r.status).sort(),[200,503,503]);
    assert.equal(addressRequests,before+1);
    const accepted=attempts.find(r=>r.ok);
    const path='/api/jobs/'+(await accepted.json()).id;
    const owner=accepted.headers.getSetCookie().find(c=>c.startsWith('ml_job=')).split(';')[0];
    const post=(action,body)=>request(path+'/'+action,owner,body,'192.0.2.201');
    const status=async()=>(await request(path,owner)).json();
    const readsBefore=readCalls,imagesBefore=imageCalls;
    const refusedUpload=await post('upload',{pages:[photo]});
    assert.equal(refusedUpload.status,503);
    assert.equal((await refusedUpload.json()).code,'generation_paused');
    assert.equal(readCalls,readsBefore);

    record(2000);
    holdRead=true;
    visionResult=menu;
    assert.equal((await post('upload',{pages:[photo]})).status,202);
    await until(()=>readCalls===readsBefore+1);
    // This snapshot overlaps the read. Its eventual charge must still count.
    record(1000);
    assert.equal((await creditCheck()).status,503);
    holdRead=false;
    await until(async()=>(await status()).state==='error');
    assert.equal(imageCalls,imagesBefore);
    assert.equal((await post('retry',{})).status,503);
    assert.equal(addressRequests,before+1);
    assert.equal(db.prepare('SELECT attempts FROM menus WHERE id=?').get(path.split('/').at(-1)).attempts,0);

    // A worker-side credit pause also preserves a menu on its last retry.
    db.prepare('UPDATE menus SET attempts=3 WHERE id=?').run(path.split('/').at(-1));
    const paused=await status();
    assert.equal(paused.canRetry,true);
    record(2000);
    assert.equal((await post('retry',{})).status,202);
    await until(async()=>(await status()).state==='complete');
    assert.equal(imageCalls,imagesBefore+1);
    assert.equal(readCalls,readsBefore+1);

    addressReply={httpStatus:429,error:{code:'credit_balance_exhausted'}};
    assert.equal((await creditCheck()).status,503);
    addressReply=null;
    assert.equal((await creditCheck()).status,503);
    assert.equal(addressRequests,before+2);
    record(2000);
    assert.equal((await creditCheck()).status,200);
  });
  await t.test('billing limits survive restarts and standard throttling allows a later request',async t=>{
    const db=new DatabaseSync(join(dir,'menu.sqlite'));
    t.after(()=>db.close());
    const signIn=await login({pin,token:'admin-credit-review'});
    assert.equal(signIn.status,200);
    const reviewer=signIn.headers.getSetCookie()[0].split(';')[0];
    const details=async()=>{
      const response=await request(settingsPath,reviewer);
      assert.equal(response.status,200);
      return response.json();
    };
    for (const failure of [
      {httpStatus:429,error:{type:'insufficient_quota',code:'project_spend_limit_exceeded'}},
      {httpStatus:200,error:{code:'organization_spend_limit_exceeded'}},
      {httpStatus:429,error:{type:'insufficient_quota'}},
    ]) {
      addressReply=failure;
      assert.equal((await creditCheck('192.0.2.211')).status,503);
      addressReply=null;
      if (failure.httpStatus===200) {await stop();await start();}
      const before=addressRequests;
      assert.equal((await creditCheck('192.0.2.211')).status,503);
      assert.equal(addressRequests,before);
      const data=await details();
      assert.equal(data.providerBillingBlocked,true);
      const availability=await (await request('/api/config')).json();
      assert.equal(availability.submissionsPaused,true);
      assert.equal(availability.estimatedBalanceUsd,undefined);
      assert.ok(data.estimatedBalanceUsd>10,'A project limit does not set the credit estimate to zero');
      await delay(4);
      db.prepare('UPDATE billing_snapshot SET cents=2000,checked=?').run(new Date().toISOString());
      assert.equal((await details()).providerBillingBlocked,false);
    }
    db.prepare('UPDATE billing_snapshot SET cents=1000,checked=?').run(new Date().toISOString());
    addressReply={httpStatus:429,error:{code:'rate_limit_exceeded'}};
    await verify('Throttled address',undefined,false,'192.0.2.212');
    assert.equal((await details()).estimatedBalanceUsd,10);
    addressReply=null;
    assert.equal((await creditCheck('192.0.2.212')).status,200);
    // Legacy calls without usage or a hold must pause spending until a later snapshot.
    const run=db.prepare('SELECT id FROM generation_runs LIMIT 1').get().id;
    db.prepare("INSERT INTO generation_calls(run_id,started,kind,label,model,level,state) VALUES(?,?,'read','legacy','gpt-5-mini','low','interrupted')").run(run,new Date().toISOString());
    assert.equal((await details()).estimatedBalanceUsd,null);
    assert.equal((await creditCheck('192.0.2.212')).status,503);
    await delay(4);
    db.prepare('UPDATE billing_snapshot SET checked=?').run(new Date().toISOString());
    assert.ok((await details()).estimatedBalanceUsd>=10);
    db.prepare('UPDATE billing_snapshot SET cents=2000,checked=?').run(new Date().toISOString());
  });
  await t.test('a private read paused on its third attempt can resume after billing recovers',async t=>{
    const db=new DatabaseSync(join(dir,'menu.sqlite'));
    t.after(()=>db.close());
    const ip='192.0.2.213';
    const job=await verify('Final read retry',undefined,false,ip);
    const path='/api/jobs/'+job.id;
    const post=(action,body)=>request(path+'/'+action,job.cookie,body,ip);
    const status=async()=> (await (await request(path,job.cookie)).json());
    failReading=true;
    assert.equal((await post('upload',{pages:[photo]})).status,202);
    await until(async()=>(await status()).state==='read_error');
    assert.equal((await post('retry-read',{attempt:1})).status,202);
    await until(async()=>(await status()).state==='read_error');
    failReading=false;
    readingBillingError=true;
    assert.equal((await post('retry-read',{attempt:2})).status,202);
    await until(async()=>(await status()).state==='read_error');
    const paused=await status();
    assert.equal(paused.readAttempt,3);
    assert.equal(paused.canRetryRead,true);
    assert.equal((await post('retry-read',{attempt:3})).status,503);
    readingBillingError=false;
    const before=readCalls;
    await delay(4);
    db.prepare('UPDATE billing_snapshot SET cents=2000,checked=?').run(new Date().toISOString());
    holdRead=true;
    assert.equal((await post('retry-read',{attempt:3})).status,202);
    assert.equal((await post('retry-read',{attempt:3})).status,202);
    holdRead=false;
    await until(async()=>(await status()).state==='review');
    assert.equal(readCalls,before+1);
    assert.equal((await status()).readAttempt,3);
    assert.equal((await request('/originals/'+job.id+'/0.jpg')).status,404);
  });
  await t.test('shared credit updates control the cutoff without resetting later local charges',async t=>{
    const db=new DatabaseSync(join(dir,'menu.sqlite'));
    t.after(()=>db.close());
    const feed='https://balance.example.test/credit-feed';
    const row=()=>db.prepare('SELECT cents,checked,fetched_at FROM billing_feed_snapshots').get();
    const config=async()=> (await (await request('/api/config')).json());
    async function poll(report){
      feedReport=report;
      const before=feedReads;
      await stop();
      await start(feed);
      await until(()=>feedReads>before);
    }
    // A configured feed is authoritative even when a funded manual snapshot exists.
    await poll(null);
    assert.equal((await config()).submissionsPaused,true);
    const stale=new Date(Date.now()-2*86400000).toISOString();
    await poll({balance:50,timestamp:stale});
    await until(()=>row()?.checked===stale);
    assert.equal((await config()).submissionsPaused,true);

    const observed=new Date().toISOString();
    await poll({balance:10,timestamp:observed});
    await until(()=>row()?.checked===observed);
    assert.equal((await config()).submissionsPaused,false);
    assert.equal((await creditCheck('192.0.2.219')).status,200);
    assert.equal((await config()).submissionsPaused,true);
    const previousFetch=row().fetched_at;
    await poll({balance:10,timestamp:observed});
    await until(()=>row().fetched_at>previousFetch);
    assert.equal((await config()).submissionsPaused,true);

    const newer=new Date().toISOString();
    await poll({balance:25.01,timestamp:newer});
    await until(()=>row()?.checked===newer);
    assert.equal(row().cents,2501);
    assert.equal((await config()).submissionsPaused,false);
    // Out-of-order, contradictory and invalid readings cannot extend the grace period.
    for (const report of [null,{balance:100,timestamp:observed},{balance:100,timestamp:newer},
      {balance:'NaN',timestamp:newer},{balance:100,timestamp:new Date(Date.now()+86400000).toISOString()}]){
      db.prepare('UPDATE billing_feed_snapshots SET fetched_at=0').run();
      await poll(report);
      assert.equal((await config()).submissionsPaused,true);
      assert.equal(row().checked,newer);
      assert.equal(row().cents,2501);
    }
    await poll({balance:9.99,timestamp:new Date().toISOString()});
    await until(()=>row()?.cents===999);
    const publicConfig=await config();
    assert.equal(publicConfig.submissionsPaused,true);
    assert.ok(!Object.keys(publicConfig).some(key=>/balance|credit|feed/i.test(key)));
    const before=addressRequests;
    assert.equal((await creditCheck('192.0.2.219')).status,503);
    assert.equal(addressRequests,before);
  });
  assert.equal((await request('/fonts/dm-sans-OFL.txt')).status,200);
  assert.equal((await request('/api/verify','',{name:'Consent test',consent:true,locationConfirmed:true})).status,403);
});
