// SkyDra landing: pricing period and plan, the phone menu and the phone action bar.
(function () {
  var pricing = document.querySelector('.pricing');
  if (pricing) {
    pricing.querySelectorAll('[data-set]').forEach(function (b) {
      b.addEventListener('click', function () {
        pricing.setAttribute('data-billing', b.getAttribute('data-set'));
        pricing.querySelectorAll('[data-set]').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === b));
        });
      });
    });
    // Phones show one plan at a time.
    pricing.querySelectorAll('[data-plan-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        pricing.setAttribute('data-plan', b.getAttribute('data-plan-tab'));
        pricing.querySelectorAll('[data-plan-tab]').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === b));
        });
      });
    });
  }

  var nav = document.querySelector('.nav');
  var toggle = document.querySelector('.menu-toggle');
  if (nav && toggle) {
    var setOpen = function (open) {
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', function () {
      setOpen(!nav.classList.contains('open'));
    });
    nav.querySelectorAll('.nav-links a').forEach(function (a) {
      a.addEventListener('click', function () {
        setOpen(false);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
    document.addEventListener('click', function (e) {
      if (!nav.contains(e.target)) setOpen(false);
    });
  }

  // The bar appears once the hero actions are out of view and hides at the closing form.
  var bar = document.querySelector('.sticky-cta');
  var hero = document.querySelector('.hero-actions');
  var end = document.querySelector('#pradeti');
  if (bar && hero && end && 'IntersectionObserver' in window) {
    var heroVisible = true;
    var endVisible = false;
    var link = bar.querySelector('a');
    var update = function () {
      var show = !heroVisible && !endVisible;
      bar.classList.toggle('visible', show);
      bar.setAttribute('aria-hidden', String(!show));
      link.tabIndex = show ? 0 : -1;
    };
    new IntersectionObserver(function (entries) {
      heroVisible = entries[0].isIntersecting || entries[0].boundingClientRect.top > 0;
      update();
    }).observe(hero);
    new IntersectionObserver(function (entries) {
      endVisible = entries[0].isIntersecting || entries[0].boundingClientRect.top < 0;
      update();
    }).observe(end);
  }
})();
