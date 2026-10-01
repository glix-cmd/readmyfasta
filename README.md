# READMYFASTA

Herramienta web gratuita, con código fuente disponible públicamente, para abrir y explorar archivos
FASTA, FASTQ, BAM/SAM, CSV/TSV, PDB y mmCIF directamente en el navegador: sin
instalación, sin cuenta y sin que ningún archivo salga del ordenador del
usuario. El análisis corre en el propio navegador (Python vía Pyodide dentro de
un Web Worker, y samtools compilado a WebAssembly para BAM).

La licencia del código principal aún no está especificada en el repositorio.
Las licencias de las dependencias de terceros se documentan junto a cada paquete.

## Cambios en 2.4.2

- Pyodide se carga cuando el usuario se acerca a la zona de carga o empieza un análisis; sus archivos se guardan en caché tras la primera descarga.
- Se añaden metadatos canónicos y de redes sociales, `robots.txt` y `sitemap.xml` para el dominio actual.
- El pie de página enlaza el repositorio, muestra autoría y cita el software.
- `.vercelignore` mantiene fuera de la web publicada las pruebas y herramientas internas.

## Arrancar en local (2 minutos)

> ⚠️ **Ya no funciona con doble clic (`file://`).** El motor se ejecuta en un
> Web Worker y los ejemplos se cargan con `fetch`, y los navegadores bloquean
> ambas cosas en `file://`. Hace falta un servidor local, aunque sea mínimo.

```bash
cd readmyfasta
python3 serve.py          # abre http://localhost:8000 automáticamente
```

Alternativas equivalentes: `python3 -m http.server 8000` o `npx serve .`

## Publicar

Es un sitio 100 % estático: sube la carpeta completa tal cual.

- **Netlify / Cloudflare Pages**: arrastra la carpeta al panel. El archivo
  `_headers` aplica solo las cabeceras de seguridad.
- **Vercel**: importa la carpeta o el repositorio. `vercel.json` aplica las
  cabeceras de seguridad y `.vercelignore` excluye archivos internos. Sin build command.
- **GitHub Pages**: sube el contenido a la raíz del repositorio (o a `/docs`) y
  activa Pages. GitHub Pages no admite cabeceras propias, pero la CSP ya va
  incluida en `index.html` como `<meta>`.
- **Servidor propio (Nginx, Apache, S3…)**: copia la carpeta. Comprueba que
  los `.wasm` se sirven como `application/wasm` (lo normal en servidores
  actuales).

## Novedades de la versión 2.4 (acabado visual)

- **Tipografía autoalojada**: Inter para la interfaz, Source Serif 4 para titulares y JetBrains
  Mono para secuencias y código. Se ve igual en Windows, macOS, Linux y móvil, y funciona sin
  conexión. Las cifras usan números tabulares, así que las columnas quedan alineadas.
- **Iconos SVG propios** en lugar de emojis: trazo uniforme, heredan el color del tema y se
  ven igual en todos los sistemas (los emojis cambian de aspecto según el dispositivo).
- **Barra de navegación con marca**, portada con propuesta de valor y garantías visibles
  (100 % local, sin conexión tras cargar el motor, sin registro, código en GitHub) y la zona de carga destacada.
- **Logotipo renovado**, iconos PNG para Android, iOS y modo app (incluido icono adaptable), e
  **imagen para compartir** de 1200×630 para LinkedIn, WhatsApp o X. Se regeneran con
  `python tools/render_icons.py` a partir de `icon.svg` y `tools/og-template.html`.
- Tarjetas con el veredicto marcado por un filete de color, tablas con columnas numéricas
  alineadas a la derecha, avisos con icono, gráficos con leyendas y ayudas emergentes
  refinadas, y pie de página con información de privacidad y tecnología.

> Al publicar, cambia `og-image.png` en `index.html` por su URL absoluta
> (`https://tu-dominio/og-image.png`): algunas redes no aceptan rutas relativas.

## Novedades de la versión 2.3

**Interfaz**
- **Modo noche** con tres posiciones (claro, oscuro y automático según el sistema), recordado
  entre visitas y aplicado antes de pintar la página para evitar el destello blanco. Todos los
  colores salen de variables de diseño, así que gráficos, visor 3D, tablas y avisos cambian a la
  vez. Al imprimir, el informe sale siempre legible.
- Tras analizar, la zona de carga se pliega en una **barra de archivo** (nombre, formato,
  tamaño, registros y tiempo de análisis) y la cabecera se compacta: los resultados quedan
  arriba sin desplazarse.
