const http = require('http'); const sharp = require('sharp'); const fs = require('fs'); const path = require('path');
const { grab } = require('../engine');
const page = (ch, p) => `<html><head><title>My Comic - Chapter ${ch} | MockSite</title></head><body>
<img src="/header.jpg"><div class="reading-content">
<img data-src="/img/ch${ch}-p${p}-a.jpg" src="data:x"><img src="/img/ch${ch}-p${p}-b.jpg"></div>
<div class="pagination"><a href="/comic/my-comic/chapter-${ch}/">1</a>${p===1?`<a href="/comic/my-comic/chapter-${ch}/?p=2">Next</a>`:''}
<a href="/comic/my-comic/chapter-${ch+1}/">Next Chapter</a></div></body></html>`;
const list = `<html><head><title>My Comic | MockSite</title></head><body>
<a href="/comic/my-comic/chapter-1/">Chapter 1</a><a href="/comic/my-comic/chapter-2/">Chapter 2</a><a href="/comic/my-comic/chapter-3/">Chapter 3</a></body></html>`;
(async () => {
  const noise = Buffer.alloc(300*400*3); for (let i=0;i<noise.length;i++) noise[i]=(i*2654435761)>>>24; const img = await sharp(noise,{raw:{width:300,height:400,channels:3}}).jpeg().toBuffer();
  const srv = http.createServer((req,res)=>{
    const u = new URL(req.url,'http://x'); let m;
    if (u.pathname==='/comic/my-comic/') return res.end(list);
    if ((m=u.pathname.match(/chapter-(\d)\/$/))) return res.end(page(+m[1], u.searchParams.get('p')==='2'?2:1));
    if (u.pathname.endsWith('.jpg')) { res.setHeader('content-type','image/jpeg'); return res.end(img); }
    res.statusCode=404; res.end('nope');
  });
  await new Promise(r => srv.listen(8765, '127.0.0.1', r));
  const log = (ev) => console.log((ev.type==='warn'?'  ! ':'  ') + ev.msg);
  const base = 'http://127.0.0.1:8765/comic/my-comic/';
  console.log('=== chapter-list ==='); console.log(await grab(base, { outDir:'/tmp/out', onProgress: log }));
  console.log('=== single chapter + stitch ==='); console.log(await grab(base+'chapter-2/', { outDir:'/tmp/out2', stitch:true, onProgress: log }));
  console.log('=== one-cbz, -e 1,3 ==='); console.log(await grab(base, { outDir:'/tmp/out3', oneCbz:true, episodes:'1,3', onProgress: log }));
  srv.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
