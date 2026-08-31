/* H7 EdTech — shared behaviour: mobile nav, app banner, app modal, FAQ */
(function () {
    'use strict';

    /* --- storage helpers (private mode / blocked cookies safe) ------------ */
    function read(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function write(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
    }

    /* --- mobile navigation ---------------------------------------------- */
    function initNav() {
        var toggle = document.querySelector('[data-nav-toggle]');
        var menu = document.querySelector('[data-nav-menu]');
        if (!toggle || !menu) return;

        toggle.addEventListener('click', function () {
            var open = menu.classList.toggle('is-open');
            toggle.setAttribute('aria-expanded', String(open));
            toggle.innerHTML = open
                ? '<i class="fa-solid fa-xmark"></i>'
                : '<i class="fa-solid fa-bars"></i>';
        });
    }

    /* --- top announcement bar -------------------------------------------- */
    function initTopbar() {
        var bar = document.getElementById('appTopbar');
        var close = document.getElementById('appTopbarClose');
        if (!bar || !close) return;

        if (read('h7AppBarDismissed') === '1') bar.classList.add('is-hidden');

        close.addEventListener('click', function () {
            bar.classList.add('is-hidden');
            write('h7AppBarDismissed', '1');
        });
    }

    /* --- app modal (once per visitor) ------------------------------------ */
    function initModal() {
        var modal = document.getElementById('appModal');
        if (!modal) return;

        var closers = modal.querySelectorAll('[data-modal-close]');
        var timer;

        function open() {
            modal.classList.add('is-open');
            document.body.classList.add('is-locked');
            var first = modal.querySelector('.app-modal-close');
            if (first) first.focus();
        }

        function close() {
            modal.classList.remove('is-open');
            document.body.classList.remove('is-locked');
            write('h7AppModalSeen', '1');
        }

        if (read('h7AppModalSeen') !== '1') {
            timer = window.setTimeout(open, 3500);
        }

        Array.prototype.forEach.call(closers, function (el) {
            el.addEventListener('click', close);
        });

        // clicking the backdrop closes; clicking the card does not
        modal.addEventListener('click', function (event) {
            if (event.target === modal) close();
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && modal.classList.contains('is-open')) close();
        });

        // never interrupt someone who is already reading
        window.addEventListener('scroll', function () {
            if (timer && window.scrollY > 400) {
                window.clearTimeout(timer);
                timer = null;
            }
        }, { passive: true });

        // taking either action counts as seen
        Array.prototype.forEach.call(modal.querySelectorAll('a'), function (link) {
            link.addEventListener('click', function () { write('h7AppModalSeen', '1'); });
        });
    }

    /* --- FAQ accordion ---------------------------------------------------- */
    function initFaq() {
        var items = document.querySelectorAll('.faq-item');
        if (!items.length) return;

        Array.prototype.forEach.call(items, function (item) {
            var question = item.querySelector('.faq-question');
            var answer = item.querySelector('.faq-answer');
            if (!question || !answer) return;

            question.addEventListener('click', function () {
                Array.prototype.forEach.call(items, function (other) {
                    if (other !== item && other.classList.contains('active')) {
                        other.classList.remove('active');
                        other.querySelector('.faq-answer').style.maxHeight = null;
                    }
                });

                item.classList.toggle('active');
                answer.style.maxHeight = item.classList.contains('active')
                    ? answer.scrollHeight + 'px'
                    : null;
            });
        });
    }

    function init() {
        initNav();
        initTopbar();
        initModal();
        initFaq();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
