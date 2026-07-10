/* Klinner PWA install banner
   - Android/Chrome: shows an "Install" button that triggers the native install prompt
   - iOS/Safari: shows a 2-step "Add to Home Screen" mini guide
   - Hidden if already installed; dismissal is remembered for 14 days */
(function () {
  'use strict';

  var DISMISS_KEY = 'klinnerInstallDismissed';
  var DISMISS_DAYS = 14;

  // Already running as an installed app
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) return;

  // Recently dismissed
  try {
    var dismissed = localStorage.getItem(DISMISS_KEY);
    if (dismissed && Date.now() - Number(dismissed) < DISMISS_DAYS * 24 * 60 * 60 * 1000) return;
  } catch (e) { /* private mode */ }

  var ua = navigator.userAgent;
  var isIOS = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
  var isIOSSafari = isIOS && !/crios|fxios|edgios|opios/i.test(ua);

  var deferredPrompt = null;
  var shown = false;

  var css = '' +
    '#klinnerInstallBanner{position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;' +
      'background:#1B2F6E;color:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.35);' +
      'padding:14px 16px;display:flex;align-items:center;gap:12px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'transform:translateY(130%);transition:transform .4s cubic-bezier(.2,.8,.2,1);max-width:480px;margin:0 auto}' +
    '#klinnerInstallBanner.show{transform:translateY(0)}' +
    '#klinnerInstallBanner img{width:44px;height:44px;border-radius:10px;background:#fff;flex-shrink:0}' +
    '#klinnerInstallBanner .kib-text{flex:1;min-width:0}' +
    '#klinnerInstallBanner .kib-title{font-weight:700;font-size:15px;line-height:1.25}' +
    '#klinnerInstallBanner .kib-sub{font-size:12.5px;opacity:.85;margin-top:2px}' +
    '#klinnerInstallBanner button.kib-cta{background:#2ABFBF;color:#fff;border:none;border-radius:10px;' +
      'font-weight:700;font-size:14px;padding:10px 16px;cursor:pointer;flex-shrink:0}' +
    '#klinnerInstallBanner button.kib-close{background:none;border:none;color:#fff;opacity:.6;font-size:20px;' +
      'line-height:1;padding:4px;cursor:pointer;flex-shrink:0;align-self:flex-start;margin:-4px -6px 0 0}' +
    '#klinnerIOSGuide{position:fixed;inset:0;z-index:100000;background:rgba(13,22,51,.75);display:none;' +
      'align-items:flex-end;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    '#klinnerIOSGuide.show{display:flex}' +
    '#klinnerIOSGuide .kig-sheet{background:#fff;color:#1B2F6E;border-radius:18px 18px 0 0;padding:24px 22px 34px;' +
      'width:100%;max-width:480px}' +
    '#klinnerIOSGuide h3{font-size:18px;margin:0 0 16px;font-weight:800}' +
    '#klinnerIOSGuide .kig-step{display:flex;align-items:center;gap:12px;margin-bottom:14px;font-size:15px;line-height:1.4}' +
    '#klinnerIOSGuide .kig-num{width:28px;height:28px;border-radius:50%;background:#2ABFBF;color:#fff;font-weight:700;' +
      'display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px}' +
    '#klinnerIOSGuide .kig-icon{display:inline-block;vertical-align:-4px;margin:0 3px}' +
    '#klinnerIOSGuide button{width:100%;margin-top:8px;background:#1B2F6E;color:#fff;border:none;border-radius:12px;' +
      'font-weight:700;font-size:15px;padding:14px;cursor:pointer}';

  var shareSVG = '<svg class="kig-icon" width="18" height="22" viewBox="0 0 16 20" fill="none">' +
    '<path d="M8 1v12M8 1L4 5M8 1l4 4" stroke="#1B2F6E" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M3 8H2a1 1 0 00-1 1v9a1 1 0 001 1h12a1 1 0 001-1V9a1 1 0 00-1-1h-1" stroke="#1B2F6E" stroke-width="1.6" stroke-linecap="round"/></svg>';

  var plusSVG = '<svg class="kig-icon" width="18" height="18" viewBox="0 0 18 18" fill="none">' +
    '<rect x="1" y="1" width="16" height="16" rx="4" stroke="#1B2F6E" stroke-width="1.6"/>' +
    '<path d="M9 5.5v7M5.5 9h7" stroke="#1B2F6E" stroke-width="1.6" stroke-linecap="round"/></svg>';

  function injectStyles() {
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function dismiss() {
    var b = document.getElementById('klinnerInstallBanner');
    if (b) { b.classList.remove('show'); setTimeout(function () { b.remove(); }, 450); }
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
  }

  function buildBanner(ctaLabel, onCta) {
    if (shown) return;
    shown = true;
    injectStyles();

    var banner = document.createElement('div');
    banner.id = 'klinnerInstallBanner';
    banner.innerHTML =
      '<img src="/icon-192.png" alt="Klinner app icon">' +
      '<div class="kib-text">' +
        '<div class="kib-title">Get the Klinner app</div>' +
        '<div class="kib-sub">Book your cleaning in one tap \u2014 free, no app store needed</div>' +
      '</div>' +
      '<button class="kib-cta" type="button">' + ctaLabel + '</button>' +
      '<button class="kib-close" type="button" aria-label="Close">&times;</button>';
    document.body.appendChild(banner);

    banner.querySelector('.kib-cta').addEventListener('click', onCta);
    banner.querySelector('.kib-close').addEventListener('click', dismiss);

    setTimeout(function () { banner.classList.add('show'); }, 2500);
  }

  function showIOSGuide() {
    var guide = document.getElementById('klinnerIOSGuide');
    if (!guide) {
      guide = document.createElement('div');
      guide.id = 'klinnerIOSGuide';
      guide.innerHTML =
        '<div class="kig-sheet">' +
          '<h3>Install the Klinner app</h3>' +
          '<div class="kig-step"><span class="kig-num">1</span><span>Tap the ' + shareSVG + ' <strong>Share</strong> button at the bottom of Safari</span></div>' +
          '<div class="kig-step"><span class="kig-num">2</span><span>Scroll down and tap ' + plusSVG + ' <strong>Add to Home Screen</strong></span></div>' +
          '<button type="button">Got it</button>' +
        '</div>';
      document.body.appendChild(guide);
      guide.querySelector('button').addEventListener('click', function () {
        guide.classList.remove('show');
        dismiss();
      });
      guide.addEventListener('click', function (e) {
        if (e.target === guide) guide.classList.remove('show');
      });
    }
    guide.classList.add('show');
  }

  // Android / Chrome: real one-tap install
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    buildBanner('Install', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        deferredPrompt = null;
        dismiss();
      });
    });
  });

  window.addEventListener('appinstalled', dismiss);

  // iOS Safari: guided Add to Home Screen
  if (isIOSSafari) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { buildBanner('How?', showIOSGuide); });
    } else {
      buildBanner('How?', showIOSGuide);
    }
  }
})();
