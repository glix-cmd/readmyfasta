// READMYFASTA — aplica el tema antes de pintar la página (evita el destello blanco en modo oscuro).
// Se carga de forma síncrona en <head>; la CSP no permite scripts en línea, por eso es un archivo.
(function () {
  var mode = 'auto';
  try { mode = localStorage.getItem('rmf-theme') || 'auto'; } catch (e) { /* modo privado */ }
  var dark = mode === 'dark' || (mode === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-mode', mode);
  root.style.colorScheme = dark ? 'dark' : 'light';
}());
