/*
 * Timbrature · festività
 * --------------------------------------------------------------
 * Calendario delle festività nazionali italiane, con Pasqua e Lunedì
 * dell'Angelo calcolati e il santo patrono configurabile.
 * Dal 2026 è inclusa la festa di San Francesco d'Assisi (4 ottobre),
 * reintrodotta dalla legge 8 ottobre 2025, n. 151.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.TimbratureHolidays = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FIXED_HOLIDAYS = [
        { md: '01-01', name: 'Capodanno' },
        { md: '01-06', name: 'Epifania' },
        { md: '04-25', name: 'Liberazione' },
        { md: '05-01', name: 'Festa del Lavoro' },
        { md: '06-02', name: 'Festa della Repubblica' },
        { md: '08-15', name: 'Ferragosto' },
        { md: '10-04', name: 'San Francesco', fromYear: 2026 },
        { md: '11-01', name: 'Ognissanti' },
        { md: '12-08', name: 'Immacolata' },
        { md: '12-25', name: 'Natale' },
        { md: '12-26', name: 'Santo Stefano' }
    ];

    const pad = (n) => String(n).padStart(2, '0');

    /** Domenica di Pasqua (calendario gregoriano, algoritmo di Meeus/Jones/Butcher). */
    function getEasterSunday(year) {
        const a = year % 19;
        const b = Math.floor(year / 100);
        const c = year % 100;
        const d = Math.floor(b / 4);
        const e = b % 4;
        const f = Math.floor((b + 8) / 25);
        const g = Math.floor((b - f + 1) / 3);
        const h = (19 * a + b - d - g + 15) % 30;
        const i = Math.floor(c / 4);
        const k = c % 4;
        const l = (32 + 2 * e + 2 * i - h - k) % 7;
        const m = Math.floor((a + 11 * h + 22 * l) / 451);
        const month = Math.floor((h + l - 7 * m + 114) / 31);
        const day = ((h + l - 7 * m + 114) % 31) + 1;
        return `${year}-${pad(month)}-${pad(day)}`;
    }

    function addDays(dateStr, days) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const date = new Date(Date.UTC(y, m - 1, d + days));
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    }

    /**
     * Normalizza la data del patrono: accetta "gg/mm", "gg-mm", "gg.mm" o "mm-gg" interno.
     * Restituisce "MM-GG" oppure "" se non valida.
     */
    function normalizePatronDate(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        let day, month;
        let match = raw.match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
        if (match) { day = Number(match[1]); month = Number(match[2]); }
        else if ((match = raw.match(/^--?(\d{2})-(\d{2})$/))) { month = Number(match[1]); day = Number(match[2]); }
        else return '';
        if (month < 1 || month > 12 || day < 1) return '';
        const maxDay = new Date(Date.UTC(2024, month, 0)).getUTCDate();
        if (day > maxDay) return '';
        return `${pad(month)}-${pad(day)}`;
    }

    /**
     * Elenco delle festività dell'anno, in ordine di data.
     * @param {number} year
     * @param {{patron?: string, patronName?: string}} options  patron in formato "MM-GG"
     * @returns {Array<{date: string, name: string}>}
     */
    function getHolidays(year, options = {}) {
        const map = new Map();
        for (const holiday of FIXED_HOLIDAYS) {
            if (holiday.fromYear && year < holiday.fromYear) continue;
            map.set(`${year}-${holiday.md}`, holiday.name);
        }
        const easter = getEasterSunday(year);
        map.set(easter, 'Pasqua');
        map.set(addDays(easter, 1), 'Pasquetta');
        const patron = normalizePatronDate(options.patron && /^\d{2}-\d{2}$/.test(options.patron) ? options.patron.split('-').reverse().join('/') : options.patron);
        if (patron) {
            const key = `${year}-${patron}`;
            const name = String(options.patronName || '').trim() || 'Santo patrono';
            map.set(key, map.has(key) ? `${map.get(key)} · ${name}` : name);
        }
        return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, name]) => ({ date, name }));
    }

    /** Nome della festività per una data "AAAA-MM-GG", oppure null. */
    function getHolidayName(dateStr, options = {}) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
        const year = Number(dateStr.slice(0, 4));
        const found = getHolidays(year, options).find((holiday) => holiday.date === dateStr);
        return found ? found.name : null;
    }

    return Object.freeze({ getEasterSunday, getHolidays, getHolidayName, normalizePatronDate });
});
