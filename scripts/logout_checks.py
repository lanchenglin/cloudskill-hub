"""Logout regression checks; all requests target browser-smoke's disposable local server."""
from playwright.sync_api import Error as PlaywrightError

def sign_in(page,creds):
    page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill(creds['password'])
    page.locator('#authBtn').click();page.locator('#dashboard').wait_for(state='visible')

def check_upload_logout(page,creds):
    page.locator('[data-view="publish"]').click()
    page.locator('#skillFile').set_input_files({'name':'SKILL.md','mimeType':'text/markdown','buffer':b'---\nname: logout-check\ndescription: Disposable upload cancellation check.\n---\nSafe test.\n'})
    page.locator('#pickedFiles').filter(has_text='已选择 1 个文件').wait_for()
    held=[]
    def hold_upload(route): held.append(route)
    page.route('**/api/uploads/*/archive',hold_upload)
    page.locator('#publishSubmit').click()
    for _ in range(100):
        if held: break
        page.wait_for_timeout(20)
    assert len(held)==1
    confirmations=[]
    def cancel(dialog):
        confirmations.append(dialog.message);dialog.dismiss()
    page.once('dialog',cancel);page.locator('#logout').click()
    assert len(confirmations)==1 and '上传' in confirmations[0]
    assert page.locator('#dashboard').is_visible() and page.locator('#publishSubmit').is_disabled()
    page.once('dialog',lambda dialog: dialog.accept());page.locator('#logout').click()
    page.locator('#auth-card').wait_for(state='visible')
    assert page.request.get(creds['url']+'/api/auth/session').status==401
    try: held[0].abort()
    except PlaywrightError: pass  # AbortController may already have cancelled this local request.
    page.unroute('**/api/uploads/*/archive',hold_upload)
    page.wait_for_timeout(100)
    assert page.locator('#tokenRevealValue').inner_text()==''
    sign_in(page,creds)
    # One pending logout request cannot be duplicated through a second UI entry.
    held=[]
    def hold_logout(route): held.append((route,route.fetch()))
    page.route('**/api/auth/logout',hold_logout)
    page.locator('#logout').click()
    for _ in range(100):
        if held: break
        page.wait_for_timeout(20)
    assert len(held)==1
    assert page.locator('#logout').is_disabled() and page.locator('#accountLogout').is_disabled()
    page.locator('#accountLogout').evaluate('(button)=>button.dispatchEvent(new MouseEvent("click",{bubbles:true}))')
    assert len(held)==1
    # Refreshing public setup status is secondary: a failure here must not undo confirmed logout.
    def fail_status(route):route.fulfill(status=503,content_type='application/json',body='{"error":"Temporary test outage"}')
    page.route('**/api/auth/status',fail_status)
    held[0][0].fulfill(response=held[0][1]);page.unroute('**/api/auth/logout',hold_logout)
    page.locator('#auth-card').wait_for(state='visible')
    page.locator('#toast').filter(has_text='已退出当前浏览器').wait_for(state='visible')
    assert page.request.get(creds['url']+'/api/auth/session').status==401
    page.unroute('**/api/auth/status',fail_status)
    sign_in(page,creds)