- **Tarjetas agrupadas** por tema (volumen, composición, calidad, librería).
- **Ejemplos como tarjetas** con descripción de qué muestra cada uno.
- **Pestañas fijas** al desplazarse y con desplazamiento horizontal en móvil.
- **Soltar archivos en cualquier parte** de la página, con capa a pantalla completa.
- **Avisos flotantes** al copiar o descargar, y aviso cuando hay una versión nueva.
- **Atajo de teclado:** `/` abre la búsqueda.

**Técnico**
- Si el motor se cae a mitad de análisis (típicamente por memoria), el trabajo se rechaza con
  un mensaje claro y el motor se reinicia solo.
- Los gráficos de una sola barra se sustituyen por una nota explicativa.
- Suite de pruebas propia (`tests/`) e integración continua con GitHub Actions.

## Pruebas

```bash
python -m pytest -q tests/test_core.py        # motor Python: 19 pruebas, ~3 s, sin navegador

pip install playwright && python -m playwright install chromium
python tests/e2e.py                           # 37 comprobaciones en Chromium (arranca su servidor)
python tests/e2e.py --shots capturas/         # además guarda capturas en claro y oscuro
```

`tests/test_core.py` también funciona sin pytest (`python tests/test_core.py`). En GitHub, el
flujo `.github/workflows/tests.yml` ejecuta ambas suites en cada push y adjunta las capturas.

## Si tu antivirus marca el zip

Es un falso positivo conocido de las heurísticas, no un virus. READMYFASTA no contiene
ejecutables, macros ni scripts de sistema: solo HTML, CSS, JavaScript, Python y datos. Lo que
algunos antivirus confunden con código ofuscado son librerías oficiales de terceros:

- **Pyodide** (`pyodide.asm.js` / `.wasm`): Python compilado a WebAssembly. Usa `eval` y
  WebAssembly, que ciertas heurísticas asocian con el minado de criptomonedas.
- **3Dmol.js** (`3Dmol-min.js`): código minimizado con una llamada a `eval`.

Desde la versión 2.4.1, **Aioli** (la librería para leer BAM, que incrusta el código de su
worker en base64) ya no va en el zip: se carga desde biowasm.com al abrir un BAM, que de todas
formas necesitaba conexión para descargar samtools.

**Cómo comprobarlo tú mismo**

```bash
python3 tools/vendor.py
```

