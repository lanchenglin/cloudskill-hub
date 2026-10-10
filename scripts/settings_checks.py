"""Additional UI checks against the disposable server started by browser-smoke.py."""
from pathlib import Path
import json, os

def check_settings_layout(page, creds):
    page.locator('[data-view="security"]').click()
    page.locator('#tokenTotal').filter(has_text='2').wait_for()
    assert page.locator('#view-security #projectForm').count() == 0
    assert page.locator('#view-security #passwordForm').count() == 0
    assert page.locator('#view-projects #projectForm').count() == 1
    assert page.locator('#view-account #passwordForm').count() == 1
    assert page.locator('#tokenDangerZone').get_attribute('open') is None
    assert page.locator('#revokeAllTokens').is_hidden()
    # Only metadata is used for filters. The original permissions and values remain on the server.
    page.locator('#tokenRoleFilter').select_option('shared_writer')
    assert page.locator('#tokensList .token-row').count() == 1
    page.locator('#tokenStatusFilter').select_option('active')
    assert page.locator('#tokensList .token-row').count() == 0
    assert '没有匹配' in page.locator('#tokensList').inner_text()
    page.locator('#tokenRoleFilter').select_option('all_writer')
    assert page.locator('#tokensList .token-row').count() == 1
    page.locator('#tokenSearch').fill('  ALL-editing ')
    assert page.locator('#tokensList .token-row').count() == 1
    page.locator('#tokenSearch').fill('does-not-exist')
    assert page.locator('#tokensList .token-row').count() == 0
    page.locator('#tokenSearch').fill('')
    page.locator('#tokenRoleFilter').select_option('')
    page.locator('#tokenStatusFilter').select_option('')
    assert page.locator('#tokensList .token-row').count() == 2

    def failed_list(route):
        if route.request.method == 'GET':
            route.fulfill(status=503, content_type='application/json', body=json.dumps({'error':'Temporary test outage'}))
        else: route.continue_()
    page.route('**/api/tokens', failed_list)
    page.locator('#refreshTokens').click()
    page.locator('#tokenListError').wait_for(state='visible')
    assert '加载失败' in page.locator('#tokenSummary').inner_text()
    page.unroute('**/api/tokens', failed_list)
    page.locator('#refreshTokens').click()
    page.locator('#tokensList .token-row').first.wait_for()
    assert page.locator('#tokenListError').is_hidden()

    screenshot_dir=os.environ.get('UI_SCREENSHOT_DIR')
    if screenshot_dir: Path(screenshot_dir).mkdir(parents=True,exist_ok=True)
    for width in [1440, 1024, 768, 390, 320]:
        page.set_viewport_size({'width':width,'height':900 if width>680 else 844})
        for view in ['security','projects','account']:
            page.locator('[data-view="'+view+'"]').click()
            page.locator('#view-'+view).wait_for(state='visible')
            assert page.locator('[data-view="'+view+'"]').get_attribute('aria-current') == 'page'
            overflow=page.evaluate('document.documentElement.scrollWidth')
            assert overflow<=width+2, (width,view,overflow)
            button=page.locator('#logout')
            assert button.is_visible() and button.inner_text()=='退出登录'
            box=button.bounding_box()
            assert box['width']>=44 and box['height']>=44 and box['x']>=0 and box['x']+box['width']<=width+1, (width,view,box)
            page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
            box=button.bounding_box()
            assert box['y']>=0 and box['y']+box['height']<=page.viewport_size['height'], (width,view,box)
            page.evaluate('window.scrollTo(0,0)')
            if screenshot_dir and width in [1440,390]:
                # No token dialogs are open; only synthetic labels and status metadata appear.
                assert page.locator('#tokenRevealValue').inner_text()==''
                assert page.locator('#issuedValue').inner_text()==''
                page.screenshot(path=str(Path(screenshot_dir)/(view+'-'+str(width)+'.png')),full_page=True)
        page.locator('[data-view="security"]').click()
        page.locator('#openTokenCreate').click(); page.locator('#tokenCreateDialog').wait_for(state='visible')
        assert page.evaluate('document.documentElement.scrollWidth')<=width+2
        assert page.locator('#tokenLabel').evaluate('(e)=>document.activeElement===e')
        page.keyboard.press('Escape');page.locator('#tokenCreateDialog').wait_for(state='hidden')
    # Mobile logout is a real action, not just a visible icon. A failed request must not claim success.
    page.set_viewport_size({'width':390,'height':844})
    def fail_logout(route): route.abort('failed')
    page.route('**/api/auth/logout',fail_logout)
    page.locator('#logout').click()
    page.locator('#toast').filter(has_text='退出未完成').wait_for(state='visible')
    assert page.locator('#dashboard').is_visible() and page.locator('#logout').is_enabled()
    assert page.request.get(creds['url']+'/api/auth/session').status==200
    page.unroute('**/api/auth/logout',fail_logout)
    page.locator('[data-view="account"]').click();page.locator('#accountLogout').click()
    page.locator('#auth-card').wait_for(state='visible')
    assert page.request.get(creds['url']+'/api/auth/session').status==401
    assert page.locator('#logout').is_hidden() and page.locator('#sessionControls').is_hidden()
    assert page.locator('#tokenRevealValue').inner_text()=='' and page.locator('#tokensList').inner_text()==''
    page.reload();page.locator('#auth-card').wait_for(state='visible')
    page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill(creds['password'])
    page.locator('#authBtn').click();page.locator('#dashboard').wait_for(state='visible')
    # Slow catalog responses from an old session must not refill private UI after logout.
    held=[]
    def hold_catalog(route): held.append((route,route.fetch()))
    page.route('**/api/catalog',hold_catalog)
    page.reload()
    for _ in range(100):
        if held: break
        page.wait_for_timeout(20)
    assert len(held)==1
    page.locator('#logout').click();page.locator('#auth-card').wait_for(state='visible')
    held[0][0].fulfill(response=held[0][1]);page.unroute('**/api/catalog',hold_catalog)
    page.wait_for_timeout(100)
    assert page.locator('#skillsGrid').inner_text()=='' and page.locator('#projectList').inner_text()==''
    page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill(creds['password'])
    page.locator('#authBtn').click();page.locator('#dashboard').wait_for(state='visible')
    page.set_viewport_size({'width':1440,'height':1000})
