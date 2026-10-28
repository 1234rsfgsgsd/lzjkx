const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

(async()=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'langsidu-layout-'));
 try{
  for(const width of [320,390,1280]){
   const context=await browser.newContext({viewport:{width,height:844}});
   await context.addInitScript(()=>localStorage.setItem('langsidu_state_v5',JSON.stringify({skipWelcome:true,prefs:{accent:'英式'}})));
   const page=await context.newPage();
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto('http://127.0.0.1:3000/',{waitUntil:'networkidle'});
   for(const name of ['now','past','me']){
    const item=page.locator(`[data-nav="${name}"]`);
    await item.click();
    assert.equal(await item.evaluate(el=>el.classList.contains('active')),true,`${name} is active at ${width}px`);
    const css=await item.evaluate(el=>({image:getComputedStyle(el).backgroundImage,size:getComputedStyle(el).backgroundSize,width:el.getBoundingClientRect().width}));
    assert.match(css.image,new RegExp(`nav-${name}\\.webp`));
    assert.equal(css.size,width>760?'auto 128px':'auto 98px');
    assert.ok(css.width>=44);
   }
   await page.locator('[data-nav="now"]').click();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`no horizontal overflow at ${width}px`);
   assert.deepEqual(errors,[]);
   await page.screenshot({path:path.join(out,`app-${width}.png`)});
   await context.close();
   console.log(`PASS ${width}px navigation, proportions, selection and overflow`);
  }
  console.log(`Screenshots: ${out}`);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
