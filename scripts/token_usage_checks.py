"""Per-token contextual usage: only temporary test credentials, never user tokens."""
from playwright.sync_api import expect

def check_issued_token_usage(page, record):
    # The new token can open its own guide directly, including after the create dialog closes.
    page.locator('#useIssued').click()
    expect(page.locator('#tokenRevealDialog')).to_be_visible()
    assert record['token'] in page.locator('#tokenUsePrompt').input_value()
    page.locator('#hideTokenValue').click()
    assert page.locator('#tokenUsePrompt').input_value() == ''

def check_token_usage(page, creds, shared, all_token):
    row=page.locator('#tokensList .token-row').filter(has_text='Shared-editing')
    row.locator('.token-name-button').click()
    expect(page.locator('#tokenRevealDialog')).to_be_visible()
    prompt=page.locator('#tokenUsePrompt').input_value()
    assert shared['token'] in prompt and all_token['token'] not in prompt
    assert creds['url']+'/usage.md' in prompt and len(prompt)<800
    assert '等我选定后' in prompt and '本次只读取' in prompt
    assert '共享与私有' not in prompt
    assert not page.locator('#tokenUseTerminal').evaluate('(el)=>el.open')
    page.context.grant_permissions(['clipboard-read','clipboard-write'],origin=creds['url'])
    for agent in ['claude','codex','hermes']:
        page.locator('[data-token-agent="'+agent+'"]').click()
        expect(page.locator('[data-token-agent="'+agent+'"]').first).to_have_attribute('aria-pressed','true')
        assert '--agents '+agent in page.locator('#tokenUsePrompt').input_value()
    page.locator('#copyTokenUsePrompt').click()
    assert page.evaluate('navigator.clipboard.readText()') == page.locator('#tokenUsePrompt').input_value()
    page.locator('#tokenUseTerminal summary').click()
    page.locator('#tokenUseShell').select_option('powershell')
    code=page.locator('#tokenUseCommands').inner_text()
    assert shared['token'] in code and '$env:CLOUDSKILL_TOKEN' in code and 'finally' in code
    page.locator('#copyTokenUseCommands').click()
    assert page.evaluate('navigator.clipboard.readText()') == code
    for width in [1440,768,390,320]:
        page.set_viewport_size({'width':width,'height':1000 if width>700 else 844})
        assert page.evaluate('document.documentElement.scrollWidth') <= width+2
        assert page.locator('#tokenRevealDialog').evaluate('(el)=>el.scrollWidth<=el.clientWidth+2')
    page.set_viewport_size({'width':1440,'height':1000})
    page.keyboard.press('Escape')
    assert page.locator('#tokenUsePrompt').input_value() == ''
    assert page.locator('#tokenUseCommands').text_content() == ''
    assert page.locator('#tokenRevealValue').text_content() == ''
    row=page.locator('#tokensList .token-row').filter(has_text='All-editing')
    row.get_by_role('button',name='使用说明',exact=True).click()
    expect(page.locator('#tokenRevealDialog')).to_be_visible()
    assert all_token['token'] in page.locator('#tokenUsePrompt').input_value()
    assert shared['token'] not in page.locator('#tokenUsePrompt').input_value()
    assert '共享与私有' in page.locator('#tokenUsePrompt').input_value()
    assert all_token['token'] not in page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)')
    page.locator('#hideTokenValue').click()

def check_revoked_token_usage(page, record):
    row=page.locator('#tokensList .token-row').filter(has_text='Shared-editing')
    row.get_by_role('button',name='使用说明',exact=True).click()
    expect(page.locator('#tokenRevealDialog')).to_be_visible()
    assert page.locator('#tokenRevealValue').text_content() == record['token']
    assert page.locator('#tokenUsePrompt').input_value() == ''
    assert page.locator('#tokenUseCommands').text_content() == ''
    expect(page.locator('#copyTokenUsePrompt')).to_be_disabled()
    expect(page.locator('#copyTokenUseCommands')).to_be_disabled()
    page.locator('#hideTokenValue').click()
