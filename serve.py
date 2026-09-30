#!/usr/bin/env python3
"""Servidor local de READMYFASTA. Uso: python3 serve.py  (y abre http://localhost:8000)"""
import http.server, socketserver, webbrowser, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.webmanifest': 'application/manifest+json', '.py': 'text/plain; charset=utf-8'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    url = f'http://localhost:{PORT}'
    print(f'READMYFASTA disponible en {url}  (Ctrl+C para detener)')
    try:
        webbrowser.open(url)
    except Exception:
        pass
    httpd.serve_forever()
