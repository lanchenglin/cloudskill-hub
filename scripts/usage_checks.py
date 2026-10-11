"""Usage-page checks against the disposable browser fixture, never a production Hub."""
from pathlib import Path
import os, re
from playwright.sync_api import expect

def check_usage_guide(page, creds, browser):
    origin=creds['url']
    # Create one non-sensitive PRIVATE fixture to verify that hints stay session-local.
    response=page.evaluate("""async () => {
      const session=await (await fetch('/api/auth/session')).json();
      return (await fetch('/api/projects/devops/skills/guide-private', {method:'POST',
        headers:{'Content-Type':'application/json','X-CloudSkill-Request':'1','X-CSRF-Token':session.csrfToken},
        body:JSON.stringify({visibility:'private',files:{'SKILL.md':btoa('---\\nname: guide-private\\ndescription: Private guide fixture without credentials.\\n---\\n# Test\\n')}})})).status;
    }""")
    assert response == 201
    page.reload();page.locator('#dashboard').wait_for(state='visible')
    page.locator('[data-view="help"]').click()
    expect(page.locator('#view-help')).to_be_visible()
    expect(page.locator('#guidePrompt')).to_have_value(re.compile('未选定前不要安装'))
    assert origin+'/usage.md' in page.locator('#guidePrompt').input_value()
    page.locator('#guideExisting').select_option('devops/guide-private')
    assert page.locator('#guideAccess').input_value() == 'private'
    prompt=page.locator('#guidePrompt').input_value()
    assert 'cloudskill login' in prompt and '修改全部技能' in prompt
    assert 'devops/guide-private' in prompt and creds['password'] not in prompt
    assert 'cloudskill connect' not in page.locator('#usageGuide [data-guide="commands"]').inner_text()
    page.locator('#guideAgent').select_option('claude')
    assert '--agents claude --dry-run' in page.locator('#guidePrompt').input_value()
    page.context.grant_permissions(['clipboard-read','clipboard-write'],origin=origin)
    page.locator('#usageGuide [data-guide="copy-prompt"]').click()
    expect(page.locator('#usageGuide [data-guide="copy-status"]')).to_contain_text('已复制')
    assert page.evaluate('navigator.clipboard.readText()') == page.locator('#guidePrompt').input_value()
    page.locator('#guideProject').fill('bad; command')
    expect(page.locator('#usageGuide [data-guide="copy-prompt"]')).to_be_disabled()
    assert page.locator('#guidePrompt').input_value() == ''
    assert page.locator('#usageGuide [data-guide="commands"]').inner_text() == ''
    page.locator('#guideProject').fill('devops')
    page.locator('#guideTask').select_option('update')
    commands=page.locator('#usageGuide [data-guide="commands"]').inner_text()
    assert 'cloudskill update --dry-run' in commands and '--agents' not in commands
    assert page.locator('#guideAgent').is_disabled()
    assert page.locator('#guideProject').is_hidden()
    page.locator('#guideTask').select_option('publish')
    page.locator('#guideShell').select_option('powershell')
    page.locator('#guideSource').fill("C:\\skills\\owner's-skill")
    assert "'C:\\skills\\owner''s-skill' --private" in page.locator('#usageGuide [data-guide="commands"]').inner_text()
    page.locator('#guideTask').select_option('install')
    assert "owner's-skill" not in page.locator('#guidePrompt').input_value()
    page.locator('[data-view="library"]').click()
    page.locator('.skill-card').filter(has_text='guide-private').click()
    page.locator('#detailBody').get_by_role('button',name='让 AI 安装',exact=True).click()
    assert page.locator('#view-help').is_visible()
    assert page.locator('#guideProject').input_value() == 'devops'
    assert page.locator('#guideSkill').input_value() == 'guide-private'
    assert page.locator('#guideAccess').input_value() == 'private'
    # Screenshots only use the public fixture name and contain no user data.
    page.locator('#guideExisting').select_option('devops/browser-skill')
    page.locator('#guideAgent').select_option('hermes')
    preview=os.environ.get('GUIDE_SCREENSHOT_DIR')
    if preview: Path(preview).mkdir(parents=True,exist_ok=True)
    for width in [1440,1024,768,390,320]:
        page.set_viewport_size({'width':width,'height':1000 if width>700 else 844})
        page.evaluate('window.scrollTo(0,0)')
        assert page.evaluate('document.documentElement.scrollWidth') <= width+2
        expect(page.locator('#logout')).to_be_visible()
        if preview and width in [1440,390]: page.screenshot(path=str(Path(preview)/f'usage-{width}.png'),full_page=True)
    page.set_viewport_size({'width':1440,'height':1000})
    guest=browser.new_context()
    try:
        public=guest.new_page();calls=[]
        public.on('request',lambda req:calls.append(req.url))
        public.goto(origin+'/usage.html?project=devops&skill=browser-skill&token=never-render-query-secret&hub=https://attacker.example')
        expect(public.locator('#guidePrompt')).to_have_value(re.compile('devops/browser-skill'))
        expect(public.locator('#guideExisting option[value="devops/browser-skill"]')).to_have_count(1)
        assert 'guide-private' not in public.locator('body').text_content()
        assert 'never-render-query-secret' not in public.locator('body').text_content()
        assert 'attacker.example' not in public.locator('#guidePrompt').input_value()
        assert all('/api/public/' in url for url in calls if '/api/' in url)
        assert guest.cookies() == []
        text=guest.request.get(origin+'/usage.md?token=never-render-query-secret').text()
        assert origin in text and 'guide-private' not in text and 'never-render-query-secret' not in text
        assert 'Node 至少22.16' in text
        public.context.grant_permissions(['clipboard-read','clipboard-write'],origin=origin)
        public.locator('[data-guide="copy-link"]').click()
        expect(public.locator('[data-guide="copy-status"]')).to_contain_text('已复制')
        assert public.evaluate('navigator.clipboard.readText()') == origin+'/usage.md'
        public.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(Error('denied'))}})")
        public.locator('[data-guide="copy-prompt"]').click()
        expect(public.locator('[data-guide="copy-status"]')).to_contain_text('手动选中')
        assert public.locator('#guidePrompt').evaluate('(el)=>el.selectionEnd-el.selectionStart') > 100
        public.set_viewport_size({'width':320,'height':844})
        assert public.evaluate('document.documentElement.scrollWidth') <= 322
        # Public catalog errors do not erase the usable client guide.
        public.route('**/api/public/catalog',lambda route:route.fulfill(status=503,content_type='application/json',body='{}'))
        public.reload()
        expect(public.locator('#guidePublicStatus')).to_contain_text('说明仍可使用')
        assert origin in public.locator('#guidePrompt').input_value()
    finally: guest.close()
    noscript=browser.new_context(java_script_enabled=False)
    try:
        text_page=noscript.new_page();text_page.goto(origin+'/usage.html')
        expect(text_page.get_by_role('link',name='纯文本客户端说明')).to_be_visible()
    finally: noscript.close()
    page.locator('#guideExisting').select_option('devops/guide-private')
    page.locator('#logout').click();page.locator('#auth-card').wait_for(state='visible')
    assert 'guide-private' not in page.locator('#guidePrompt').input_value()
    assert 'guide-private' not in page.locator('#usageGuide').text_content()
    assert page.locator('#guideSource').input_value() == ''
    page.locator('#usernameInput').fill(creds['username']);page.locator('#passwordInput').fill(creds['password'])
    page.locator('#authBtn').click();page.locator('#dashboard').wait_for(state='visible')
