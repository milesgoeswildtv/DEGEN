import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { verifyPagesWorker } from '../scripts/verify-pages-worker-readonly.mjs';
async function server(handler) {
  const requests=[];
  const instance=createServer((req,res)=>{requests.push({method:req.method,url:req.url,origin:req.headers.origin});handler(req,res)});
  await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
  return {origin:`http://127.0.0.1:${instance.address().port}`,requests,close:()=>new Promise(resolve=>instance.close(resolve))};
}
async function fixture({badPut=false,unsafePreview=false}={}) {
  let workerOrigin;
  const pages=await server((req,res)=>{
    res.writeHead(200,{'content-type':req.url==='/'?'text/html':'application/javascript'});
    res.end(req.url==='/'?'<script type="module" src="/assets/app.js"></script>':`const api="${workerOrigin}";`);
  });
  const worker=await server((req,res)=>{
    const origin=req.headers.origin;
    const cors=origin===pages.origin || unsafePreview ? origin : pages.origin;
    if(req.url==='/api/health'){
      res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':cors});res.end('{"ok":true}');return;
    }
    res.writeHead(204,{'access-control-allow-origin':cors,'access-control-allow-methods':badPut?'GET,POST,put,OPTIONS':'GET,POST,PUT,OPTIONS','access-control-allow-headers':'content-type'});res.end();
  });
  workerOrigin=worker.origin;
  return {pages,worker,close:async()=>{await pages.close();await worker.close()}};
}
test('real loopback HTTP passes only GET and OPTIONS, never mutates player data',async()=>{
  const f=await fixture();try{
    const result=await verifyPagesWorker({pagesUrl:f.pages.origin,workerUrl:f.worker.origin,timeoutMs:5000});
    assert.equal(result.status,'PASS');
    assert.deepEqual(f.pages.requests.map(x=>x.method),['GET','GET']);
    assert.deepEqual(f.worker.requests.map(x=>x.method),['GET','OPTIONS','OPTIONS','OPTIONS']);
  }finally{await f.close()}
});
test('real loopback HTTP rejects lowercase PUT permission',async()=>{
  const f=await fixture({badPut:true});try{
    await assert.rejects(verifyPagesWorker({pagesUrl:f.pages.origin,workerUrl:f.worker.origin,timeoutMs:5000}),/PUT must be allowed/);
  }finally{await f.close()}
});
test('real loopback HTTP rejects preview origin reflection',async()=>{
  const f=await fixture({unsafePreview:true});try{
    await assert.rejects(verifyPagesWorker({pagesUrl:f.pages.origin,workerUrl:f.worker.origin,timeoutMs:5000}),/Unapproved preview origin/);
  }finally{await f.close()}
});
 
test('real loopback HTTP supports GitHub Pages-style project subpaths', async () => {
  let workerOrigin;
  const pages = await server((req, res) => {
    if (req.url === '/DEGEN/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script type="module" crossorigin src="./assets/app.js"></script>');
    } else if (req.url === '/DEGEN/assets/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(`const api="${workerOrigin}";`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const worker = await server((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': pages.origin });
      res.end('{"ok":true}');
    } else {
      res.writeHead(204, { 'access-control-allow-origin': pages.origin,
        'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
        'access-control-allow-headers': 'content-type' });
      res.end();
    }
  });
  workerOrigin = worker.origin;
  try {
    const result = await verifyPagesWorker({ pagesUrl: pages.origin + '/DEGEN/', workerUrl: worker.origin, timeoutMs: 5000 });
    assert.equal(result.pages, pages.origin);
    assert.equal(result.pagesBase, pages.origin + '/DEGEN/');
    assert.deepEqual(pages.requests.map(r => r.url), ['/DEGEN/', '/DEGEN/assets/app.js']);
    assert.deepEqual(worker.requests.map(r => r.method), ['GET', 'OPTIONS', 'OPTIONS', 'OPTIONS']);
  } finally {
    await pages.close(); await worker.close();
  }
});
