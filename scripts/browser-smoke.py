"""Optional Chromium UI integration check: python scripts/browser-smoke.py.
Requires playwright + Chromium (or CHROMIUM_PATH). Uses only a disposable local server.
"""
from pathlib import Path
import json, os, shutil, subprocess, tempfile, time, zipfile
from playwright.sync_api import sync_playwright

def check_password_bounds(page, first, again, form):
    # Same browser rule as the backend; include astral characters and preserve pasted text.
    for value in ['abcde', 'x'*21, '🔑'*5]:
        page.locator(first).fill(value); page.locator(again).fill(value)
        assert page.locator(first).input_value() == value
        assert not page.locator(form).evaluate('(el) => el.checkValidity()')
    for value in ['abcdef', 'x'*20, '🔑'*20, '中文密码测试']:
        page.locator(first).fill(value); page.locator(again).fill(value)
        assert page.locator(first).input_value() == value
        assert page.locator(form).evaluate('(el) => el.checkValidity()')
    page.locator(again).fill('other6')
    assert not page.locator(form).evaluate('(el) => el.checkValidity()')

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
            check_password_bounds(page,'#setupPassword','#setupPasswordAgain','#setupForm')
            page.locator('#setupPassword').fill('lanchenglin');page.locator('#setupPasswordAgain').fill('lanchenglin')
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
            assert page.locator('#forceBootstrapSecret').count() == 0
            assert page.locator('#activationProof').count() == 0
            # A new login after a refresh must still show only the password-change form.
            page.locator('#forceLogout').click();page.locator('#auth-card').wait_for(state='visible')
            page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill('lanchenglin')
            page.locator('#authBtn').click();page.locator('#forcePasswordPanel').wait_for(state='visible')
            page.locator('#forceCurrentPassword').fill('lanchenglin')
            check_password_bounds(page,'#forceNewPassword','#forceNewPasswordAgain','#forcePasswordForm')
            page.locator('#forceNewPassword').fill(creds['password']);page.locator('#forceNewPasswordAgain').fill(creds['password'])
            with page.expect_request(lambda req: req.url.endswith('/api/auth/password') and req.method == 'POST') as changed_request:
                page.locator('#forcePasswordSubmit').click()
            assert set(changed_request.value.post_data_json) == {'currentPassword', 'newPassword'}
            page.locator('#auth-card').wait_for(state='visible')
            page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill(creds['password'])
            page.locator('#authBtn').click();page.locator('#dashboard').wait_for(state='visible')
            assert page.evaluate('document.cookie').find('csh_dev_session') == -1
            assert page.evaluate("sessionStorage.getItem('csh-token')") is None
            page.reload();page.locator('#dashboard').wait_for(state='visible')
            page.locator('[data-view="security"]').click()
            page.locator('#newProjectSlug').fill('devops');page.locator('#newProjectTitle').fill('DevOps')
            page.locator('#projectForm button[type="submit"]').click()
            page.locator('#publishProject option[value="devops"]').wait_for(state='attached')
            assert page.locator('#tokenScope').count() == 0
            assert page.locator('#tokenRole option').evaluate_all('(els) => els.map(e => e.value)') == ['shared_writer','all_writer']
            page.locator('#tokenLabel').fill('Shared-editing');page.locator('#tokenRole').select_option('shared_writer')
            assert page.locator('#tokenDays').input_value() == '90'
            page.locator('#tokenDays').select_option('never')
            with page.expect_response(lambda response: response.url.endswith('/api/tokens') and response.request.method == 'POST') as issued_response:
                page.locator('#tokenForm button[type="submit"]').click()
            permanent=issued_response.value.json()
            assert issued_response.value.status == 201 and permanent['expiresAt'] is None
            assert issued_response.value.request.post_data_json['expiresInDays'] is None
            assert permanent['role'] == 'shared_writer' and permanent['projects'] == []
            assert 'projects' not in issued_response.value.request.post_data_json
            page.locator('#tokensList .row-card').filter(has_text='Shared-editing').filter(has_text='永久有效').wait_for()
            page.locator('#tokenLabel').fill('All-editing');page.locator('#tokenRole').select_option('all_writer')
            page.locator('#tokenDays').select_option('30')
            with page.expect_response(lambda response: response.url.endswith('/api/tokens') and response.request.method == 'POST') as finite_response:
                page.locator('#tokenForm button[type="submit"]').click()
            finite=finite_response.value.json()
            assert finite_response.value.status == 201 and isinstance(finite['expiresAt'],str)
            assert finite_response.value.request.post_data_json['expiresInDays'] == 30
            page.locator('#issuedValue').filter(has_text='csh_').wait_for()
            page.locator('#tokensList').filter(has_text='修改共享技能').wait_for()
            page.reload();page.locator('#dashboard').wait_for(state='visible')
            page.locator('[data-view="security"]').click()
            permanent_row=page.locator('#tokensList .row-card').filter(has_text='Shared-editing')
            permanent_row.filter(has_text='永久有效').wait_for()
            # Refresh never contains token values; only an explicit administrator reveal returns one.
            listed=page.request.get(creds['url']+'/api/tokens').json()
            assert listed['tokenStorage']['configured'] is True
            assert all(t['recoverable'] for t in listed['tokens'])
            assert permanent['token'] not in json.dumps(listed) and finite['token'] not in json.dumps(listed)
            assert permanent['token'] not in page.locator('body').inner_text()
            page.context.grant_permissions(['clipboard-read','clipboard-write'],origin=creds['url'])
            permanent_row.get_by_role('button',name='查看 / 复制',exact=True).click()
            page.locator('#tokenRevealDialog').wait_for(state='visible')
            assert page.locator('#tokenRevealValue').inner_text() == permanent['token']
            page.locator('#copyTokenValue').click()
            assert page.evaluate('navigator.clipboard.readText()') == permanent['token']
            page.locator('#hideTokenValue').click()
            assert page.locator('#tokenRevealValue').inner_text() == ''
            assert page.locator('#tokenRevealDialog').is_hidden()
            permanent_row.get_by_role('button',name='查看 / 复制',exact=True).click()
            page.locator('#tokenRevealDialog').wait_for(state='visible')
            page.keyboard.press('Escape')
            assert page.locator('#tokenRevealValue').inner_text() == ''
            # A response arriving after logout must not show its secret.
            held=[]
            def hold_reveal(route):
                held.append((route,route.fetch()))
            page.route('**/api/tokens/*/reveal',hold_reveal)
            permanent_row.get_by_role('button',name='查看 / 复制',exact=True).click()
            for _ in range(50):
                if held: break
                page.wait_for_timeout(20)
            assert len(held) == 1
            page.locator('#logout').click();page.locator('#auth-card').wait_for(state='visible')
            held[0][0].fulfill(response=held[0][1]);page.unroute('**/api/tokens/*/reveal',hold_reveal)
            page.wait_for_timeout(100)
            assert page.locator('#tokenRevealValue').inner_text() == '' and page.locator('#tokenRevealDialog').is_hidden()
            assert page.locator('#issuedValue').inner_text() == ''
            page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill(creds['password'])
            page.locator('#authBtn').click();page.locator('#dashboard').wait_for(state='visible')
            page.locator('[data-view="security"]').click()
            permanent_row.get_by_role('button',name='查看 / 复制',exact=True).click()
            page.locator('#tokenRevealDialog').wait_for(state='visible')
            assert page.locator('#tokenRevealValue').inner_text() == permanent['token']
            assert permanent['token'] not in page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)')
            for width in [320,390]:
                page.set_viewport_size({'width':width,'height':844})
                assert page.evaluate('document.documentElement.scrollWidth') <= width+2
            page.set_viewport_size({'width':1440,'height':1000})
            page.locator('#hideTokenValue').click()
            assert page.request.get(creds['url']+'/api/me',headers={'Authorization':'Bearer '+permanent['token']}).status == 200
            page.once('dialog',lambda dialog: dialog.accept())
            with page.expect_response(lambda response: response.url.endswith('/api/tokens/'+permanent['id']+'/revoke')) as revoked_response:
                permanent_row.get_by_role('button',name='撤销',exact=True).click()
            assert revoked_response.value.status == 200
            page.locator('#tokensList .row-card').filter(has_text='Shared-editing').filter(has_text='已撤销').wait_for()
            assert page.request.get(creds['url']+'/api/me',headers={'Authorization':'Bearer '+permanent['token']}).status == 401
            assert page.request.get(creds['url']+'/api/me',headers={'Authorization':'Bearer '+finite['token']}).status == 200
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
            page.locator('#makePublic').check()
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
            guest=browser.new_context(accept_downloads=True)
            public_page=guest.new_page()
            public_page.goto(creds['url']+'/shared.html')
            public_page.locator('#sharedGrid .skill-card').filter(has_text='browser-skill').click()
            public_page.locator('#sharedText').filter(has_text='Browser edited.').wait_for()
            assert guest.cookies() == []
            with public_page.expect_download() as guest_download:
                public_page.locator('#sharedDownload').click()
            guest_download.value.save_as(tmp/'guest.zip')
            with zipfile.ZipFile(tmp/'guest.zip') as z:
                assert z.testzip() is None and b'Browser edited.' in z.read('SKILL.md')
            guest.close()
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
            check_password_bounds(page,'#newPassword','#newPasswordAgain','#passwordForm')
            changed='🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑'
            page.locator('#newPassword').fill(changed);page.locator('#newPasswordAgain').fill(changed)
            page.locator('#passwordForm button[type="submit"]').click();page.locator('#auth-card').wait_for(state='visible')
            page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill(changed)
            page.locator('#authBtn').click();page.locator('#dashboard').wait_for(state='visible')
            page.locator('#logout').click();page.locator('#auth-card').wait_for(state='visible')
            page.reload();page.locator('#auth-card').wait_for(state='visible')
            assert page.locator('#dashboard').is_hidden()
            assert not errors,errors
            browser.close()
        print('PASS: Chromium token reveal/copy/hide after refresh and re-login, no secret storage/list leaks, stale reveal after logout discarded; 6–20 password boundaries/Unicode and confirmation for setup/first change/normal change; default password, mandatory first change without bootstrap proof (refresh/re-login/Escape/API rejection), HttpOnly session reload, shared/all writer token issuance, anonymous shared downloads and revocation, ZIP upload/edit/download, password change/logout, unsafe ZIP rejection and mobile layout')
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill();server.wait()
        log.close()
