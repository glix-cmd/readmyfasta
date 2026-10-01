// READMYFASTA — Web Worker del motor Python.
// Pyodide se ejecuta aquí, fuera del hilo de la interfaz: la página nunca se congela.
// El archivo del usuario se monta con WORKERFS, así Python lo lee por streaming sin copiarlo a memoria.
/* global loadPyodide */

importScripts('../../vendor/pyodide/pyodide.js');

const PYODIDE_URL = new URL('../../vendor/pyodide/', self.location.href).href;
const CORE_URL = new URL('../py/core.py', self.location.href).href;
const EXTRAS_URL = new URL('../py/fastq_extras.py', self.location.href).href;
const MOUNT = '/upload';

let py = null;
let api = null;

const ready = (async () => {
  py = await loadPyodide({ indexURL: PYODIDE_URL });
  // El motor son dos módulos: core.py importa fastq_extras.py, así que este se escribe
  // en el sistema de archivos virtual y se añade su carpeta al sys.path de Python.
  const [coreCode, extrasCode] = await Promise.all(
    [CORE_URL, EXTRAS_URL].map((u) => fetch(u, { cache: 'no-cache' }).then((r) => r.text())),
  );
  py.FS.mkdirTree('/py');
  py.FS.writeFile('/py/fastq_extras.py', extrasCode);
  py.runPython("import sys\nif '/py' not in sys.path:\n    sys.path.insert(0, '/py')");
  py.runPython(coreCode);
  const g = (name) => py.globals.get(name);
  api = {
    process_upload: g('process_upload'),
    get_page: g('get_page'),
    get_record_detail: g('get_record_detail'),
    search_records: g('search_records'),
    motif_search: g('motif_search'),
    export_selection: g('export_selection'),
  };
  self.postMessage({ type: 'ready' });
})().catch((err) => {
  self.postMessage({ type: 'fatal', message: String(err && err.message ? err.message : err) });
});

function unmount() {
  try { py.FS.unmount(MOUNT); } catch (_) { /* no había nada montado */ }
}

const handlers = {
  async load({ file }) {
    unmount();
    py.FS.mkdirTree(MOUNT);
    py.FS.mount(py.FS.filesystems.WORKERFS, { files: [file] }, MOUNT);
    let last = 0;
    const report = (fraction) => {
      const now = Date.now();
      if (now - last > 150) {
        last = now;
        self.postMessage({ type: 'progress', fraction });
      }
    };
    // El archivo queda montado: la exportación vuelve a recorrerlo entero.
    return api.process_upload(`${MOUNT}/${file.name}`, file.name, report);
  },
  page({ start, size }) { return api.get_page(start, size); },
  detail({ idx }) { return api.get_record_detail(idx); },
  search({ query }) { return api.search_records(query); },
  motif({ motif, bothStrands }) { return api.motif_search(motif, bothStrands); },
  exportSelection({ options }) {
    const out = '/tmp/export.out';
    const res = JSON.parse(api.export_selection(JSON.stringify(options), out));
    if (res.error) return { json: JSON.stringify(res) };
    const bytes = py.FS.readFile(out);
    py.FS.unlink(out);
    return { json: JSON.stringify(res), bytes };
  },
};

self.onmessage = async ({ data }) => {
  const { id, cmd, args } = data;
  try {
    await ready;
    if (!api) throw new Error('engine_unavailable');
    const result = await handlers[cmd](args || {});
    if (result && result.bytes) {
      self.postMessage({ type: 'result', id, json: result.json, bytes: result.bytes }, [result.bytes.buffer]);
    } else {
      self.postMessage({ type: 'result', id, json: typeof result === 'string' ? result : result.json });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err && err.message ? err.message : err) });
  }
};
