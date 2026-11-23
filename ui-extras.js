/* Migliorie d'interfaccia: non modificano la logica di calcolo */
(function () {
    'use strict';
    var MONTHS = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];

    function $(id) { return document.getElementById(id); }
    function anyDialogOpen() {
        return Array.prototype.some.call(document.querySelectorAll('.modal'), function (m) { return m.style.display === 'block'; });
    }

    document.addEventListener('DOMContentLoaded', function () {
        /* Chiusura dei pannelli impostazioni */
        document.querySelectorAll('[data-close-panel]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var panel = $(btn.getAttribute('data-close-panel'));
                if (panel) panel.classList.add('hidden');
            });
        });

        /* Pulsante "Oggi" */
        var title = $('currentMonthYear');
        var prev = $('prevMonthBtn');
        var next = $('nextMonthBtn');
        var todayBtn = $('goTodayBtn');
        var navigating = false;

        function shownMonth() {
            var parts = (title.textContent || '').trim().split(/\s+/);
            return { m: MONTHS.indexOf(parts[0]), y: parseInt(parts[1], 10) };
        }
        function waitForChange(before) {
            return new Promise(function (resolve) {
                var started = Date.now();
                (function poll() {
                    if (title.textContent !== before || Date.now() - started > 2000) return resolve();
                    setTimeout(poll, 25);
                })();
            });
        }
        async function goToday() {
            if (navigating) return;
            navigating = true;
            try {
                var now = new Date();
                for (var i = 0; i < 120; i++) {
                    var s = shownMonth();
                    if (s.m < 0 || isNaN(s.y)) break;
                    var diff = (now.getFullYear() - s.y) * 12 + (now.getMonth() - s.m);
                    if (diff === 0) break;
                    var btn = diff > 0 ? next : prev;
                    if (btn.disabled) break;
                    var before = title.textContent;
                    btn.click();
                    await waitForChange(before);
                }
            } finally { navigating = false; }
        }
        function syncTodayBtn() {
            var s = shownMonth(), now = new Date();
            todayBtn.classList.toggle('hidden', s.m === now.getMonth() && s.y === now.getFullYear());
        }
        todayBtn.addEventListener('click', goToday);
        new MutationObserver(syncTodayBtn).observe(title, { childList: true, characterData: true, subtree: true });
        syncTodayBtn();

        /* Scorciatoie da tastiera: ← → per i mesi, T per oggi */
        document.addEventListener('keydown', function (e) {
            if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
            var t = e.target;
            if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
            if (anyDialogOpen()) return;
            if (e.key === 'ArrowLeft' && !prev.disabled) { prev.click(); e.preventDefault(); }
            else if (e.key === 'ArrowRight' && !next.disabled) { next.click(); e.preventDefault(); }
            else if (e.key === 't' || e.key === 'T') { goToday(); }
        });

        /* Colore del tipo di giornata nel modulo */
        var dayType = $('dayType'), dot = $('dayTypeDot');
        function syncDot() { dot.style.background = 'var(--t-' + (dayType.value || 'ufficio') + ')'; }
        dayType.addEventListener('change', syncDot);
        dayType.addEventListener('input', syncDot);

        /* Titolo della scheda giorno più pulito */
        var modalTitle = $('modalTitle');
        new MutationObserver(function () {
            var txt = modalTitle.textContent;
            if (/^Gestione\s+/.test(txt) && txt !== 'Gestione Giornata') modalTitle.textContent = txt.replace(/^Gestione\s+/, '');
            syncDot();
        }).observe(modalTitle, { childList: true, characterData: true, subtree: true });

        /* Colore della barra del browser in base al tema */
        var meta = document.querySelector('meta[name="theme-color"]');
        function syncThemeColor() {
            var dark = document.documentElement.getAttribute('data-theme') !== 'light';
            if (meta) meta.setAttribute('content', dark ? '#0a0d12' : '#f5f6f8');
        }
        new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        syncThemeColor();
    });
})();
