/*
 * Timbrature · motore di calcolo
 * --------------------------------------------------------------
 * Regole aziendali e calcolo mensile, senza dipendenze dalla pagina.
 * Funziona sia nel browser (window.TimbratureEngine) sia in Node.js
 * (require), così i test automatici usano esattamente lo stesso codice.
 *
 * La logica è stata estratta senza modifiche dalla versione 2026.11.23.4:
 * i test in tests/engine.golden.test.js lo verificano.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.TimbratureEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FIXED_EMPLOYEE_LEVEL_GROUP = 'b2_b3';
    const FIXED_PERMIT_PROFILE = 'personale';
    const DEFAULT_EXTRA_MINUTES_DESTINATION = 'permesso';

    function normalizeExtraMinutesDestination(value) {
        return value === 'straordinario' ? 'straordinario' : DEFAULT_EXTRA_MINUTES_DESTINATION;
    }

    const STANDARD_ENTRY_MINUTES = 8 * 60; 
    const LUNCH_SHIFTS = {
        "13:30-14:15": { start: 13 * 60 + 30, end: 14 * 60 + 15 },
        "12:00-12:45": { start: 12 * 60 + 0,  end: 12 * 60 + 45 },
        "13:00-13:45": { start: 13 * 60 + 0,  end: 13 * 60 + 45 },
        "12:30-13:15": { start: 12 * 60 + 30, end: 13 * 60 + 15 }
    };
    const DEFAULT_LUNCH_SHIFT_KEY = "13:30-14:15";
    const STANDARD_WORK_DURATION_MINUTES = 8 * 60; 
    const USER_PERSONAL_STANDARD_EXIT_MINUTES = (16 * 60) + 45; 
    const MONTHLY_PERMIT_LIMITS = { due_ore: 3, tre_ore: 1 };
    const DAILY_FLEXIBILITY_MINUTES = 60;
    const MONTHLY_FLEX_BASKET_MINUTES = 20;
    const OVERTIME_MIN_MINUTES = 30;
    const MEDICAL_VISIT_MAX_MINUTES = 180;
    const PHYSIOTHERAPY_MAX_MINUTES = 120;
    const SMART_DAY_START_MINUTES = 8 * 60;
    const SMART_DAY_END_MINUTES = 19 * 60;
    const ALLOWED_LUNCH_CHANGE_REASONS = new Set(['riunione', 'formazione', 'ente_esterno', 'audit']);

    function timeToMinutes(timeStr) {
        if (!timeStr) return null;
        const parts = timeStr.split(':');
        if (parts.length !== 2) return null;
        const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
        if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
        return h * 60 + m;
    }
    function minutesToTime(totalMinutes) {
        if (totalMinutes === null || isNaN(totalMinutes) || totalMinutes < 0) return ""; 
        const hours = Math.floor(totalMinutes / 60), minutes = totalMinutes % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    function roundMinutesToQuarter(minutes, direction) {
        if (minutes === null) return null;
        return direction === 'down' ? Math.floor(minutes / 15) * 15 : Math.ceil(minutes / 15) * 15;
    }

    function isRuleNonWorkingDay(dateStr, dayType = '') {
        const date = new Date(`${dateStr}T00:00:00`);
        const dayOfWeek = date.getDay();
        return dayOfWeek === 0 || dayOfWeek === 6 || dayType === 'lavoro_festivo' || dayType === 'festivo' || dayType === 'weekend';
    }

    function getOvertimeEligibility(dateStr, dayType, levelGroup = 'not_set') {
        const date = new Date(`${dateStr}T00:00:00`);
        const dayOfWeek = date.getDay();
        const isSunday = dayOfWeek === 0;
        const isSaturday = dayOfWeek === 6;
        // Nel selettore "lavoro_festivo" comprende anche il lavoro nel fine settimana.
        // Sabato e domenica mantengono però il proprio trattamento contrattuale.
        const isHoliday = dayType === 'lavoro_festivo' && !isSaturday && !isSunday;
        const isNonWorking = isSaturday || isSunday || isHoliday;

        if (levelGroup === 'not_set') return { eligible: false, needsProfile: true, isNonWorking, saturdayAllowance: false };
        if (levelGroup === 'd1_b1') return { eligible: true, needsProfile: false, isNonWorking, saturdayAllowance: false };
        if (levelGroup === 'b2_b3') return { eligible: isSunday || isHoliday, needsProfile: false, isNonWorking, saturdayAllowance: isSaturday && !isHoliday };
        if (levelGroup === 'a1') return { eligible: isSunday || isHoliday, needsProfile: false, isNonWorking, saturdayAllowance: false };
        return { eligible: false, needsProfile: false, isNonWorking, saturdayAllowance: false };
    }

    function getExternalMinutesOutsidePresence(start, end, effectiveEntry, exit) {
        if ([start, end, effectiveEntry, exit].some(value => value === null) || end <= start || exit <= effectiveEntry) return 0;
        let minutes = 0;
        if (start < effectiveEntry) minutes += Math.max(0, Math.min(end, effectiveEntry) - start);
        if (end > exit) minutes += Math.max(0, end - Math.max(start, exit));
        return minutes;
    }
    function getSortedDayKeys(daysData) { return Object.keys(daysData).sort((a, b) => new Date(a) - new Date(b)); }

    /**
     * Calcola il riepilogo del mese e arricchisce ogni giornata con i campi calcolati.
     * @param {Object} daysData  giornate del mese, chiave "AAAA-MM-GG"
     * @param {Object} options   { settings, year, month (0-11), today }
     * @returns {Object} riepilogo mensile
     */
    function calculateMonth(daysData, options = {}) {
        const settings = options.settings || {};
        const year = options.year;
        const month = options.month;
        let monthlyHolidays = 0;
        let monthlySickDays = 0;
        let monthlyInjuryDays = 0;
        let monthlyParDays = 0;
        let monthlySmartWorkingDays = 0;
        let monthlyBusinessTrips = 0;
        let monthlyPartialHolidayMinutes = 0;
        let monthlyParMinutesUsed = 0;
        let monthlyPartialTripMinutes = 0;
        let monthlyPermits2h = 0;
        let monthlyPermitsLong = 0;
        let monthlyFlexBasketRemaining = MONTHLY_FLEX_BASKET_MINUTES;
        let monthlyFlexBasketUsed = 0;
        let totalRecoveredMinutes = 0;
        let totalUnclassifiedPresence = 0;
        let totalAutomaticExitMinutes = 0;
        let totalExtraCoveredDelay = 0;
        let totalRecognizedOvertime = 0;
        let totalSaturdayAllowanceMinutes = 0;
        let immediateJustificationMinutes = 0;
        const openRecoveryLots = [];
        const extraReserveLots = [];
        const pendingExtraRequests = [];
        const sortedKeys = getSortedDayKeys(daysData);
        const levelGroup = settings.employeeLevelGroup || 'not_set';
        const requestedDestination = normalizeExtraMinutesDestination(settings.extraMinutesDestination);
        const overtimeDestination = requestedDestination === 'permesso' ? 'permesso' : 'straordinario';
        const today = options.today ? new Date(options.today) : new Date();
        const monthIsClosed = new Date(year, month + 1, 1) <= new Date(today.getFullYear(), today.getMonth(), today.getDate());


        const addRecoveryLot = (day, dateStr, kind, minutes) => {
            if (minutes <= 0) return null;
            const lot = { day, dateStr, kind, remaining: minutes };
            openRecoveryLots.push(lot);
            day.debito_finale_giornaliero += minutes;
            if (kind === 'permesso') day.permesso_recupero_residuo += minutes;
            return lot;
        };

        const allocateExtraReserve = (sourceDay, sourceDateStr, requestedMinutes) => {
            let remaining = Math.max(0, requestedMinutes);
            let usedTotal = 0;
            for (const lot of extraReserveLots) {
                if (remaining <= 0) break;
                if (lot.remaining <= 0) continue;
                const used = Math.min(remaining, lot.remaining);
                lot.remaining -= used;
                remaining -= used;
                usedTotal += used;
                lot.day.minuti_maggior_presenza_non_classificata = Math.max(0, (lot.day.minuti_maggior_presenza_non_classificata || 0) - used);
                lot.day.minuti_extra_residui_giornalieri = Math.max(0, (lot.day.minuti_extra_residui_giornalieri || 0) - used);
                lot.day.minuti_extra_coperti_successivamente = (lot.day.minuti_extra_coperti_successivamente || 0) + used;
                totalUnclassifiedPresence = Math.max(0, totalUnclassifiedPresence - used);
            }
            sourceDay.minuti_ritardo_coperto_da_extra = (sourceDay.minuti_ritardo_coperto_da_extra || 0) + usedTotal;
            totalExtraCoveredDelay += usedTotal;
            return usedTotal;
        };

        const allocateRecovery = (sourceDay, sourceDateStr, availableMinutes) => {
            let remaining = Math.floor(availableMinutes / 15) * 15;
            let actuallyUsed = 0;
            for (const lot of openRecoveryLots) {
                if (remaining <= 0) break;
                if (lot.remaining <= 0) continue;
                const used = Math.min(remaining, lot.remaining);
                lot.remaining -= used;
                remaining -= used;
                actuallyUsed += used;
                lot.day.debito_finale_giornaliero = Math.max(0, lot.day.debito_finale_giornaliero - used);
                lot.day.minuti_debito_coperti_da_extra += used;
                if (lot.kind === 'permesso') {
                    lot.day.permesso_recupero_residuo = Math.max(0, lot.day.permesso_recupero_residuo - used);
                    if (lot.remaining === 0) lot.day.permesso_recupero_completato_data = sourceDateStr;
                }
                sourceDay.minuti_recupero_effettuati += used;
                totalRecoveredMinutes += used;
            }
            return availableMinutes - actuallyUsed;
        };

        for (const dateStr of sortedKeys) {
            const day = daysData[dateStr];
            const dayType = day.tipo_giornata || 'ufficio';
            const date = new Date(`${dateStr}T00:00:00`);
            const dayOfWeek = date.getDay();
            const ordinaryWorkingDate = dayOfWeek !== 0 && dayOfWeek !== 6 && dayType !== 'festivo' && dayType !== 'weekend';
            const smartApproved = dayType === 'smart'
                && (Boolean(day.smart_pianificato_approvato)
                    || (settings.defaultSmartDays || []).includes(dayOfWeek));

            Object.assign(day, {
                debito_finale_giornaliero: 0,
                minuti_extra_effettivi_giornalieri: 0,
                minuti_banca_ore_giornalieri: 0,
                minuti_extra_ufficio_accantonati_giornalieri: 0,
                minuti_extra_residui_giornalieri: 0,
                minuti_straordinario: 0,
                minuti_maggior_presenza_non_classificata: 0,
                minuti_recupero_effettuati: 0,
                permesso_recupero_residuo: 0,
                permesso_recupero_completato_data: null,
                minuti_indennita_sabato: 0,
                needsJustification: false,
                minuti_da_giustificare: 0,
                minuti_lavoro_richiesti: 0,
                minuti_lavoro_effettivi: 0,
                saldo_giornaliero_pre_recupero: 0,
                uncovered_deficit: 0,
                minuti_debito_coperti_da_extra: 0,
                minuti_debito_coperti_da_banca: 0,
                minuti_ritardo_coperto_da_extra: 0,
                minuti_extra_coperti_successivamente: 0,
                minuti_debito_mattutino_effettivo: 0,
                minuti_ritardo_mensa: 0,
                minuti_flessibilita_giornaliera_usati: 0,
                minuti_basket_flessibilita_usati: 0,
                minuti_ritardo_oltre_flessibilita: 0,
                minuti_ritardo_da_giustificare: 0,
                minuti_assenza_giustificata: 0,
                documentazione_mancante: false,
                avvisi_conformita: [],
                overtime_below_minimum: false,
                _interimJustificationCondition: false,
                _justificationConditionMet: false
            });
            delete day.error;

            if (dayType === 'ferie') {
                if (ordinaryWorkingDate) monthlyHolidays++;
                continue;
            }
            if (dayType === 'malattia') { monthlySickDays++; continue; }
            if (dayType === 'infortunio') { monthlyInjuryDays++; continue; }
            if (dayType === 'par') {
                if (ordinaryWorkingDate) monthlyParDays++;
                continue;
            }
            if (['congedo_parentale', 'maternita', 'weekend', 'festivo'].includes(dayType)) continue;
            if (dayType === 'trasferta') monthlyBusinessTrips++;
            if (dayType === 'smart' && !smartApproved) {
                day.avvisi_conformita.push('Confermare piano smart e inserimento in SAP');
            }
            if (dayType === 'lavoro_festivo' && !day.straordinario_autorizzato) {
                day.avvisi_conformita.push('Confermare autorizzazione preventiva al lavoro non ordinario');
            }

            monthlyPartialHolidayMinutes += Number(day.minuti_ferie_parziali || 0);
            monthlyParMinutesUsed += Number(day.minuti_par_usati || 0);
            monthlyPartialTripMinutes += Number(day.minuti_trasferta_parziale || 0);
            if (day.tipo_permesso_recupero === 'due_ore') monthlyPermits2h++;
            if (day.tipo_permesso_recupero === 'tre_ore') monthlyPermitsLong++;

            if (!day.entrata || !day.uscita) continue;
            const entryMinutes = timeToMinutes(day.entrata);
            const exitMinutes = timeToMinutes(day.uscita);
            if (entryMinutes === null || exitMinutes === null || exitMinutes <= entryMinutes) {
                day.error = 'Orari non validi';
                continue;
            }

            const nonWorking = isRuleNonWorkingDay(dateStr, dayType);
            const effectiveEntry = nonWorking ? entryMinutes : Math.max(entryMinutes, STANDARD_ENTRY_MINUTES);
            let lunchDuration = 0;
            let lunchDelayMinutes = 0;

            if (dayType === 'ufficio' || dayType === 'lavoro_festivo') {
                const lunchStart = timeToMinutes(day.pranzo_inizio);
                const lunchEnd = timeToMinutes(day.pranzo_fine);
                if (nonWorking) {
                    if (lunchStart !== null && lunchEnd !== null && lunchEnd > lunchStart) {
                        lunchDuration = Math.max(0, Math.min(exitMinutes, lunchEnd) - Math.max(effectiveEntry, lunchStart));
                    }
                } else {
                    const scheduledShift = LUNCH_SHIFTS[day.turno_pranzo] || LUNCH_SHIFTS[DEFAULT_LUNCH_SHIFT_KEY];
                    if (lunchStart !== null && lunchEnd !== null && lunchEnd > lunchStart) {
                        const shiftedLunch = lunchStart !== scheduledShift.start || lunchEnd !== scheduledShift.end;
                        const movedWithAllowedReason = shiftedLunch && ALLOWED_LUNCH_CHANGE_REASONS.has(day.motivo_spostamento_mensa);
                        lunchDelayMinutes = movedWithAllowedReason ? 0 : Math.max(0, lunchEnd - scheduledShift.end);
                        lunchDuration = Math.max(45, lunchEnd - lunchStart);
                        if (shiftedLunch && !movedWithAllowedReason) {
                            day.avvisi_conformita.push('Fascia mensa spostata senza causale ammessa');
                        }
                        if (lunchEnd - lunchStart !== 45) {
                            day.avvisi_conformita.push('Pausa mensa diversa da 45 minuti');
                        }
                    } else {
                        lunchDuration = 45;
                        day.avvisi_conformita.push('Timbrature mensa mancanti o non valide');
                    }
                }
            } else if (dayType === 'smart') {
                lunchDuration = 45;
            }

            const absenceStart = timeToMinutes(day.assenza_inizio);
            const absenceEnd = timeToMinutes(day.assenza_fine);
            let externalMinutes = 0;
            let absenceDeduction = 0;
            let justifiedInterimMinutes = 0;
            let interimAttentionMinutes = 0;
            if (absenceStart !== null && absenceEnd !== null && absenceEnd > absenceStart) {
                if (day.assenza_tipo === 'trasferta') {
                    externalMinutes = getExternalMinutesOutsidePresence(absenceStart, absenceEnd, effectiveEntry, exitMinutes);
                } else {
                    const absenceDuration = absenceEnd - absenceStart;
                    absenceDeduction = Math.max(0, Math.min(exitMinutes, absenceEnd) - Math.max(effectiveEntry, absenceStart));
                    const recognizedTypes = new Set(['visita_medica', 'fisioterapia', 'malattia', 'infortunio', 'maternita', 'permesso_retribuito']);
                    const requiresDocument = ['visita_medica', 'fisioterapia'].includes(day.assenza_tipo);
                    const documentOk = !requiresDocument || Boolean(day.assenza_documentata);
                    const notesOk = day.assenza_tipo !== 'permesso_retribuito' || Boolean(String(day.notes || '').trim());
                    const maxRecognized = day.assenza_tipo === 'visita_medica'
                        ? MEDICAL_VISIT_MAX_MINUTES
                        : day.assenza_tipo === 'fisioterapia' ? PHYSIOTHERAPY_MAX_MINUTES : absenceDuration;

                    if (!recognizedTypes.has(day.assenza_tipo)) {
                        interimAttentionMinutes = absenceDuration;
                        day.avvisi_conformita.push('Causale dell’assenza a ore da verificare');
                    } else if (!documentOk) {
                        interimAttentionMinutes = absenceDuration;
                        day.documentazione_mancante = true;
                        day.avvisi_conformita.push('Certificazione dell’assenza a ore da confermare');
                    } else if (!notesOk) {
                        interimAttentionMinutes = absenceDuration;
                        day.avvisi_conformita.push('Indicare la causale del permesso retribuito');
                    } else {
                        justifiedInterimMinutes = Math.min(absenceDuration, maxRecognized);
                        interimAttentionMinutes = Math.max(0, absenceDuration - justifiedInterimMinutes);
                        if (interimAttentionMinutes > 0) {
                            day.avvisi_conformita.push('Durata dell’assenza oltre il limite previsto');
                        }
                    }
                    day.minuti_assenza_giustificata = justifiedInterimMinutes;
                    day._interimJustificationCondition = justifiedInterimMinutes > 0;
                }
            }

            const workedMinutes = dayType === 'trasferta'
                ? STANDARD_WORK_DURATION_MINUTES
                : Math.max(0, exitMinutes - effectiveEntry + externalMinutes - lunchDuration - absenceDeduction);
            const requiredMinutes = nonWorking ? 0 : STANDARD_WORK_DURATION_MINUTES;
            const dailyBalance = workedMinutes - requiredMinutes;
            day.minuti_lavoro_effettivi = workedMinutes;
            day.minuti_lavoro_richiesti = requiredMinutes;
            day.saldo_giornaliero_pre_recupero = dailyBalance;
            day.minuti_extra_effettivi_giornalieri = Math.max(0, dailyBalance);
            if (dayType === 'smart') {
                const smartCompliant = smartApproved
                    && entryMinutes >= SMART_DAY_START_MINUTES
                    && exitMinutes <= SMART_DAY_END_MINUTES
                    && workedMinutes === STANDARD_WORK_DURATION_MINUTES;
                if (smartCompliant) monthlySmartWorkingDays++;
                else if (!day.avvisi_conformita.includes('Confermare piano smart e inserimento in SAP')) {
                    day.avvisi_conformita.push('Giornata smart da completare o verificare');
                }
            }

            const morningDelay = !nonWorking && dayType === 'ufficio' ? Math.max(0, entryMinutes - STANDARD_ENTRY_MINUTES) : 0;
            const timingDelay = morningDelay + lunchDelayMinutes;
            day.minuti_debito_mattutino_effettivo = morningDelay;
            day.minuti_ritardo_mensa = lunchDelayMinutes;
            if (timingDelay > 0) {
                const dailyFlexUsed = Math.min(timingDelay, DAILY_FLEXIBILITY_MINUTES);
                const overDailyFlex = Math.max(0, timingDelay - DAILY_FLEXIBILITY_MINUTES);
                const basketUsed = Math.min(overDailyFlex, monthlyFlexBasketRemaining);
                const overLimit = Math.max(0, overDailyFlex - basketUsed);
                day.minuti_flessibilita_giornaliera_usati = dailyFlexUsed;
                day.minuti_basket_flessibilita_usati = basketUsed;
                day.minuti_ritardo_oltre_flessibilita = overDailyFlex;
                monthlyFlexBasketRemaining -= basketUsed;
                monthlyFlexBasketUsed += basketUsed;
                if (overLimit > 0) {
                    day.minuti_ritardo_da_giustificare = timingDelay;
                }
            }

            const partialPaidMinutes = Number(day.minuti_ferie_parziali || 0) + Number(day.minuti_par_usati || 0);
            const permitRecoveryMinutes = Number(day.minuti_permesso_usati_giornalieri || 0);
            const rawDeficit = Math.max(0, -dailyBalance);
            const uncoveredDeficit = Math.max(0, rawDeficit - partialPaidMinutes - justifiedInterimMinutes - permitRecoveryMinutes);
            const timingOverLimit = day.minuti_ritardo_da_giustificare > 0;
            const flexEligibleMinutes = timingOverLimit ? 0 : timingDelay;
            const deficitEligibleAfterCompliance = Math.max(0, uncoveredDeficit - interimAttentionMinutes);
            const recoverableDeficit = Math.min(deficitEligibleAfterCompliance, flexEligibleMinutes);
            const immediateUncovered = Math.max(0, uncoveredDeficit - recoverableDeficit);
            const overLimitAfterPaidAbsence = timingOverLimit ? Math.max(0, timingDelay - partialPaidMinutes) : 0;
            const immediateForDay = Math.max(immediateUncovered, overLimitAfterPaidAbsence, interimAttentionMinutes);
            if (immediateForDay > 0) {
                day.minuti_da_giustificare = Math.max(day.minuti_da_giustificare, immediateForDay);
                day.needsJustification = true;
                immediateJustificationMinutes += immediateForDay;
            }
            const extraCoverageRequested = dayType === 'ufficio' && Boolean(day.usa_extra_per_ritardo);
            const timingDebtForExtra = (!timingOverLimit && morningDelay > 0)
                ? Math.min(recoverableDeficit, morningDelay)
                : 0;
            if (extraCoverageRequested && timingOverLimit) {
                day.avvisi_conformita.push('Non è possibile usare i minuti extra per un ritardo oltre la flessibilità disponibile');
            }
            const recoverableAfterExtra = recoverableDeficit;
            day.uncovered_deficit = recoverableAfterExtra;
            const flexibilityLot = addRecoveryLot(day, dateStr, 'flessibilita', recoverableAfterExtra);
            if (extraCoverageRequested && timingDebtForExtra > 0 && flexibilityLot) {
                pendingExtraRequests.push({
                    day,
                    dateStr,
                    recoveryLot: flexibilityLot,
                    remaining: timingDebtForExtra
                });
            }
            addRecoveryLot(day, dateStr, 'permesso', permitRecoveryMinutes);

            let remainingPositive = Math.max(0, dailyBalance);
            if (!nonWorking && remainingPositive > 0) {
                remainingPositive = allocateRecovery(day, dateStr, remainingPositive);
            }

            const overtimeRule = getOvertimeEligibility(dateStr, dayType, levelGroup);
            const authorized = Boolean(day.straordinario_autorizzato);
            const candidateMinutes = nonWorking ? workedMinutes : remainingPositive;
            let recognizedOvertime = 0;
            const priorPermitOpen = openRecoveryLots.some(lot => lot.kind === 'permesso' && lot.remaining > 0 && lot.dateStr <= dateStr);

            if (nonWorking && overtimeRule.saturdayAllowance && authorized && !priorPermitOpen) {
                day.minuti_indennita_sabato = candidateMinutes;
                totalSaturdayAllowanceMinutes += candidateMinutes;
            } else if (authorized && overtimeRule.eligible && candidateMinutes >= OVERTIME_MIN_MINUTES && dayType !== 'smart' && !priorPermitOpen) {
                recognizedOvertime = candidateMinutes;
                day.minuti_straordinario = recognizedOvertime;
                day.minuti_banca_ore_giornalieri = recognizedOvertime;
                totalRecognizedOvertime += recognizedOvertime;
            } else {
                if (authorized && overtimeRule.eligible && candidateMinutes > 0 && candidateMinutes < OVERTIME_MIN_MINUTES) {
                    day.overtime_below_minimum = true;
                }
                const unclassified = day.minuti_indennita_sabato > 0 ? 0 : candidateMinutes;
                day.minuti_maggior_presenza_non_classificata = unclassified;
                day.minuti_extra_residui_giornalieri = unclassified;
                totalUnclassifiedPresence += unclassified;
                if (unclassified > 0) {
                    extraReserveLots.push({
                        day,
                        dateStr,
                        remaining: unclassified,
                        autoBankEligible: dayType === 'ufficio' && !nonWorking
                    });
                }
            }
            if (authorized && overtimeRule.needsProfile) {
                day.avvisi_conformita.push('Gruppo di inquadramento mancante per la prestazione autorizzata');
            }
            if (authorized && priorPermitOpen) {
                day.avvisi_conformita.push('Recuperare il permesso precedente prima dello straordinario');
            }
            if (day.overtime_below_minimum) {
                day.avvisi_conformita.push('Prestazione autorizzata inferiore al minimo di 30 minuti');
            }
        }

        // Le richieste sono in ordine cronologico. Il secondo passaggio usa
        // solo la maggior presenza rimasta davvero disponibile a fine calcolo,
        // così un extra maturato più avanti può coprire un ritardo precedente
        // senza essere conteggiato due volte o sottratto allo straordinario.
        for (const request of pendingExtraRequests) {
            const eligibleOutstanding = Math.min(request.remaining, request.recoveryLot.remaining);
            if (eligibleOutstanding <= 0) continue;
            const used = allocateExtraReserve(request.day, request.dateStr, eligibleOutstanding);
            if (used > 0) {
                request.remaining -= used;
                request.recoveryLot.remaining = Math.max(0, request.recoveryLot.remaining - used);
                request.day.debito_finale_giornaliero = Math.max(0, request.day.debito_finale_giornaliero - used);
                request.day.uncovered_deficit = Math.max(0, request.day.uncovered_deficit - used);
            }
            const stillEligible = Math.min(request.remaining, request.recoveryLot.remaining);
            if (stillEligible > 0) {
                request.day.avvisi_conformita.push(`Copertura con extra in attesa: restano ${stillEligible} min di ritardo mattutino`);
            }
        }

        // Dopo recuperi e coperture richieste, i blocchi completi residui
        // delle giornate ordinarie confluiscono nel contatore per le uscite.
        // L'eventuale resto inferiore a 15 minuti rimane non classificato.
        if (overtimeDestination === 'permesso') {
            for (const lot of extraReserveLots) {
                if (!lot.autoBankEligible || lot.remaining < 15) continue;
                const bankedMinutes = Math.floor(lot.remaining / 15) * 15;
                lot.remaining -= bankedMinutes;
                lot.day.minuti_maggior_presenza_non_classificata = Math.max(
                    0,
                    (lot.day.minuti_maggior_presenza_non_classificata || 0) - bankedMinutes
                );
                lot.day.minuti_extra_residui_giornalieri = Math.max(
                    0,
                    (lot.day.minuti_extra_residui_giornalieri || 0) - bankedMinutes
                );
                lot.day.minuti_banca_ore_giornalieri = (lot.day.minuti_banca_ore_giornalieri || 0) + bankedMinutes;
                lot.day.minuti_extra_ufficio_accantonati_giornalieri = bankedMinutes;
                totalUnclassifiedPresence = Math.max(0, totalUnclassifiedPresence - bankedMinutes);
                totalAutomaticExitMinutes += bankedMinutes;
            }
        }

        let finalRecoveryDebt = 0;
        for (const lot of openRecoveryLots) {
            if (lot.remaining <= 0) continue;
            finalRecoveryDebt += lot.remaining;
            if (monthIsClosed) {
                lot.day.minuti_da_giustificare += lot.remaining;
                lot.day.needsJustification = true;
                lot.day._justificationConditionMet = true;
            }
        }

        const totalParMinutes = monthlyParMinutesUsed + monthlyParDays * STANDARD_WORK_DURATION_MINUTES;
        const bankedOvertime = overtimeDestination === 'permesso'
            ? totalRecognizedOvertime + totalAutomaticExitMinutes
            : 0;
        const paidOvertime = overtimeDestination === 'straordinario' ? totalRecognizedOvertime : 0;

        return {
            E_giorni_ferie: monthlyHolidays,
            F_giorni_malattia: monthlySickDays,
            F_giorni_infortunio: monthlyInjuryDays,
            G_minuti_basket_usati_mese_entrata_oltre_0900: monthlyFlexBasketUsed,
            I_permessi_due_ore_usati_mese: monthlyPermits2h,
            J_permessi_tre_ore_usati_mese: monthlyPermitsLong,
            L_giorni_smart_working: monthlySmartWorkingDays,
            M_giorni_trasferta: monthlyBusinessTrips,
            M_minuti_trasferta_parziale: monthlyPartialTripMinutes,
            N_minuti_ferie_parziali_goduti: monthlyPartialHolidayMinutes,
            O_final_debt_display: finalRecoveryDebt,
            P_final_residual_extra_display: totalUnclassifiedPresence,
            Q_final_permit_bank_display: bankedOvertime,
            R_straordinario_accumulato: paidOvertime,
            S_minuti_par_usati: totalParMinutes,
            T_minuti_da_giustificare: immediateJustificationMinutes + (monthIsClosed ? finalRecoveryDebt : 0),
            U_bankable_debt_candidate: 0,
            V_bankable_debt_authorized_used: 0,
            W_minuti_recuperati: totalRecoveredMinutes,
            X_maggior_presenza_non_classificata: totalUnclassifiedPresence,
            Y_indennita_sabato_minuti: totalSaturdayAllowanceMinutes,
            Z_profilo_mancante: levelGroup === 'not_set',
            AA_avvisi_conformita: sortedKeys.reduce((total, key) => total + (daysData[key].avvisi_conformita?.length || 0), 0),
            AB_minuti_ritardo_coperti_con_extra: totalExtraCoveredDelay
        };
    }

    return Object.freeze({
        FIXED_EMPLOYEE_LEVEL_GROUP, FIXED_PERMIT_PROFILE, DEFAULT_EXTRA_MINUTES_DESTINATION,
        STANDARD_ENTRY_MINUTES, LUNCH_SHIFTS, DEFAULT_LUNCH_SHIFT_KEY, STANDARD_WORK_DURATION_MINUTES,
        USER_PERSONAL_STANDARD_EXIT_MINUTES, MONTHLY_PERMIT_LIMITS, DAILY_FLEXIBILITY_MINUTES,
        MONTHLY_FLEX_BASKET_MINUTES, OVERTIME_MIN_MINUTES, MEDICAL_VISIT_MAX_MINUTES,
        PHYSIOTHERAPY_MAX_MINUTES, SMART_DAY_START_MINUTES, SMART_DAY_END_MINUTES,
        ALLOWED_LUNCH_CHANGE_REASONS,
        normalizeExtraMinutesDestination, timeToMinutes, minutesToTime, roundMinutesToQuarter,
        isRuleNonWorkingDay, getOvertimeEligibility, getExternalMinutesOutsidePresence,
        getSortedDayKeys, calculateMonth
    });
});
