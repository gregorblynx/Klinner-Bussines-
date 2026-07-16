/* =====================================================================
   Klinner Cleaning & Maintenance — Analytics engine
   ---------------------------------------------------------------------
   Loads Google Analytics 4 + Microsoft Clarity and tracks conversion
   events across every page. Loaded once per page via:

       <script src="/analytics.js" defer></script>

   IDs are provided by an inline config object that the Vercel build step
   fills in from environment variables (see scripts/inject-analytics.js
   and docs/analytics-setup.md). This file contains NO IDs.

   Design notes:
   - Everything loads async / deferred, so it never blocks rendering.
   - A single delegated click listener handles all link events.
   - If no valid IDs are present (local dev, or env vars unset) the whole
     script safely no-ops — the site is never affected.
   ===================================================================== */
(function () {
  'use strict';

  // --- Resolve configuration -----------------------------------------
  // A value is "valid" only if it is a non-empty string that is NOT the
  // unreplaced build placeholder (which still contains "NEXT_PUBLIC").
  var cfg = window.KLINNER_ANALYTICS_CONFIG || {};
  function clean(v) {
    return (typeof v === 'string' && v && v.indexOf('NEXT_PUBLIC') === -1)
      ? v.trim()
      : '';
  }
  var GA_ID = clean(cfg.gaId);
  var CLARITY_ID = clean(cfg.clarityId);

  if (!GA_ID && !CLARITY_ID) return; // nothing configured — stop cleanly

  // --- Google Analytics 4 (gtag.js) ----------------------------------
  if (GA_ID) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    // GA4 uses navigator.sendBeacon by default, so events survive page
    // navigation (e.g. clicking a phone/quote link that leaves the page).
    window.gtag('config', GA_ID);

    var ga = document.createElement('script');
    ga.async = true;
    ga.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
    document.head.appendChild(ga);
  }

  // --- Microsoft Clarity ---------------------------------------------
  if (CLARITY_ID) {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', CLARITY_ID);
  }

  // --- Unified event dispatch ----------------------------------------
  function track(eventName, params) {
    params = params || {};
    if (GA_ID && typeof window.gtag === 'function') {
      window.gtag('event', eventName, params);
    }
    if (CLARITY_ID && typeof window.clarity === 'function') {
      try {
        window.clarity('event', eventName);
        if (params.link_text || params.service) {
          window.clarity('set', eventName, String(params.link_text || params.service));
        }
      } catch (e) { /* Clarity not ready yet — ignore */ }
    }
  }

  function label(el) {
    return (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  // --- Conversion event: link clicks (delegated, passive) ------------
  // Capture phase so we run before any handler that might stop the event.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';

    // 1) Phone number clicks
    if (/^tel:/i.test(href)) {
      track('phone_click', { link_url: href, method: 'phone' });
      return;
    }
    // 2) Email link clicks
    if (/^mailto:/i.test(href)) {
      track('email_click', { link_url: href, method: 'email' });
      return;
    }
    // 3) "Request a Quote" clicks (any link to #quote, or data-analytics="quote")
    if (/#quote(\b|$)/i.test(href) || a.getAttribute('data-analytics') === 'quote') {
      track('quote_click', { link_url: href, link_text: label(a) });
      return;
    }
    // 6) External booking / contact link clicks (any off-site http link)
    if (/^https?:\/\//i.test(href)) {
      var host = '';
      try { host = new URL(href, location.href).host; } catch (_) { host = ''; }
      if (host && host !== location.host) {
        track('outbound_click', { link_url: href, link_domain: host, link_text: label(a) });
      }
    }
  }, { capture: true, passive: true });

  // --- Conversion event: contact form submission --------------------
  // The quote form (index.html) reveals #formSuccess with class "show"
  // only after Web3Forms confirms success, so this fires on real leads
  // (not on validation failures). Guarded against double counting.
  var leadSent = false;
  function markLead(source) {
    if (leadSent) return;
    leadSent = true;
    track('generate_lead', { form_id: 'contactForm', source: source || 'form' });
  }
  function watchForm() {
    var success = document.getElementById('formSuccess');
    if (!success) return;
    if (success.classList.contains('show')) { markLead('form_success'); return; }
    var mo = new MutationObserver(function () {
      if (success.classList.contains('show')) { markLead('form_success'); mo.disconnect(); }
    });
    mo.observe(success, { attributes: true, attributeFilter: ['class'] });
  }

  // --- Conversion event: service page visits -------------------------
  var SERVICE_PAGES = [
    'airbnb-cleaning', 'deep-cleaning', 'handyman-services',
    'move-in-cleaning', 'move-out-cleaning', 'recurring-cleaning'
  ];
  function trackServicePage() {
    var path = (location.pathname || '').toLowerCase();
    var svc = null;
    for (var i = 0; i < SERVICE_PAGES.length; i++) {
      if (path.indexOf(SERVICE_PAGES[i]) !== -1) { svc = SERVICE_PAGES[i]; break; }
    }
    // Also allow explicit opt-in via <body data-page-type="service" data-service="...">
    var body = document.body;
    if (!svc && body && body.getAttribute('data-page-type') === 'service') {
      svc = body.getAttribute('data-service') || 'service';
    }
    if (svc) {
      track('service_page_view', { page_path: location.pathname, service: svc });
    }
  }

  // Run DOM-dependent trackers (defer means the DOM is already parsed,
  // but guard anyway in case this file is ever loaded differently).
  function init() { watchForm(); trackServicePage(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
