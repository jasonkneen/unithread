var l=typeof process<"u"&&!!process.versions?.node&&typeof globalThis.importScripts>"u"&&typeof globalThis.window>"u";async function u(){if(l){let t=await import("node:os");return(t.availableParallelism?.()??t.cpus().length)||1}return globalThis.navigator?.hardwareConcurrency||4}function g(){return typeof SharedArrayBuffer<"u"}var o=class t{constructor(e,r,n){this.impl=e;this.kind=r;this.blobUrl=n}impl;kind;blobUrl;static async fromSource(e){if(l){let{Worker:n}=await import("node:worker_threads");return new t(new n(e,{eval:!0}),"node")}let r=URL.createObjectURL(new Blob([e],{type:"text/javascript"}));return new t(new globalThis.Worker(r),"web",r)}postMessage(e,r=[]){this.kind==="node"?this.impl.postMessage(e,r):this.impl.postMessage(e,r)}onMessage(e){this.kind==="node"?this.impl.on("message",e):this.impl.addEventListener("message",r=>e(r.data))}onError(e){this.kind==="node"?this.impl.on("error",e):this.impl.addEventListener("error",r=>e(r.error??r.message??r))}async terminate(){this.kind==="node"?await this.impl.terminate():(this.impl.terminate(),this.blobUrl&&URL.revokeObjectURL(this.blobUrl))}};function y(t){return`
(function () {
  "use strict";
  var IS_NODE_WORKER = typeof self === "undefined";
  var post, on, env;
  if (IS_NODE_WORKER) {
    var wt = require("node:worker_threads");
    post = function (m, t) { wt.parentPort.postMessage(m, t || []); };
    on = function (cb) { wt.parentPort.on("message", cb); };
    env = { isMainThread: wt.isMainThread, threadId: wt.threadId, runtime: "node" };
  } else {
    post = function (m, t) { self.postMessage(m, t || []); };
    on = function (cb) { self.onmessage = function (e) { cb(e.data); }; };
    env = { isMainThread: false, threadId: -1, runtime: "web" };
  }

  // Non-enumerable so env itself stays structured-clone-safe if user
  // code returns or re-posts it (functions would otherwise throw).
  Object.defineProperty(env, "emit", { value: function (event, data, transfer) {
    post({ type: "event", event: event, data: data }, transfer || []);
  }});
  Object.defineProperty(env, "transfer", { value: function (value, list) {
    return { __unithreadTransfer: true, value: value, transfer: list || [] };
  }});
  globalThis.__unithread = env;

  var __exported = (${t});

  function reply(id, p) {
    Promise.resolve(p).then(
      function (value) {
        var transfer = [];
        if (value && value.__unithreadTransfer) {
          transfer = value.transfer; value = value.value;
        }
        post({ id: id, ok: true, value: value }, transfer);
      },
      function (err) {
        post({ id: id, ok: false, error: {
          message: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : undefined
        }});
      }
    );
  }

  on(function (msg) {
    if (!msg || typeof msg.id === "undefined") return;
    try {
      if (msg.type === "call") {
        reply(msg.id, __exported.apply(null, (msg.args || []).concat([env])));
      } else if (msg.type === "method") {
        var target = __exported[msg.name];
        if (typeof target !== "function") throw new Error("No such method: " + msg.name);
        reply(msg.id, target.apply(__exported, msg.args || []));
      }
    } catch (err) { reply(msg.id, Promise.reject(err)); }
  });

  post({ id: "__ready__", ok: true, value: {
    isMainThread: env.isMainThread, threadId: env.threadId, runtime: env.runtime
  } });
})();
`}var i=class t{constructor(e,r){this.worker=e;this.env=r}worker;env;seq=0;pending=new Map;eventHandlers=[];static async spawn(e){return t.fromSource(e.toString())}static async spawnService(e){let r=Object.entries(e).map(([n,s])=>JSON.stringify(n)+": ("+s.toString()+")").join(`,
`);return t.fromSource(`{
`+r+`
}`)}static async fromSource(e){let r=await o.fromSource(y(e)),n=await new Promise((a,w)=>{r.onError(w),r.onMessage(function(m){m?.id==="__ready__"&&a(m.value)})}),s=new t(r,n);return r.onMessage(a=>s.dispatch(a)),r.onError(a=>s.failAll(a)),s}dispatch(e){if(!e||e.id==="__ready__")return;if(e.type==="event"){for(let n of this.eventHandlers)n(e.event,e.data);return}let r=this.pending.get(e.id);if(r)if(this.pending.delete(e.id),e.ok)r.resolve(e.value);else{let n=new Error(e.error?.message??"Worker error");e.error?.stack&&(n.stack=e.error.stack),r.reject(n)}}failAll(e){let r=e instanceof Error?e:new Error(String(e));for(let n of this.pending.values())n.reject(r);this.pending.clear()}run(e,r=[]){return this.send({type:"call",args:e},r)}call(e,r=[],n=[]){return this.send({type:"method",name:e,args:r},n)}onEvent(e){return this.eventHandlers.push(e),()=>{let r=this.eventHandlers.indexOf(e);r>=0&&this.eventHandlers.splice(r,1)}}send(e,r){let n=`m${this.seq++}`;return new Promise((s,a)=>{this.pending.set(n,{resolve:s,reject:a}),this.worker.postMessage({id:n,...e},r)})}get pendingCount(){return this.pending.size}terminate(){return this.failAll(new Error("Task terminated")),this.worker.terminate()}};async function T(t,...e){let r=await i.spawn(t);try{return await r.run(e)}finally{await r.terminate()}}var d=class t{constructor(e,r){this.fn=e;this.size=r}fn;size;idle=[];all=[];queue=[];spawning=0;closed=!1;static async create(e,r){let n=r??await u();return new t(e,Math.max(1,n))}exec(e,r=[]){return this.closed?Promise.reject(new Error("Pool closed")):new Promise((n,s)=>{this.queue.push({args:e,transfer:r,resolve:n,reject:s}),this.pump()})}map(e,r){return Promise.all(e.map((n,s)=>this.exec(r(n,s))))}pump(){for(;this.queue.length>0&&this.idle.length>0;){let e=this.queue.shift(),r=this.idle.pop();r.run(e.args,e.transfer).then(e.resolve,e.reject).finally(()=>{this.closed||(this.idle.push(r),this.pump())})}this.queue.length>0&&this.all.length+this.spawning<this.size&&(this.spawning++,i.spawn(this.fn).then(e=>{if(this.spawning--,this.closed)return void e.terminate();this.all.push(e),this.idle.push(e),this.pump()}).catch(e=>{if(this.spawning--,this.all.length===0){let r=this.queue.splice(0);for(let n of r)n.reject(e)}}))}get started(){return this.all.length}async close(){this.closed=!0;let e=this.queue.splice(0);for(let r of e)r.reject(new Error("Pool closed"));await Promise.all(this.all.map(r=>r.terminate())),this.all=[],this.idle=[]}};function h(){if(typeof SharedArrayBuffer>"u")throw new Error("SharedArrayBuffer unavailable. In browsers this requires cross-origin isolation (COOP/COEP).")}var f=class{buffer;view;constructor(e=0){e instanceof SharedArrayBuffer?this.buffer=e:(h(),this.buffer=new SharedArrayBuffer(4),new Int32Array(this.buffer)[0]=e),this.view=new Int32Array(this.buffer)}add(e=1){return Atomics.add(this.view,0,e)+e}get value(){return Atomics.load(this.view,0)}},c=class t{static UNLOCKED=0;static LOCKED=1;buffer;view;constructor(e){e?this.buffer=e:(h(),this.buffer=new SharedArrayBuffer(4)),this.view=new Int32Array(this.buffer)}lock(){for(;;){if(Atomics.compareExchange(this.view,0,t.UNLOCKED,t.LOCKED)===t.UNLOCKED)return;Atomics.wait(this.view,0,t.LOCKED)}}tryLock(){return Atomics.compareExchange(this.view,0,t.UNLOCKED,t.LOCKED)===t.UNLOCKED}async lockAsync(){for(;;){if(this.tryLock())return;let e=Atomics.waitAsync?.(this.view,0,t.LOCKED);e?.async?await e.value:await new Promise(r=>setTimeout(r,0))}}unlock(){Atomics.store(this.view,0,t.UNLOCKED),Atomics.notify(this.view,0,1)}withLock(e){this.lock();try{return e()}finally{this.unlock()}}},p=class{buffer;view;constructor(e){e?this.buffer=e:(h(),this.buffer=new SharedArrayBuffer(4)),this.view=new Int32Array(this.buffer)}wait(e=1/0){return Atomics.load(this.view,0)!==0?!0:Atomics.wait(this.view,0,0,e)!=="timed-out"}async waitAsync(e=1/0){if(Atomics.load(this.view,0)!==0)return!0;let r=Atomics.waitAsync?.(this.view,0,0,e);if(r?.async)return await r.value!=="timed-out";if(r)return r.value!=="timed-out";let n=Date.now()+(Number.isFinite(e)?e:2**31);for(;Date.now()<n;){if(Atomics.load(this.view,0)!==0)return!0;await new Promise(s=>setTimeout(s,1))}return!1}fire(){Atomics.store(this.view,0,1),Atomics.notify(this.view,0)}};function v(t){return new Proxy(Object.create(null),{get(e,r){if(typeof r!="symbol"&&r!=="then")return r==="terminate"?()=>t.terminate():(...n)=>t.call(r,n)}})}async function b(t){return v(await i.spawnService(t))}export{c as Mutex,f as SharedCounter,p as Signal,i as Task,o as UnifiedWorker,d as WorkerPool,y as _bootstrap,u as hardwareConcurrency,g as hasSharedMemory,l as isNode,T as runInThread,b as spawnRemote,v as wrap};
