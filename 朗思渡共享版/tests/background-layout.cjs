const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

(async()=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'langsidu-layout-'));
 try{
  const welcomeContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  const welcomePage=await welcomeContext.newPage();
  await welcomePage.goto(process.env.LAYOUT_BASE_URL||'http://127.0.0.1:3000/',{waitUntil:'networkidle'});
  assert.equal(await welcomePage.locator('#welcomeOverlay').isVisible(),true);
  assert.match(await welcomePage.locator('#welcomeOverlay').evaluate(el=>getComputedStyle(el).backgroundImage),/home-background\.webp/);
  await welcomePage.screenshot({path:path.join(out,'welcome-390.png')});
  await welcomeContext.close();
  for(const width of [320,390,1280]){
   const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
   await context.addInitScript(()=>localStorage.setItem('langsidu_state_v5',JSON.stringify({skipWelcome:true,prefs:{accent:'英式'}})));
   const page=await context.newPage();
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(process.env.LAYOUT_BASE_URL||'http://127.0.0.1:3000/',{waitUntil:'networkidle'});
   assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundImage),'none');
   assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(241, 246, 252)');
   assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.app')).backgroundColor),'rgba(0, 0, 0, 0)');
   for(const name of ['now','past','me']){
    const item=page.locator(`[data-nav="${name}"]`);
    await item.click();
    assert.equal(await item.evaluate(el=>el.classList.contains('active')),true,`${name} is active at ${width}px`);
    for(const nav of ['now','past','me']){
     const button=page.locator(`[data-nav="${nav}"]`);
     const css=await button.evaluate(el=>{const icon=el.querySelector('.nav-icon');return {color:getComputedStyle(el).color,iconColor:getComputedStyle(icon).backgroundColor,mask:getComputedStyle(icon).maskImage,size:getComputedStyle(icon).maskSize,width:el.getBoundingClientRect().width,current:el.getAttribute('aria-current'),label:el.innerText.trim()};});
     const expected=nav===name?'rgb(17, 17, 17)':'rgb(115, 119, 125)';
     assert.equal(css.color,expected,`${nav} text color with ${name} selected`);
     assert.equal(css.iconColor,expected,`${nav} icon color with ${name} selected`);
     assert.equal(css.current,nav===name?'page':null);
     assert.equal(css.label,nav.toUpperCase());
     assert.match(css.mask,new RegExp(`nav-icon-${nav}\\.png`));
     assert.equal(css.size,'contain');
     assert.ok(css.width>=44);
    }
    await page.screenshot({path:path.join(out,`${name}-${width}.png`)});
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
