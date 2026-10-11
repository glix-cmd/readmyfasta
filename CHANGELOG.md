# Changelog

## 2.5.0 — 2026-10-11

- Aviso legal y licencia: `LICENSE` (todos los derechos reservados; uso gratuito), `legal.html` (ES/EN) y `THIRD_PARTY_NOTICES.md`.
- Pie con «© 2026 glix-cmd · Todos los derechos reservados» y enlaces al aviso legal y a las licencias de terceros; se corrige el texto «de código abierto».
- Portada con una tarjeta de vista previa del análisis (cifras y curva de calidad reales del ejemplo FASTQ) y botón para abrirlo.
- Caché del service worker `rmf-v2.5.0`; `legal.html` en el sitemap.

## 2.4.2 — 2026-10-01

- Load the Pyodide analysis engine only when a visitor approaches the upload or example controls, or starts an analysis. Cache Pyodide resources after their first download so they remain available offline.
- Add a canonical URL, complete social-sharing image URLs, `robots.txt`, and `sitemap.xml` for the current Vercel domain.
- Add repository attribution, a citation, and a short in-app changelog. Clarify that the project license has not yet been specified.
- Exclude development tools, tests, and project metadata from Vercel deployments.
