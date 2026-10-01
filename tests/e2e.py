"""Pruebas de extremo a extremo de READMYFASTA en Chromium (Playwright).

    pip install playwright && python -m playwright install chromium
    python tests/e2e.py                    # arranca su propio servidor y prueba todo
    python tests/e2e.py --shots capturas/  # además guarda capturas en claro y oscuro

Sale con código 1 si falla cualquier comprobación. Variable opcional CHROMIUM_PATH para
usar un Chromium concreto.
"""
import argparse
import asyncio
import functools
import http.server
import os
import sys
import threading
import time
import zipfile

from playwright.async_api import async_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('  ok   ' if cond else '  FALLO ') + name + (f' — {detail}' if detail and not cond else ''))


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm'}

        def log_message(self, *a):
            pass

        def handle(self):
            try:
                super().handle()
            except (BrokenPipeError, ConnectionResetError):
                pass  # el navegador cancela descargas al recargar: no es un error
    handler = functools.partial(Quiet, directory=ROOT)
    # multihilo: el worker, el service worker y la página piden archivos grandes a la vez
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f'http://127.0.0.1:{httpd.server_address[1]}/'


async def waitjs(pg, expr, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        if await pg.evaluate(expr):
            return True
        await asyncio.sleep(0.1)
    return False


async def open_loader(pg):
    if await pg.locator('#loaderBody').is_hidden():
        await pg.click('#loadAnotherBtn')


async def load_example(pg, name, expr, timeout=90):
    await open_loader(pg)
    await pg.click(f'[data-example="{name}"]')
    return await waitjs(pg, expr, timeout)


async def load_text(pg, content, filename):
    await pg.evaluate("([c, n]) => { window.__f = new File([c], n); }", [content, filename])
    await pg.evaluate("() => { const dt = new DataTransfer(); dt.items.add(window.__f);"
                      " const i = document.getElementById('fileInput'); i.files = dt.files;"
                      " i.dispatchEvent(new Event('change')); }")


async def run(shots):
    httpd, base = serve()
    zpath = os.path.join(ROOT, 'tests', '_tmp.zip')
    with zipfile.ZipFile(zpath, 'w') as z:
        z.writestr('a.fasta', '>a\nACGT\n')
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None,
                                          args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader'])
        ctx = await browser.new_context(accept_downloads=True, viewport={'width': 1280, 'height': 900}, locale='es-ES')
        pg = await ctx.new_page()
        errors = []
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'biowasm' not in m.text
              and 'GL Driver' not in m.text and 'Failed to load resource' not in m.text else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.add_init_script("document.addEventListener('securitypolicyviolation', e =>"
                                 " console.error('CSP', e.violatedDirective, e.blockedURI))")
        await pg.goto(base)
        await expect(pg.locator('#engineText')).to_have_text('Motor de análisis listo', timeout=120000)
        check('motor Python listo en el worker', True)
        if shots:
            await pg.screenshot(path=os.path.join(shots, '01_inicio_claro.png'), full_page=True)

        # ---------------------------------------------------------- FASTA
        ok = await load_example(pg, 'fasta', "window.__rmf.state.result && window.__rmf.state.result.summary.count === 40")
        check('FASTA de ejemplo analizado', ok)
        await expect(pg.locator('#listBody tr')).to_have_count(25)
        groups = await pg.locator('.stat-group-title').all_inner_texts()
        check('tarjetas agrupadas (volumen, composición)', any('VOLUMEN' in g.upper() for g in groups), str(groups))
        check('barra de archivo visible', await pg.locator('#fileBar').is_visible())
        check('zona de carga plegada tras analizar', await pg.locator('#loaderBody').is_hidden())
        check('sin avisos en el FASTA limpio', (await pg.locator('#warnings').inner_text()).strip() == '')
        await pg.locator('#listBody button.linklike').first.click()
        await expect(pg.locator('#detailPanel')).to_be_visible()
        focused = await pg.evaluate('document.activeElement.id')
        await pg.keyboard.press('Escape')
        await pg.wait_for_timeout(300)
        check('diálogo: foco al cerrar y Escape', focused == 'detailClose' and await pg.locator('#detailPanel').is_hidden())
        await pg.focus('#tabbtn-lista')
        await pg.keyboard.press('ArrowRight')
        check('pestañas con flechas', await pg.evaluate('document.activeElement.id') == 'tabbtn-buscar')
        await pg.focus('body')
        await pg.keyboard.press('/')
        check('atajo «/» abre la búsqueda', await pg.evaluate('document.activeElement.id') == 'searchInput')
        await pg.fill('#searchInput', 'brca1')
        await pg.press('#searchInput', 'Enter')
        await expect(pg.locator('#searchInfo')).to_contain_text('resultado')
        await pg.click('#tabbtn-motivo')
        await pg.click('[data-motif="GAATTC"]')
        await expect(pg.locator('#motifResults')).to_contain_text('palindrómico')
        check('motivo EcoRI (palíndromo)', True)
        await pg.click('#tabbtn-exportar')
        await pg.fill('#exMinLen', '1000')
        await pg.check('#exGzip')
        async with pg.expect_download() as dl:
            await pg.click('#exportBtn')
        d = await dl.value
        check('exportación .gz', d.suggested_filename.endswith('.fasta.gz'), d.suggested_filename)
        await expect(pg.locator('#toasts .toast').first).to_be_visible()
        check('aviso flotante tras descargar', True)

        # ---------------------------------------------------------- FASTQ
        ok = await load_example(pg, 'fastq', "!!(window.__rmf.state.result && window.__rmf.state.result.run)", 180)
        check('FASTQ de ejemplo analizado', ok)
        await pg.click('#tabbtn-run')
        await pg.wait_for_timeout(500)
        run_txt = await pg.locator('#runContent').inner_text()
        check('pestaña Run: lanes, tiles e índices', 'A00123' in run_txt and '1203' in run_txt and 'ACGTACGA' in run_txt)
        await pg.click('#tabbtn-graficos')
        await pg.wait_for_timeout(700)
        charts = await pg.evaluate("Object.entries(window.__rmf.charts).filter(([k, v]) => v).map(([k]) => k)")
        needed = {'len', 'gc', 'qual', 'comp', 'ee', 'kmer', 'tile', 'dup'}
        check('gráficos FASTQ completos', needed <= set(charts), str(sorted(charts)))
        check('tamaño de genoma estimado', 'kb' in await pg.locator('#kmerSummary').inner_text())
        if shots:
            await pg.screenshot(path=os.path.join(shots, '02_fastq_graficos_claro.png'), full_page=True)

        # ---------------------------------------------------------- modo noche
        await pg.click('#themeDark')
        await pg.wait_for_timeout(500)
        theme = await pg.evaluate("document.documentElement.dataset.theme")
        bg = await pg.evaluate("getComputedStyle(document.body).backgroundColor")
        check('modo oscuro aplicado', theme == 'dark' and bg in ('rgb(11, 18, 16)',), f'{theme} {bg}')
        chart_color = await pg.evaluate("Chart.defaults.color")
        ink_soft = await pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--ink-soft').trim()")
        check('gráficos repintados con la paleta oscura', chart_color.lower() == ink_soft.lower(), f'{chart_color} vs {ink_soft}')
        stored = await pg.evaluate("localStorage.getItem('rmf-theme')")
        check('preferencia de tema guardada', stored == 'dark')
        if shots:
            await pg.screenshot(path=os.path.join(shots, '03_fastq_graficos_oscuro.png'), full_page=True)
            await pg.click('#tabbtn-run')
            await pg.wait_for_timeout(400)
            await pg.screenshot(path=os.path.join(shots, '04_run_oscuro.png'), full_page=True)
        await pg.reload()
        await expect(pg.locator('#engineText')).to_have_text('Motor de análisis listo', timeout=120000)
        check('el tema oscuro persiste al recargar', await pg.evaluate("document.documentElement.dataset.theme") == 'dark')
        await pg.click('#themeAuto')
        await pg.emulate_media(color_scheme='light')
        await pg.wait_for_timeout(300)
        check('modo automático sigue al sistema (claro)', await pg.evaluate("document.documentElement.dataset.theme") == 'light')
        await pg.emulate_media(color_scheme='dark')
        await pg.wait_for_timeout(300)
        check('modo automático sigue al sistema (oscuro)', await pg.evaluate("document.documentElement.dataset.theme") == 'dark')

        # ---------------------------------------------------------- estructura en oscuro
        ok = await load_example(pg, 'pdb', "!!(window.__rmf.state.result && window.__rmf.state.result.summary.chain_detail)")
        await expect(pg.locator('#viewer3d canvas')).to_have_count(1, timeout=30000)
        await pg.wait_for_timeout(900)
        check('PDB: cadenas y hueco detectado', ok and 'faltan 4' in await pg.locator('#chainsCard').inner_text())
        check('PDB: gráfico pLDDT', await pg.evaluate("!!window.__rmf.charts.bf"))
        if shots:
            await pg.screenshot(path=os.path.join(shots, '05_pdb_oscuro.png'), full_page=True)
        async with pg.expect_download() as dl:
            await pg.click('#downloadChainsBtn')
        d = await dl.value
        check('PDB: descarga de cadenas en FASTA', d.suggested_filename.endswith('_cadenas.fasta'))
        await pg.emulate_media(color_scheme='light')
        await pg.click('#themeLight')

        # ---------------------------------------------------------- tablas
        ok = await load_example(pg, 'csv', "!!(window.__rmf.state.result && window.__rmf.state.result.de)")
        await pg.click('#tabbtn-graficos')
        check('CSV DESeq2: volcano plot', ok and await waitjs(pg, "!!window.__rmf.charts.volcano", 20))
        check('CSV: aviso de coma decimal', 'coma decimal' in await pg.locator('#warnings').inner_text())
        ok = await load_example(pg, 'tsv', "window.__rmf.state.result && window.__rmf.state.result.summary.n_rows === 24")
        tabs = await pg.evaluate("[...document.querySelectorAll('.tab-btn')].filter(b => !b.hidden).map(b => b.dataset.tab)")
        check('TSV: solo listado y formatos', ok and tabs == ['lista', 'formatos'], str(tabs))

        # ---------------------------------------------------------- errores y entradas especiales
        await open_loader(pg)
        await pg.set_input_files('#fileInput', zpath)
        await expect(pg.locator('#dropError')).to_contain_text('.zip')
        check('ZIP: mensaje claro', True)
        await load_text(pg, '>g1 a\nACGTACGTAC\n>g1 b\nTTTTTTTT\n>g2\nacgtACGTAC\n', 'dups.fasta')
        await waitjs(pg, "window.__rmf.state.result && window.__rmf.state.result.summary.count === 3", 30)
        w = await pg.locator('#warnings').inner_text()
        check('FASTA: IDs y secuencias duplicadas', 'identificador' in w and 'copia exacta' in w)
        await open_loader(pg)
        await pg.click('.paste summary')
        await pg.fill('#pasteInput', 'ATGAAACCCGGGTTTTAGGAATTCATG')
        await pg.click('#pasteBtn')
        check('pegar una secuencia', await waitjs(pg, "window.__rmf.state.fileName === 'secuencia_pegada.fasta'", 30))
        await open_loader(pg)
        await pg.click('[data-example="bam"]')
        ok = await waitjs(pg, "window.__rmf.state.kind === 'bam' || !document.getElementById('dropError').hidden", 60)
        check('BAM: resultado o error de conexión comprensible', ok)

        # ---------------------------------------------------------- cancelar
        await pg.evaluate("() => { const s = '>x\\n' + ('ACGT'.repeat(25) + '\\n').repeat(400000);"
                          " window.__f = new File([s], 'grande.fasta'); }")
        await pg.evaluate("() => { const dt = new DataTransfer(); dt.items.add(window.__f);"
                          " const i = document.getElementById('fileInput'); i.files = dt.files; i.dispatchEvent(new Event('change')); }")
        await expect(pg.locator('#progressBox')).to_be_visible(timeout=5000)
        await pg.wait_for_timeout(500)
        await pg.click('#cancelBtn')
        await expect(pg.locator('#dropError')).to_contain_text('cancelado', timeout=5000)
        await expect(pg.locator('#engineText')).to_have_text('Motor de análisis listo', timeout=120000)
        check('cancelar reinicia el motor', True)

        # ---------------------------------------------------------- idioma
        await pg.click('#langEn')
        await pg.wait_for_timeout(400)
        check('interfaz en inglés', (await pg.locator('#tabbtn-lista').inner_text()).strip().endswith('List'))
        await pg.click('#langEs')

        # ---------------------------------------------------------- móvil
        m = await ctx.new_page()
        await m.set_viewport_size({'width': 390, 'height': 844})
        await m.goto(base)
        await expect(m.locator('#engineText')).to_have_text('Motor de análisis listo', timeout=120000)
        overflow = await m.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
        check('móvil: sin desbordamiento horizontal', not overflow)
        if shots:
            await m.screenshot(path=os.path.join(shots, '06_movil_inicio.png'), full_page=False)

        check('service worker registrado', await pg.evaluate("navigator.serviceWorker.getRegistration().then(r => !!r)"))
        check('consola sin errores ni violaciones de CSP', not errors, ' | '.join(errors[:3]))
        await browser.close()
    os.remove(zpath)
    httpd.shutdown()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shots', help='carpeta donde guardar capturas')
    args = ap.parse_args()
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)
    asyncio.run(run(args.shots))
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} comprobaciones correctas')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
