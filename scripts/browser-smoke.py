"""Optional Chromium UI integration check: python scripts/browser-smoke.py.
Requires playwright + Chromium (or CHROMIUM_PATH). Uses only a disposable local server.
"""
from pathlib import Path
import json, os, shutil, subprocess, tempfile, time, zipfile
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='csh-browser-',dir=os.environ.get('BROWSER_TEMP_DIR')) as td:
    tmp=Path(td); auth=tmp/'auth.json'
    md='---\nname: browser-skill\ndescription: Browser integration test.\nmetadata:\n  hermes:\n    tags: [browser]\n---\n# Browser Skill\nUse safely.\n'
    with zipfile.ZipFile(tmp/'skill.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('browser-skill/',b'')
        z.writestr('browser-skill/SKILL.md',md)
        z.writestr('browser-skill/references/说明.md','中文引用资料\n')
        z.writestr('browser-skill/scripts/check.sh','echo test\n')
    with zipfile.ZipFile(tmp/'unsafe.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('SKILL.md',md); z.writestr('.env','DO_NOT_UPLOAD=1')
    env=dict(os.environ,BROWSER_AUTH_FILE=str(auth))
    log=(tmp/'server.log').open('w')
    server=subprocess.Popen(['node','test/browser-server.mjs'],cwd=root,env=env,stdout=log,stderr=log)
    try:
        for _ in range(100):
            if auth.exists(): break
            if server.poll() is not None: raise RuntimeError((tmp/'server.log').read_text())
            time.sleep(.1)
        creds=json.loads(auth.read_text());errors=[]
        with sync_playwright() as p:
            executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
            options={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage'],'downloads_path':str(tmp/'downloads')}
            if executable: options['executable_path']=executable
            browser=p.chromium.launch(**options)
            page=browser.new_page(viewport={'width':1440,'height':1000},accept_downloads=True)
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(creds['url'])
            page.locator('#setupPanel').wait_for(state='visible');page.locator('#setupPanel summary').click()
            page.locator('#setupSecret').fill(creds['bootstrapSecret'])
            page.locator('#setupUsername').fill(creds['username'])
            assert page.locator('#setupPassword').input_value() == 'lanchenglin'
            page.locator('#setupBtn').click()
            page.locator('#forcePasswordPanel').wait_for(state='visible')
            assert page.locator('#dashboard').is_hidden()
            page.keyboard.press('Escape')
            assert page.locator('#forcePasswordPanel').is_visible()
            page.reload();page.locator('#forcePasswordPanel').wait_for(state='visible')
            assert page.locator('[data-view="security"]').is_disabled()
            assert page.evaluate("async () => (await fetch('/api/catalog')).status") == 403
            for width in [390, 320]:
                page.set_viewport_size({'width':width,'height':844})
                assert page.evaluate('document.documentElement.scrollWidth') <= width+2
            page.set_viewport_size({'width':1440,'height':1000})
            page.locator('#forceCurrentPassword').fill('lanchenglin')
            page.locator('#forceBootstrapSecret').fill('incorrect-proof')
            page.locator('#forceNewPassword').fill(creds['password']);page.locator('#forceNewPasswordAgain').fill(creds['password'])
            page.locator('#forcePasswordSubmit').click()
            page.locator('#forcePasswordError').filter(has_text='初始化 Secret').wait_for()
            assert page.locator('#dashboard').is_hidden()
            page.locator('#forceBootstrapSecret').fill(creds['bootstrapSecret'])
            page.locator('#forcePasswordSubmit').click();page.locator('#auth-card').wait_for(state='visible')
            page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill(creds['password'])
            page.locator('#authBtn').click();page.locator('#dashboard').wait_for(state='visible')
            assert page.evaluate('document.cookie').find('csh_dev_session') == -1
            assert page.evaluate("sessionStorage.getItem('csh-token')") is None
            page.reload();page.locator('#dashboard').wait_for(state='visible')
            page.locator('[data-view="security"]').click()
            page.locator('#newProjectSlug').fill('devops');page.locator('#newProjectTitle').fill('DevOps')
            page.locator('#projectForm button[type="submit"]').click()
            page.locator('#tokenScope input[value="devops"]').wait_for()
            page.locator('#tokenLabel').fill('Hermes-A');page.locator('#tokenRole').select_option('publisher')
            page.locator('#tokenScope input[value="devops"]').check();page.locator('#tokenForm button[type="submit"]').click()
            page.locator('#issuedValue').filter(has_text='csh_').wait_for()
            page.locator('#tokensList').filter(has_text='发布者').wait_for()
            page.locator('#dashboard').wait_for(state='visible')
            page.locator('[data-view="publish"]').click()
            page.locator('#uploadLimits').filter(has_text='50 MiB').wait_for()
            page.locator('#skillZip').set_input_files({'name':'skill.zip','mimeType':'application/zip','buffer':(tmp/'skill.zip').read_bytes()})
            try:
                page.locator('#pickedFiles').filter(has_text='已选择 3 个文件').wait_for(timeout=10000)
            except Exception:
                print('Upload precheck state:', page.locator('#pickedFiles').text_content())
                print('Browser errors:', errors)
                raise
            page.locator('#publishSubmit').click()
            page.locator('.skill-card').filter(has_text='browser-skill').wait_for(timeout=15000)
            page.locator('.skill-card').filter(has_text='browser-skill').click()
            page.locator('#detailBody textarea').wait_for();page.locator('#detailBody textarea').fill(md+'\nBrowser edited.\n')
            page.get_by_role('button',name='保存为新版本',exact=True).click()
            page.locator('#detailDialog').wait_for(state='hidden',timeout=15000)
            page.locator('.skill-card').filter(has_text='v2').wait_for()
            page.locator('.skill-card').filter(has_text='browser-skill').click()
            with page.expect_download() as dl:
                page.get_by_role('button',name='下载此版本 ZIP',exact=True).click()
            dl.value.save_as(tmp/'download.zip')
            with zipfile.ZipFile(tmp/'download.zip') as z:
                assert z.testzip() is None
                assert b'Browser edited.' in z.read('SKILL.md')
                assert z.read('references/说明.md').decode()=='中文引用资料\n'
            page.keyboard.press('Escape');page.locator('[data-view="publish"]').click()
            page.locator('#skillZip').set_input_files({'name':'unsafe.zip','mimeType':'application/zip','buffer':(tmp/'unsafe.zip').read_bytes()})
            page.locator('#pickedFiles').filter(has_text='Unsafe path').wait_for()
            assert not page.locator('#pickedFiles').inner_text().startswith('已选择')
            page.set_viewport_size({'width':390,'height':844})
            for width in [390, 320]:
                page.set_viewport_size({'width':width,'height':844})
                overflow=page.evaluate("""() => ({width:innerWidth, scroll:document.documentElement.scrollWidth,
                    elements:[...document.querySelectorAll('body *')].filter(el => {
                        const r=el.getBoundingClientRect(); return r.width && (r.right > innerWidth + 2 || r.left < -2);
                    }).slice(0,20).map(el => ({tag:el.tagName,id:el.id,classes:el.className,
                        width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right}))})""")
                assert overflow['scroll'] <= width+2, f'Mobile horizontal overflow: {overflow}'

            if os.environ.get('BROWSER_SCREENSHOT'):
                page.screenshot(path=os.environ['BROWSER_SCREENSHOT'],full_page=True)
            page.set_viewport_size({'width':1440,'height':1000})
            page.locator('[data-view="security"]').click()
            page.locator('#currentPassword').fill(creds['password'])
            changed='Browser changed test password 67890'
            page.locator('#newPassword').fill(changed);page.locator('#newPasswordAgain').fill(changed)
            page.locator('#passwordForm button[type="submit"]').click();page.locator('#auth-card').wait_for(state='visible')
            page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill(changed)
            page.locator('#authBtn').click();page.locator('#dashboard').wait_for(state='visible')
            page.locator('#logout').click();page.locator('#auth-card').wait_for(state='visible')
            page.reload();page.locator('#auth-card').wait_for(state='visible')
            assert page.locator('#dashboard').is_hidden()
            assert not errors,errors
            browser.close()
        print('PASS: Chromium default password, mandatory first change (refresh/Escape/API rejection), HttpOnly session reload, publisher issuance, ZIP upload/edit/download, password change/logout, unsafe ZIP rejection and mobile layout')
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill();server.wait()
        log.close()