Compara cada archivo de `vendor/` con su huella SHA-256 registrada en `vendor.lock.json`,
tomada de los paquetes oficiales publicados en npm. También puedes subir el zip a
[VirusTotal](https://www.virustotal.com): si solo lo marcan uno o dos motores con nombres
genéricos (`Heur`, `Generic`, `Obfuscated`, `CoinMiner`), es la heurística.

**Versión sin librerías de terceros**

`readmyfasta-sin-librerias.zip` contiene solo el código propio de READMYFASTA, así que no hay
nada que marcar. Después de descomprimirlo, un único comando descarga las librerías del registro
oficial de npm, verificando la firma SHA-512 de cada paquete y la huella de cada archivo:

```bash
python3 tools/vendor.py --descargar
python3 serve.py
```

## Estructura

```
readmyfasta/
├── index.html              ← página principal (con CSP, metadatos y estructura accesible)
├── robots.txt / sitemap.xml← indexación en buscadores
├── .vercelignore            ← archivos que no se publican en Vercel
├── CHANGELOG.md             ← cambios de versión
├── CITATION.cff             ← metadatos de cita para GitHub
├── serve.py                ← servidor local de desarrollo
├── sw.js                   ← service worker: uso sin conexión tras la primera visita
├── manifest.webmanifest    ← instalable como app (PWA)
├── vendor.lock.json        ← huellas SHA-256 oficiales de cada librería de terceros
├── icon.svg                ← logotipo (fuente de todos los iconos)
├── icons/                  ← iconos PNG para Android, iOS y app instalable
├── og-image.png            ← imagen para compartir en redes (1200×630)
├── _headers / vercel.json  ← cabeceras de seguridad para Netlify/Cloudflare y Vercel
├── src/
│   ├── css/styles.css
│   ├── js/
│   │   ├── theme-boot.js   ← aplica el tema antes de pintar (evita el destello blanco)
│   │   ├── i18n.js         ← todos los textos ES/EN y la guía de formatos
│   │   ├── app.js          ← interfaz
│   │   └── worker.js       ← Web Worker que ejecuta Pyodide
│   └── py/
│       ├── core.py         ← motor de análisis (Python estándar; se puede probar con CPython)
│       └── fastq_extras.py ← métricas avanzadas de FASTQ (cabecera, EE, duplicación, k-meros)
├── vendor/                 ← dependencias autoalojadas (sin CDN)
│   ├── fonts/              ← Inter, Source Serif 4 y JetBrains Mono (OFL)
│   ├── pyodide/            ← Pyodide 0.28.3 (núcleo + librería estándar)
│   ├── chartjs/            ← Chart.js 4.4.4
│   └── 3dmol/              ← 3Dmol.js 2.5.3
├── data/                   ← ejemplos (botones «Prueba con un ejemplo»)
├── tests/
│   ├── test_core.py        ← pruebas del motor (pytest o python directo)
│   └── e2e.py              ← pruebas de extremo a extremo en Chromium
└── .github/workflows/      ← integración continua
```

## Qué cambió en esta versión

**Rendimiento y robustez**
- Python se ejecuta en un **Web Worker**: la página nunca se congela y el
  análisis se puede **cancelar**, con barra de progreso real.
- El archivo se monta con **WORKERFS** y se lee **en streaming**: ya no se copia
  entero a memoria varias veces. Las estadísticas cubren siempre el archivo
  completo; el listado/detalle/motivos retienen hasta ~400 M de caracteres y lo
  avisan si el archivo es mayor. La exportación vuelve a recorrer el archivo
  entero.
- Gráficos agregados en Python (histogramas) en lugar de una barra por
  secuencia; Chart.js y 3Dmol se cargan solo cuando hacen falta.
- Detección por **contenido** (magic bytes), no por extensión: gzip
  multi-miembro/BGZF, BAM, SAM, ZIP, Word/Excel, PDF, AB1, CRAM, bz2, xz/zstd,
  gzip truncado o dañado, BOM y saltos de línea de Windows. Mensajes de error
  claros y accionables.

**Métricas avanzadas de FASTQ (v2.1)**
- **Cabecera Illumina**: instrumento, run, flowcell, lane, tile, índice, R1/R2 y lecturas que
  no superan el filtro del secuenciador, todo sin analizar la secuencia.
- **Calidad por lane y por tile**, con las peores tiles destacadas: una tile mala señala un
  problema físico de la flowcell, no de la librería.
- **Distribución de índices (barcodes)**, útil para detectar index hopping o muestras mezcladas.
- **Errores esperados (EE)** por lectura, el criterio de filtrado de DADA2 y vsearch, con
  histograma, % de lecturas con EE ≤ 1 y filtro de exportación por EE máximo.
- **Duplicación** y secuencias sobrerrepresentadas (primeras 100.000 lecturas, 50 pb de huella),
  con identificación del origen probable (adaptador, poly-G, poly-A, baja complejidad).
- **Colas poly-G y poly-A**: en secuenciadores de dos colores, poly-G significa ciclos sin señal.
- **Composición por base y posición**, que revela el sesgo de cebado aleatorio en RNA-seq.
- **Espectro de k-meros** (k = 21 sobre una muestra) con estimación de tamaño de genoma,
  cobertura y porcentaje de k-meros de error.

**FASTA y estructuras (v2.2)**
- **IDs duplicados y secuencias idénticas** en FASTA: los IDs repetidos rompen alineadores e
  indexadores en silencio. La comparación de secuencias ignora mayúsculas y minúsculas.
- **Porcentaje de bases enmascaradas** (minúsculas de los repeat-maskers).
- **PDB/mmCIF: cadenas, secuencia y huecos.** Tabla por cadena con tipo, número de residuos,
  rango de numeración, huecos y residuos ausentes; detalle de cada hueco; secuencia de cada
  cadena en una sola letra y descarga de todas en FASTA.
- **B-factor o pLDDT por residuo** como gráfico, con cada cadena en su propia numeración.

**Bioinformática**
- Detección ADN / ARN / proteína (unidades en pb o aa; sin %GC en proteínas).
- %GC excluyendo N, % de N, mediana, N50, L50 y N90.
- FASTQ: % de bases ≥ Q30 y ≥ Q20, detección automática Phred+33/+64,
  adaptadores (TruSeq, Nextera, small RNA), calidad por posición con percentiles
  10/25/50/75/90 sobre una muestra aleatoria de todo el archivo, histograma de
  calidad media por lectura y validación estricta del formato.
- Umbral de calidad por tecnología (Illumina, Nanopore, PacBio HiFi).
- Motivos con **códigos IUPAC**, **ambas hebras**, solapamientos, posiciones en
  base 1, detección de palíndromos y atajos (EcoRI, BamHI, HindIII, NotI, PAM
  NGG, caja TATA).
- Detalle: secuencia en bloques de 10 con regla de posiciones, reverso
  complementario, traducción en 6 marcos y botón de copiar.
- Exportación: longitud mín./máx., palabra clave, calidad media mínima,
  FASTQ→FASTA, reverso complementario, salida .gz, **comando seqkit
  equivalente** y estadísticas en CSV listo para Excel en español.
- CSV/TSV: separador detectado (incluido `;`), coma decimal, y **volcano plot**
  automático para tablas de DESeq2, edgeR y limma.
- PDB y **mmCIF**: método, resolución y coloreado por **pLDDT** en modelos de
  AlphaFold.
- BAM: con el índice `.bai`, lecturas por cromosoma (`samtools idxstats`) y
  primeros alineamientos; también acepta SAM.

**Usabilidad y accesibilidad**
- Botones de ejemplo, cuadro para pegar una secuencia, vista previa de las
  primeras líneas, arrastrar y soltar en toda la página y «Cargar otro archivo».
- Pestañas ARIA con teclado (flechas, Inicio, Fin), diálogo de detalle modal con
  Escape y retorno del foco, foco visible, enlace «Saltar al contenido»,
  encabezados jerárquicos y etiquetas asociadas.
- Veredictos con icono además de color y paleta apta para daltonismo.
- Explicaciones en lenguaje llano (Phred, Q30, N50, %GC, adaptadores).
- El idioma elegido se recuerda entre visitas.

**Seguridad y privacidad**
- Todas las dependencias autoalojadas en `vendor/` y **CSP estricta**: ningún
  script puede enviar datos a otro dominio. La única excepción es
  `biowasm.com`, de donde se descarga samtools la primera vez que se abre un BAM.
- Funciona sin conexión tras la primera visita (service worker), lo que permite
  comprobar que nada se sube.

## Probar el motor sin navegador

`src/py/core.py` solo usa la librería estándar, así que se puede probar con
Python normal:

```python
import sys, json; sys.path.insert(0, 'src/py'); import core
r = json.loads(core.process_upload('data/ejemplo.fastq.gz', 'ejemplo.fastq.gz'))
print(r['summary']['pct_q30'])
print(core.motif_search('GAATTC'))
```

## Limitaciones conocidas

- **BAM**: samtools (1.10) se descarga desde biowasm.com la primera vez. Para
  autoalojarlo también, descarga `samtools.js`, `samtools.wasm` y
  `samtools.data` de `https://biowasm.com/cdn/v3/samtools/1.10/`, colócalos en
  `vendor/biowasm/samtools/1.10/`, pasa `{ tool: 'samtools', version: '1.10',
  urlPrefix: new URL('vendor/biowasm/samtools/1.10', location.href).href }` a
  `new Aioli(...)` en `app.js`, y quita `https://biowasm.com` de la CSP.
- Sin índice `.bai`, los BAM de más de 30 MB no muestran los primeros
  alineamientos (sí las estadísticas de `flagstat`).
- Aún no se admiten VCF ni cromatogramas Sanger (.ab1): se detectan y se avisa.
- Las métricas avanzadas usan muestras acotadas por diseño (EE: 20.000 lecturas más 1 de cada
  200; duplicación: 100.000; k-meros: 12.000; composición: 5.000). Las estadísticas básicas sí
  cubren el archivo completo. La estimación de tamaño de genoma solo funciona cuando la muestra
  tiene un pico de cobertura claro: en genomas grandes o con cobertura baja se informa de ello
  en lugar de dar un número engañoso.
- Duplicados ópticos y UMIs no se analizan: harían falta ordenar por secuencia y conocer el
  diseño de la librería.
- El límite práctico de memoria lo pone el navegador (WebAssembly de 32 bits,
  unos 2–4 GB). Las estadísticas funcionan con archivos mayores, pero el
  listado y el detalle se recortan y se avisa.

## Regenerar los ejemplos

```bash
pip install pysam
python3 tools/gen_examples.py    # desde la raíz del proyecto
```

## Licencias de terceros

Pyodide (MPL-2.0), Chart.js (MIT), 3Dmol.js (BSD-3-Clause), Aioli (MIT, cargada desde biowasm.com), Inter, Source Serif 4 y
JetBrains Mono (SIL Open Font License 1.1). Iconos dibujados siguiendo el estilo de Lucide (ISC).
Los textos o avisos de licencia correspondientes están junto a cada librería en
`vendor/` (para Pyodide, `vendor/pyodide/NOTICE.txt`).
