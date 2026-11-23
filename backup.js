/*
 * Timbrature · backup e ripristino
 * --------------------------------------------------------------
 * Esporta in un unico file JSON tutti i mesi e le impostazioni salvati
 * nel browser, e li ripristina su questo o su un altro computer.
 * Le chiavi API e gli altri segreti non vengono mai inclusi nel backup.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.TimbratureBackup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FORMAT = 'timbrature-portale-backup';
    const VERSION = 1;
    const MAX_BYTES = 5 * 1024 * 1024;
    const EXTRA_KEYS = ['theme'];
    const SECRET_PATTERN = /api[-_]?key|token|secret|password/i;

    function storageKeys(storage) {
        const keys = [];
        for (let i = 0; i < storage.length; i++) keys.push(storage.key(i));
        return keys.filter((key) => typeof key === 'string');
    }

    function isAppKey(key, prefix) {
        return typeof key === 'string'
            && (key.startsWith(`${prefix}:`) || EXTRA_KEYS.includes(key))
            && !SECRET_PATTERN.test(key);
    }

    /** Crea l'oggetto di backup con tutte le chiavi dell'app. */
    function createBackup(storage, prefix, meta = {}) {
        const entries = {};
        for (const key of storageKeys(storage).sort()) {
            if (!isAppKey(key, prefix)) continue;
            const value = storage.getItem(key);
            if (typeof value === 'string') entries[key] = value;
        }
        return {
            format: FORMAT,
            version: VERSION,
            appVersion: meta.appVersion || '',
            createdAt: (meta.now ? new Date(meta.now) : new Date()).toISOString(),
            entries
        };
    }

    /** Mesi presenti in un backup, come "AAAA-MM", in ordine. */
    function listMonths(backup, prefix) {
        const marker = `${prefix}:gestioneOrariLavoro:`;
        return Object.keys(backup.entries || {})
            .filter((key) => key.startsWith(marker))
            .map((key) => key.split(':').pop())
            .filter((month) => /^\d{4}-\d{2}$/.test(month))
            .sort();
    }

    /** Controlla che il contenuto sia un backup valido; lancia un Error leggibile in caso contrario. */
    function parseAndValidate(text, prefix) {
        if (typeof text !== 'string' || !text.trim()) throw new Error('Il file è vuoto.');
        if (text.length > MAX_BYTES) throw new Error('Il file è troppo grande per essere un backup delle timbrature.');
        let backup;
        try { backup = JSON.parse(text); } catch (_) { throw new Error('Il file non è in formato JSON valido.'); }
        if (!backup || typeof backup !== 'object' || backup.format !== FORMAT) {
            throw new Error('Il file non è un backup del Portale orari.');
        }
        if (!Number.isInteger(backup.version) || backup.version > VERSION) {
            throw new Error('Il backup proviene da una versione più recente del programma: aggiorna la pagina e riprova.');
        }
        if (!backup.entries || typeof backup.entries !== 'object' || Array.isArray(backup.entries)) {
            throw new Error('Il backup non contiene dati.');
        }
        for (const [key, value] of Object.entries(backup.entries)) {
            if (!isAppKey(key, prefix)) throw new Error(`Il backup contiene una voce non riconosciuta (${key}).`);
            if (typeof value !== 'string') throw new Error(`La voce ${key} non è valida.`);
            if (key.includes(':gestioneOrariLavoro:')) {
                let month;
                try { month = JSON.parse(value); } catch (_) { throw new Error(`Il mese ${key.split(':').pop()} è danneggiato.`); }
                if (!month || typeof month.days !== 'object') throw new Error(`Il mese ${key.split(':').pop()} è danneggiato.`);
            }
        }
        return backup;
    }

    /**
     * Sostituisce i dati dell'app con quelli del backup.
     * Le chiavi dell'app non presenti nel backup vengono rimosse; le altre chiavi del browser restano intatte.
     */
    function restoreBackup(storage, backup, prefix) {
        const existing = storageKeys(storage).filter((key) => isAppKey(key, prefix));
        let removed = 0;
        for (const key of existing) {
            if (!(key in backup.entries)) { storage.removeItem(key); removed++; }
        }
        let written = 0;
        for (const [key, value] of Object.entries(backup.entries)) {
            storage.setItem(key, value);
            written++;
        }
        return { written, removed, months: listMonths(backup, prefix) };
    }

    function backupFileName(now = new Date()) {
        const d = new Date(now);
        const pad = (n) => String(n).padStart(2, '0');
        return `timbrature-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    }

    return Object.freeze({ FORMAT, VERSION, createBackup, listMonths, parseAndValidate, restoreBackup, backupFileName });
});
