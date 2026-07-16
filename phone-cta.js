/* =====================================================================
   Klinner — phone link behaviour
   ---------------------------------------------------------------------
   A "tel:" link only does something useful on a device that can place a
   call. On a desktop browser, clicking the phone number appears to do
   nothing, which looks broken and wastes the click.

   So:
     - Phones / tablets (coarse pointer, no hover)  -> leave tel: alone,
       one tap still calls. This is the main conversion and must not break.
     - Desktop                                      -> send the visitor to
       the quote form instead of doing nothing.

   Kept separate from analytics.js on purpose: that file disables itself
   when no tracking IDs are present, and phone links must keep working
   regardless of whether analytics is switched on.

   Note: analytics.js listens in the capture phase, so the phone_click
   event is still recorded on desktop — the click is the same intent
   signal either way, it just gets a more useful destination here.
   ===================================================================== */
(function () {
  'use strict';

  var NAV_OFFSET = 80; // matches the site's existing smooth-scroll offset

  // Can this device actually dial? Phones and tablets report a coarse
  // pointer with no hover; desktops do not.
  function canPlaceCall() {
    return !!(window.matchMedia &&
              window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  }

  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('a[href^="tel:"]') : null;
    if (!link) return;

    // Let the browser do its thing: mobile dials, and modified clicks
    // (new tab/window) stay untouched.
    if (canPlaceCall() || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;

    var form = document.getElementById('quote');
    if (form) {
      // Same page (home): scroll to the form.
      e.preventDefault();
      var top = form.getBoundingClientRect().top + window.scrollY - NAV_OFFSET;
      window.scrollTo({ top: top, behavior: 'smooth' });
    } else {
      // Any other page: go to the form on the home page.
      e.preventDefault();
      window.location.href = '/index.html#quote';
    }
  });
})();
