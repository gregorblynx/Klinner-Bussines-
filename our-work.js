/* Simple lightbox for the /our-work.html portfolio. Plain JS + native <dialog>.
   Without JS (or without <dialog> support) the thumbnails remain normal links to the full-size photo. */
(function () {
  'use strict';
  var dialog = document.getElementById('lightbox');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  var links = Array.prototype.slice.call(document.querySelectorAll('.portfolio-item'));
  var img = dialog.querySelector('img');
  var caption = dialog.querySelector('figcaption');
  var current = 0;

  function show(index) {
    current = (index + links.length) % links.length;
    var thumb = links[current].querySelector('img');
    img.src = links[current].getAttribute('href');
    img.alt = thumb ? thumb.alt : '';
    caption.textContent = thumb ? thumb.alt : '';
  }

  links.forEach(function (link, i) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      show(i);
      dialog.showModal();
    });
  });

  dialog.querySelector('.lb-close').addEventListener('click', function () { dialog.close(); });
  dialog.querySelector('.lb-prev').addEventListener('click', function () { show(current - 1); });
  dialog.querySelector('.lb-next').addEventListener('click', function () { show(current + 1); });

  // Click on the dark backdrop closes it.
  dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });

  dialog.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowLeft') show(current - 1);
    else if (event.key === 'ArrowRight') show(current + 1);
  });
})();
