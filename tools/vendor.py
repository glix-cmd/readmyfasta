#!/usr/bin/env python3
"""Comprueba (y opcionalmente descarga) las librerías de terceros de READMYFASTA.

    python3 tools/vendor.py              # verifica que vendor/ es idéntico a los paquetes oficiales
    python3 tools/vendor.py --descargar  # descarga de registry.npmjs.org lo que falte o no coincida

Cada archivo se compara con su huella SHA-256 registrada en vendor.lock.json. Al descargar, además
se comprueba la firma SHA-512 del paquete completo contra la que publica el propio registro de npm,
así que un archivo manipulado en tránsito o en disco no pasa la verificación.
"""
import base64
import hashlib
import io
import json
import os
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = 'https://registry.npmjs.org'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def package_tarball(pkg, version, cache):
    key = (pkg, version)
    if key in cache:
        return cache[key]
    meta = json.loads(fetch(f'{REGISTRY}/{pkg}/{version}'))
    tar_bytes = fetch(meta['dist']['tarball'])
    algo, _, expected = meta['dist']['integrity'].partition('-')
    got = base64.b64encode(hashlib.new(algo, tar_bytes).digest()).decode()
    if got != expected:
        raise SystemExit(f'La firma de {pkg}@{version} no coincide con la del registro de npm: descarga abortada.')
    cache[key] = tarfile.open(fileobj=io.BytesIO(tar_bytes), mode='r:gz')
    print(f'  descargado y verificado {pkg}@{version} ({algo} del registro de npm)')
    return cache[key]


def main():
    download = '--descargar' in sys.argv or '--download' in sys.argv
    lock = json.load(open(os.path.join(ROOT, 'vendor.lock.json'), encoding='utf-8'))
    cache, bad = {}, 0
    for e in lock['files']:
        path = os.path.join(ROOT, e['file'])
        status = 'falta'
        if os.path.exists(path):
            status = 'ok' if sha256(open(path, 'rb').read()) == e['sha256'] else 'NO COINCIDE'
        if status != 'ok' and download:
            tar = package_tarball(e['package'], e['version'], cache)
            data = tar.extractfile(f"package/{e['path_in_package']}").read()
            if sha256(data) != e['sha256']:
                raise SystemExit(f"{e['file']}: el archivo oficial no coincide con vendor.lock.json.")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, 'wb').write(data)
            status = 'descargado'
        if status not in ('ok', 'descargado'):
            bad += 1
        print(f"  {status:11s} {e['file']}  ({e['package']}@{e['version']})")
    if bad:
        print(f'\n{bad} archivo(s) ausentes o distintos. Ejecuta: python3 tools/vendor.py --descargar')
        sys.exit(1)
    print('\nTodas las librerías de terceros son idénticas a los paquetes oficiales publicados en npm.')


if __name__ == '__main__':
    main()
