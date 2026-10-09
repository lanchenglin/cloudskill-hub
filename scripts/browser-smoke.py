"""Optional Chromium UI integration check: python scripts/browser-smoke.py.
Requires playwright + Chromium (or CHROMIUM_PATH). Uses only a disposable local server.
"""
from pathlib import Path
import json, os, shutil, subprocess, tempfile, time, zipfile
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='csh-browser-') as td:
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
            options={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
            if executable: options['executable_path']=executable
            browser=p.chromium.launch(**options)
            page=browser.new_page(viewport={'width':1440,'height':1000},accept_downloads=True)
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(creds['url']);page.locator('#tokenInput').fill(creds['token']);page.locator('#authBtn').click()
            page.locator('#dashboard').wait_for(state='visible')
            page.locator('[data-view="publish"]').click()
            page.locator('#uploadLimits').filter(has_text='50 MiB').wait_for()
            page.locator('#skillZip').set_input_files(str(tmp/'skill.zip'))
            page.locator('#pickedFiles').filter(has_text='已选择 3 个文件').wait_for()
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
            page.locator('#skillZip').set_input_files(str(tmp/'unsafe.zip'))
            page.locator('#pickedFiles').filter(has_text='Unsafe path').wait_for()
            assert not page.locator('#pickedFiles').inner_text().startswith('已选择')
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'), 'Mobile horizontal overflow'
            if os.environ.get('BROWSER_SCREENSHOT'):
                page.screenshot(path=os.environ['BROWSER_SCREENSHOT'],full_page=True)
            assert not errors,errors
            browser.close()
        print('PASS: Chromium ZIP upload, v2 edit, immutable download+CRC, metadata preservation, unsafe ZIP rejection, mobile layout, no JS errors')
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill();server.wait()
        log.close()
