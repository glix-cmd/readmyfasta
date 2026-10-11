// READMYFASTA — página de aviso legal: idioma (el mismo que la herramienta) sin scripts en línea por la CSP.
(function () {
  var guardar = function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* modo privado */ } };
  var leer = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var lang = leer('rmf-lang') || ((navigator.language || 'es').toLowerCase().indexOf('en') === 0 ? 'en' : 'es');
  function aplicar(l) {
    lang = l === 'en' ? 'en' : 'es';
    document.documentElement.lang = lang;
    document.title = lang === 'en' ? 'Legal notice and licence · READMYFASTA' : 'Aviso legal y licencia · READMYFASTA';
    document.querySelectorAll('[data-legal-lang]').forEach(function (el) { el.hidden = el.getAttribute('data-legal-lang') !== lang; });
    document.querySelectorAll('.lang-btn').forEach(function (b) {
      var activo = b.getAttribute('data-lang') === lang;
      b.classList.toggle('active', activo); b.setAttribute('aria-pressed', String(activo));
    });
  }
  document.querySelectorAll('.lang-btn').forEach(function (b) {
    b.addEventListener('click', function () { guardar('rmf-lang', b.getAttribute('data-lang')); aplicar(b.getAttribute('data-lang')); });
  });
  aplicar(lang);
  // El enlace «Licencias de terceros» (#terceros) lleva a esa sección en el idioma visible
  if (location.hash === '#terceros' || location.hash === '#third-party') {
    var visible = document.querySelector('.legal-doc:not([hidden]) [data-sec="terceros"]');
    if (visible) setTimeout(function () { visible.scrollIntoView(); }, 30);
  }
}());
