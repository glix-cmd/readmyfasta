# Changelog

## 2.4.2 — 2026-10-01

- Load the Pyodide analysis engine only when a visitor approaches the upload or example controls, or starts an analysis. Cache Pyodide resources after their first download so they remain available offline.
- Add a canonical URL, complete social-sharing image URLs, `robots.txt`, and `sitemap.xml` for the current Vercel domain.
- Add repository attribution, a citation, and a short in-app changelog. Clarify that the project license has not yet been specified.
- Exclude development tools, tests, and project metadata from Vercel deployments.
