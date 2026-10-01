import asyncio, base64
from playwright.async_api import async_playwright
import os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svg=open(f'{ROOT}/icon.svg').read()
b64=base64.b64encode(svg.encode()).decode()
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        for size,name,pad in ((512,'icon-512.png',0),(192,'icon-192.png',0),(180,'apple-touch-icon.png',0),(512,'icon-maskable-512.png',56)):
            pg=await b.new_page(viewport={'width':size,'height':size})
            bg = '#0A4D49' if pad else 'transparent'
            inner = size - 2*pad
            html=f'<html><body style="margin:0;background:{bg};display:flex;align-items:center;justify-content:center;width:{size}px;height:{size}px"><img src="data:image/svg+xml;base64,{b64}" width="{inner}" height="{inner}"></body></html>'
            await pg.set_content(html)
            await pg.screenshot(path=f'{ROOT}/icons/{name}', omit_background=not pad)
            await pg.close()
        # imagen para compartir en redes (1200x630)
        pg=await b.new_page(viewport={'width':1200,'height':630})
        await pg.goto(f'file://{ROOT}/tools/og-template.html')
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=f'{ROOT}/og-image.png')
        await b.close()
asyncio.run(main())
