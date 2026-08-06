
// ==UserScript==
// @name         CPT View Live Widget - OB Dock
// @namespace    http://tampermonkey.net/
// @version      5.6.4
// @description  Live CPT widget with local upload staging map
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/refs/heads/main/CPT_ViewWidget.js
// @downloadURL  https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/refs/heads/main/CPT_ViewWidget.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      trans-logistics.amazon.com
// @connect      raw.githubusercontent.com
// @connect      cdn.sheetjs.com
// @connect      *.amazon.com
// ==/UserScript==

(function () {
    'use strict';

    // Prevent running inside pop-out window
    if (window.name === 'CPT_Widget_Pop') return;

    // ═══════════════════════════════════════════════════════════════
    // DEFAULT SETTINGS
    // ═══════════════════════════════════════════════════════════════
    var DEFAULTS = {
        theme: 'pink',
        scale: 1.04,
        alertPkg: 130,
        alertMin: 20,
        refreshRate: 10000,       // Widget UI refresh (ms)
        scrapeRate: 15000,        // How often to scrape CPT View (ms)
        dataRefresh: 60000,       // How often to reload CPT View page data (ms)
        siteCode: 'KAFW',
        stagingSource: 'json',    // 'json' or 'excel'
        stagingUrl: 'https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/refs/heads/main/staging_map.json',
        excelUrl: 'https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/refs/heads/main/legacyRAUploadTemplateKAFW.xlsx',
        stagingRefresh: 300000    // Staging map refresh interval (ms) - 5 min default
    };

    // ═══════════════════════════════════════════════════════════════
    // THEMES
    // ═══════════════════════════════════════════════════════════════
    var THEMES = {
        pink:     { bg: '#FFADDB', hd: '#D39ADB', th: '#C99DC7', ac: '#FFF', dk: 0 },
        dark:     { bg: '#1e1e2e', hd: '#2d2d44', th: '#3d3d5c', ac: '#cdd6f4', dk: 1 },
        ocean:    { bg: '#e0f7fa', hd: '#00838f', th: '#00695c', ac: '#fff', dk: 0 },
        sunset:   { bg: '#fff3e0', hd: '#e65100', th: '#bf360c', ac: '#fff', dk: 0 },
        forest:   { bg: '#e8f5e9', hd: '#2e7d32', th: '#1b5e20', ac: '#fff', dk: 0 },
        midnight: { bg: '#0d1117', hd: '#161b22', th: '#21262d', ac: '#c9d1d9', dk: 1 },
        lavender: { bg: '#f3e5f5', hd: '#7b1fa2', th: '#6a1b9a', ac: '#fff', dk: 0 }
    };

    // ═══════════════════════════════════════════════════════════════
    // LOAD/SAVE SETTINGS
    // ═══════════════════════════════════════════════════════════════
    function getSettings() {
        var s = GM_getValue('cpt_ws', null);
        if (s) {
            try { return JSON.parse(s); }
            catch (e) { /* fall through */ }
        }
        return DEFAULTS;
    }

    function saveSettings(s) {
        GM_setValue('cpt_ws', JSON.stringify(s));
    }

    var S = getSettings();
    var T = THEMES[S.theme] || THEMES.pink;

    // Fill in any missing settings with defaults
    S.siteCode = S.siteCode || 'KAFW';
    S.stagingUrl = S.stagingUrl || DEFAULTS.stagingUrl;
    S.excelUrl = S.excelUrl || DEFAULTS.excelUrl;
    S.stagingSource = S.stagingSource || 'json';
    S.stagingRefresh = S.stagingRefresh || DEFAULTS.stagingRefresh;

    // ═══════════════════════════════════════════════════════════════
    // GLOBAL VARIABLES
    // ═══════════════════════════════════════════════════════════════
    var CPT_URL = 'https://trans-logistics.amazon.com/ssp/dock/hrz/cpt';
    var XLSX = null;
    var sheetLoaded = false;
    var stagingMap = null;
    var stagingTimer = null;
    var stagingStatus = 'loading...';

    // Regex helpers for time parsing
    var RH = /(\d+)\s*hr/;
    var RM = /(\d+)\s*min/;
    var RN = /(\d+)/;


    // ═══════════════════════════════════════════════════════════════
    // UTILITY FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Parse time remaining string into total minutes
     * e.g. "2 hr 15 min" -> 135
     */
    function parseTimeMinutes(t) {
        if (!t) return 99999;
        var h = RH.exec(t);
        var m = RM.exec(t);
        return ((h ? +h[1] : 0) * 60) + (m ? +m[1] : 0);
    }

    /**
     * Check if a CPT is late (negative time or contains 'late')
     */
    function isLate(t) {
        return t && (t.charCodeAt(0) === 45 || t.indexOf('late') !== -1 || parseTimeMinutes(t) <= 0);
    }

    /**
     * Check if a CPT is urgent (less than 2 hours remaining)
     */
    function isUrgent(t) {
        return parseTimeMinutes(t) <= 120;
    }

    /**
     * Extract count from a table cell (handles <a> links and plain text)
     */
    function extractCount(cell) {
        if (!cell) return 0;
        var a = cell.firstElementChild;
        if (a && a.tagName === 'A') return +a.textContent || 0;
        var m = RN.exec(cell.textContent);
        return m ? +m[1] : 0;
    }

    // ═══════════════════════════════════════════════════════════════
    // TABLE PARSING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Parse CPT View table rows into structured data
     * Returns: { s: staged[], g: loading[], d: loaded[], a: all[], ts: timestamp }
     */
    function parseTableRows(rows) {
        var staged = [];
        var loading = [];
        var loaded = [];
        var all = [];

        for (var i = 0; i < rows.length; i++) {
            var cells = rows[i].cells;
            if (!cells || cells.length < 22) continue;

            // Extract lane/destination from column 2
            var laneCell = cells[2];
            var span = laneCell.getElementsByTagName('span')[0];
            var laneName = span ? span.textContent : laneCell.textContent;
            var arrowIdx = laneName.indexOf('->');
            var arrowIdx2 = laneName.indexOf('\u2192');
            var dest;
            if (arrowIdx !== -1) {
                dest = laneName.substring(arrowIdx + 2).trim();
            } else if (arrowIdx2 !== -1) {
                dest = laneName.substring(arrowIdx2 + 1).trim();
            } else {
                dest = laneName.trim();
            }

            // Extract other fields
            var timeLeft = cells[1].textContent.trim();
            var cptTime = cells[0].textContent.trim();
            var loadsInProgress = extractCount(cells[4]);
            var totalPkgs = extractCount(cells[8]);
            var inFacility = extractCount(cells[12]);
            var containerized = extractCount(cells[16]);
            var stagedPkgs = extractCount(cells[18]);
            var stagedContainers = extractCount(cells[19]);
            var loadedPkgs = extractCount(cells[20]);
            var loadedContainers = extractCount(cells[21]);

            // Build record for "all" table
            all.push({
                l: dest,
                c: cptTime,
                t: timeLeft,
                tp: totalPkgs,
                if: inFacility,
                cp: containerized,
                sp: stagedPkgs,
                lp: loadedPkgs,
                li: loadsInProgress
            });

            // Staged on floor
            if (stagedPkgs > 0 || stagedContainers > 0) {
                staged.push({
                    l: dest,
                    p: stagedPkgs,
                    cn: stagedContainers,
                    cp: containerized,
                    c: cptTime,
                    t: timeLeft
                });
            }

            // Loading into trucks
            if (loadsInProgress > 0) {
                loading.push({
                    l: dest,
                    lp: loadedPkgs,
                    tp: totalPkgs,
                    cp: containerized,
                    c: cptTime,
                    t: timeLeft
                });
            }

            // Loaded/departed
            if (loadedPkgs > 0 || loadedContainers > 0) {
                loaded.push({
                    l: dest,
                    p: loadedPkgs,
                    cn: loadedContainers,
                    c: cptTime,
                    t: timeLeft
                });
            }
        }

        return { s: staged, g: loading, d: loaded, a: all, ts: Date.now() };
    }


    // ═══════════════════════════════════════════════════════════════
    // SHEETJS LOADER
    // ═══════════════════════════════════════════════════════════════

    /**
     * Load SheetJS library dynamically for xlsx parsing
     */
    function loadSheetJS(cb) {
        if (sheetLoaded && XLSX) return cb(null);
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js',
            timeout: 15000,
            onload: function (r) {
                if (r.status === 200) {
                    try {
                        XLSX = new Function(r.responseText + ';return XLSX;')();
                        sheetLoaded = true;
                        cb(null);
                    } catch (e) {
                        cb(e.message);
                    }
                } else {
                    cb('HTTP ' + r.status);
                }
            },
            onerror: function () { cb('network error'); },
            ontimeout: function () { cb('timeout'); }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // EXCEL CONVERTER
    // ═══════════════════════════════════════════════════════════════

    /**
     * Convert xlsx ArrayBuffer into staging lookup map
     * Parses the 'Allocations' sheet for door/staging/FG assignments
     */
    function convertXlsx(buf) {
        if (!XLSX) return null;
        try {
            var wb = XLSX.read(buf, { type: 'array' });
            var ws = wb.Sheets['Allocations'];
            if (!ws) return null;

            var data = XLSX.utils.sheet_to_json(ws, { header: 1 });
            if (!data || data.length < 2) return null;

            var headerIdx = 0;
            var lookup = {};
            var sc = S.siteCode;

            // Find header row
            for (var i = 0; i < Math.min(5, data.length); i++) {
                if (data[i] && data[i][0] && String(data[i][0]).indexOf('StackingFilter') !== -1) {
                    headerIdx = i;
                    break;
                }
            }

            // Parse rows
            for (var r = headerIdx + 1; r < data.length; r++) {
                var row = data[r];
                if (!row || !row[0] || !row[1]) continue;

                var route = String(row[0]).trim();
                var resource = String(row[1]).trim();

                // Door assignments (e.g. KAFW->AUS5 with DD108)
                if (route.indexOf(sc + '->') === 0 && /^DD\d/.test(resource)) {
                    var sort = route.replace(sc + '->', '');
                    if (!lookup[sort]) lookup[sort] = {};
                    if (!lookup[sort].door) lookup[sort].door = [];
                    lookup[sort].door.push(resource);
                }

                // Staging area assignments (e.g. AUS5-PARENT with DD-STG)
                if (route.indexOf('-PARENT') !== -1 && resource.indexOf('DD-STG') === 0) {
                    var sort2 = route.replace('-PARENT', '');
                    if (!lookup[sort2]) lookup[sort2] = {};
                    lookup[sort2].staging = resource;
                }

                // Finger/FG assignments
                if (route.indexOf('-PARENT') !== -1 && /^FG-\d+/.test(resource) && resource !== 'FG-100' && resource !== 'FG-302') {
                    var sort3 = route.replace('-PARENT', '');
                    if (!lookup[sort3]) lookup[sort3] = {};
                    if (!lookup[sort3].fg) lookup[sort3].fg = [];
                    lookup[sort3].fg.push(resource);
                }
            }

            // Flatten single-item arrays
            for (var k in lookup) {
                if (lookup[k].door && lookup[k].door.length === 1) lookup[k].door = lookup[k].door[0];
                if (lookup[k].fg && lookup[k].fg.length === 1) lookup[k].fg = lookup[k].fg[0];
            }

            return lookup;
        } catch (e) {
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // STAGING MAP FETCHERS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Fetch xlsx from remote URL and convert
     */
    function fetchXlsx(cb) {
        loadSheetJS(function (err) {
            if (err) return cb(err, null);
            GM_xmlhttpRequest({
                method: 'GET',
                url: S.excelUrl + '?t=' + Date.now(),
                responseType: 'arraybuffer',
                timeout: 20000,
                onload: function (r) {
                    if (r.status === 200) {
                        var map = convertXlsx(new Uint8Array(r.response));
                        if (map && Object.keys(map).length) cb(null, map);
                        else cb('no valid data', null);
                    } else {
                        cb('HTTP ' + r.status, null);
                    }
                },
                onerror: function () { cb('network error', null); },
                ontimeout: function () { cb('timeout', null); }
            });
        });
    }

    /**
     * Fetch JSON staging map from remote URL
     */
    function fetchJSON(cb) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: S.stagingUrl + '?t=' + Date.now(),
            timeout: 10000,
            onload: function (r) {
                if (r.status === 200) {
                    try {
                        stagingMap = JSON.parse(r.responseText);
                        stagingStatus = Object.keys(stagingMap).length + ' sorts (json)';
                        GM_setValue('cpt_staging_cache', JSON.stringify({ data: stagingMap, ts: Date.now() }));
                    } catch (e) {
                        stagingMap = stagingMap || {};
                        stagingStatus = 'parse error';
                    }
                } else {
                    stagingMap = stagingMap || {};
                    stagingStatus = 'fetch failed';
                }
                if (cb) cb();
            },
            onerror: function () {
                stagingMap = stagingMap || {};
                stagingStatus = 'error';
                if (cb) cb();
            },
            ontimeout: function () {
                stagingMap = stagingMap || {};
                stagingStatus = 'timeout';
                if (cb) cb();
            }
        });
    }

    /**
     * Main staging loader - checks local upload first, then cache, then remote
     */
    function loadStaging(cb) {
        // Priority 1: Local upload
        var local = GM_getValue('cpt_staging_local', null);
        if (local) {
            try {
                var lc = JSON.parse(local);
                stagingMap = lc.data;
                stagingStatus = Object.keys(lc.data).length + ' sorts (local)';
                if (cb) cb();
                return;
            } catch (e) { /* fall through */ }
        }

        // Priority 2: Cache (if not expired)
        var cached = GM_getValue('cpt_staging_cache', null);
        if (cached) {
            try {
                var c = JSON.parse(cached);
                if (Date.now() - c.ts < S.stagingRefresh) {
                    stagingMap = c.data;
                    stagingStatus = Object.keys(stagingMap).length + ' sorts (cached)';
                    if (cb) cb();
                    return;
                }
            } catch (e) { /* fall through */ }
        }

        // Priority 3: Remote fetch
        if (S.stagingSource === 'excel') {
            fetchXlsx(function (err, map) {
                if (!err && map) {
                    stagingMap = map;
                    stagingStatus = Object.keys(map).length + ' sorts (xlsx)';
                    GM_setValue('cpt_staging_cache', JSON.stringify({ data: map, ts: Date.now() }));
                } else {
                    // Fallback to JSON if excel fails
                    fetchJSON(cb);
                    return;
                }
                if (cb) cb();
            });
        } else {
            fetchJSON(cb);
        }
    }

    /**
     * Start auto-refresh timer for staging map
     */
    function startStagingRefresh() {
        if (stagingTimer) clearInterval(stagingTimer);
        stagingTimer = setInterval(function () {
            // Don't refresh if using local upload
            if (!GM_getValue('cpt_staging_local', null)) {
                loadStaging();
            }
        }, S.stagingRefresh);
    }

    /**
     * Get staging info for a specific sort/lane
     */
    function getStaging(sort) {
        return stagingMap && stagingMap[sort] ? stagingMap[sort] : null;
    }

    /**
     * Export current staging map as downloadable JSON file
     */
    function exportJSON() {
        if (!stagingMap || !Object.keys(stagingMap).length) return alert('No staging map loaded');
        var json = JSON.stringify(stagingMap, null, 2);
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'staging_map_' + S.siteCode + '_' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ═══════════════════════════════════════════════════════════════
    // LOCAL FILE UPLOAD HANDLERS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Handle a locally uploaded .json or .xlsx file
     */
    function handleLocalUpload(file, statusEl) {
        if (!file) {
            if (statusEl) statusEl.textContent = '\u274C no file selected';
            return;
        }

        var name = file.name.toLowerCase();

        if (name.endsWith('.json')) {
            var reader = new FileReader();
            reader.onload = function (e) {
                try {
                    var data = JSON.parse(e.target.result);
                    if (typeof data === 'object' && Object.keys(data).length) {
                        stagingMap = data;
                        stagingStatus = Object.keys(data).length + ' sorts (local)';
                        GM_setValue('cpt_staging_local', JSON.stringify({
                            data: data,
                            ts: Date.now(),
                            name: file.name
                        }));
                        if (statusEl) statusEl.textContent = '\u2705 ' + Object.keys(data).length + ' sorts from ' + file.name;
                    } else {
                        if (statusEl) statusEl.textContent = '\u274C invalid json structure';
                    }
                } catch (err) {
                    if (statusEl) statusEl.textContent = '\u274C ' + err.message;
                }
            };
            reader.readAsText(file);

        } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
            var reader2 = new FileReader();
            reader2.onload = function (e) {
                loadSheetJS(function (err) {
                    if (err) {
                        if (statusEl) statusEl.textContent = '\u274C sheetjs: ' + err;
                        return;
                    }
                    var map = convertXlsx(new Uint8Array(e.target.result));
                    if (map && Object.keys(map).length) {
                        stagingMap = map;
                        stagingStatus = Object.keys(map).length + ' sorts (local xlsx)';
                        GM_setValue('cpt_staging_local', JSON.stringify({
                            data: map,
                            ts: Date.now(),
                            name: file.name
                        }));
                        if (statusEl) statusEl.textContent = '\u2705 ' + Object.keys(map).length + ' sorts from ' + file.name;
                    } else {
                        if (statusEl) statusEl.textContent = '\u274C no valid data in xlsx';
                    }
                });
            };
            reader2.readAsArrayBuffer(file);

        } else {
            if (statusEl) statusEl.textContent = '\u274C use .json or .xlsx';
        }
    }

    /**
     * Clear local upload and revert to remote source
     */
    function clearLocal(statusEl) {
        GM_setValue('cpt_staging_local', null);
        if (statusEl) statusEl.textContent = '\u2705 cleared, using remote source';
        loadStaging();
    }


    // ═══════════════════════════════════════════════════════════════
    // STALE POP-OUT RECOVERY
    // ═══════════════════════════════════════════════════════════════
    if (GM_getValue('cpt_widget_popped', false) && Date.now() - GM_getValue('cpt_widget_pop_heartbeat', 0) > 5000) {
        GM_setValue('cpt_widget_popped', false);
    }

    // ═══════════════════════════════════════════════════════════════
    // MODE 1: SCRAPER (runs on CPT View page)
    // ═══════════════════════════════════════════════════════════════
    if (window.location.href.indexOf('trans-logistics.amazon.com/ssp/dock') !== -1) {

        // Signal that CPT View is open
        GM_setValue('cpt_view_open', true);
        GM_setValue('cpt_auto_opened', false);
        window.addEventListener('beforeunload', function () {
            GM_setValue('cpt_view_open', false);
        });

        // Add syncing badge
        GM_addStyle(
            '#cpt-sb{position:fixed;bottom:10px;right:10px;background:' + T.hd + ';color:' + T.ac +
            ';padding:8px 14px;border-radius:20px;font:11px sans-serif;z-index:999999;' +
            'box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;gap:8px}' +
            '.sbd{width:8px;height:8px;border-radius:50%;background:#27ae60;animation:sp 2s infinite}' +
            '@keyframes sp{0%,100%{opacity:1}50%{opacity:.4}}' +
            '.sbt{font-size:9px;opacity:.8}'
        );

        var badge = document.createElement('div');
        badge.id = 'cpt-sb';
        badge.innerHTML = '<span class="sbd"></span><span>widget syncing</span>' +
            '<span class="sbt" id="sbt"></span><span class="sbt" id="sbc"></span>';
        document.body.appendChild(badge);

        var scrapeTimer = null;
        var refreshTimer = null;

        /**
         * Force CPT View to refresh its data
         */
        function refreshCPTView() {
            // Try DataTable ajax reload
            if (window.jQuery) {
                try {
                    var dt = window.jQuery('#cptsLoadInProgress').DataTable();
                    if (dt.ajax && dt.ajax.url()) {
                        dt.ajax.reload(null, false);
                        return;
                    }
                } catch (e) { /* continue */ }
            }

            // Try clicking refresh button
            var btn = document.querySelector('#searchButton,[data-action="refresh"],.refreshBtn');
            if (btn) { btn.click(); return; }

            // Try DataTable draw
            if (window.jQuery) {
                try {
                    window.jQuery('#cptsLoadInProgress').DataTable().draw(false);
                    return;
                } catch (e) { /* continue */ }
            }

            // Last resort: full page reload
            location.reload();
        }

        /**
         * Scrape current visible table rows
         */
        function scrape() {
            var tbl = document.getElementById('cptsLoadInProgress');
            if (!tbl || !tbl.tBodies[0]) return;

            var rows = tbl.tBodies[0].rows;
            if (!rows.length || (rows.length === 1 && rows[0].textContent.indexOf('oading') !== -1)) return;

            // Check if table has multiple pages
            if (window.jQuery) {
                try {
                    var dt = window.jQuery('#cptsLoadInProgress').DataTable();
                    var info = dt.page.info();
                    if (info.pages > 1) {
                        scrapeAllPages(dt, info);
                        return;
                    }
                } catch (e) { /* single page fallback */ }
            }

            finishScrape(rows);
        }

        /**
         * Scrape all pages of a paginated DataTable
         */
        function scrapeAllPages(dt, info) {
            var totalPages = info.pages;
            var originalPage = info.page;
            var collected = [];

            (function nextPage(p) {
                dt.page(p).draw(false);
                setTimeout(function () {
                    var rows = document.querySelectorAll('#cptsLoadInProgress tbody tr');
                    for (var i = 0; i < rows.length; i++) {
                        if (rows[i].cells && rows[i].cells.length >= 22) {
                            collected.push(rows[i].cloneNode(true));
                        }
                    }
                    if (p + 1 < totalPages) {
                        nextPage(p + 1);
                    } else {
                        // Return to original page
                        dt.page(originalPage).draw(false);
                        finishScrape(collected);
                        collected = null;
                    }
                }, 800);
            })(0);
        }

        /**
         * Parse scraped rows and save to GM storage
         */
        function finishScrape(rows) {
            var data = parseTableRows(rows);
            GM_setValue('cpt_widget_data', JSON.stringify(data));

            // Update badge
            var timeEl = document.getElementById('sbt');
            var countEl = document.getElementById('sbc');
            if (timeEl) {
                timeEl.textContent = '\xB7 ' + new Date().toLocaleTimeString('en-US', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                });
            }
            if (countEl) {
                countEl.textContent = '\xB7 ' + data.a.length + ' cpts';
            }
        }

        /**
         * Start scraping & refresh loops
         */
        function startScraping() {
            if (scrapeTimer) return;
            scrapeTimer = setInterval(scrape, S.scrapeRate);
            refreshTimer = setInterval(function () {
                refreshCPTView();
                setTimeout(scrape, 5000);
            }, S.dataRefresh);
        }

        function stopScraping() {
            if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
            if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        }

        // Pause when tab is hidden to save resources
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) stopScraping();
            else { scrape(); startScraping(); }
        });

        // Wait for table to be ready, then start
        (function waitForTable() {
            var tbl = document.getElementById('cptsLoadInProgress');
            if (!tbl || !tbl.tBodies[0]) { setTimeout(waitForTable, 2000); return; }
            var rows = tbl.tBodies[0].rows;
            if (!rows.length || (rows.length === 1 && rows[0].textContent.indexOf('oading') !== -1)) {
                setTimeout(waitForTable, 2000);
                return;
            }
            scrape();
            startScraping();
        })();

        return; // Stop here - don't render widget on CPT View page
    }


    // ═══════════════════════════════════════════════════════════════
    // MODE 2: WIDGET (runs on all other pages)
    // ═══════════════════════════════════════════════════════════════

    var popWin = null;
    var popInterval = null;
    var updateTimer = null;
    var monitorTimer = null;
    var isVisible = !document.hidden;

    // ═══════════════════════════════════════════════════════════════
    // ADHOC TRAILER REQUEST FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Generate adhoc trailer request message
     */
    function generateAdhoc(alert) {
        var info = getStaging(alert.l);
        var location = '';
        if (info) {
            var parts = [];
            if (info.staging) parts.push(info.staging);
            if (info.door) parts.push('Door ' + (Array.isArray(info.door) ? info.door.join('/') : info.door));
            if (parts.length) location = ' at ' + parts.join(', ');
        }
        return S.siteCode + ' requesting adhoc 53\' preloaded trailer for ' + alert.l +
            '. All prior trailers have been filled to capacity and have departed the facility. ' +
            (alert.cn || 0) + ' ' + (alert.cn === 1 ? 'shuttle/cart' : 'shuttles/carts') +
            ' containing ' + alert.p + ' packages remain on the dock' + location + ' and at risk.';
    }

    /**
     * Copy adhoc message to clipboard
     */
    function copyAdhoc(alert) {
        var msg = generateAdhoc(alert);
        if (typeof GM_setClipboard === 'function') {
            GM_setClipboard(msg, 'text');
        } else {
            var ta = document.createElement('textarea');
            ta.value = msg;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        return msg;
    }

    /**
     * Render adhoc suggestion panel in the widget
     */
    function showAdhocPanel(doc, alerts, staged) {
        var panel = doc.getElementById('adhoc-panel');
        if (!panel) return;

        if (!alerts.length) {
            panel.innerHTML = '';
            return;
        }

        var html = '<div class="ahs"><div class="aht">\uD83D\uDE9A adhoc suggestions</div>';

        for (var i = 0; i < alerts.length; i++) {
            var a = alerts[i];

            // Get container count from staged data
            for (var j = 0; j < staged.length; j++) {
                if (staged[j].l === a.l) {
                    a.cn = staged[j].cn || 0;
                    break;
                }
            }

            // Get staging location info
            var info = getStaging(a.l);
            var locTag = '';
            if (info) {
                var locs = [];
                if (info.staging) locs.push(info.staging);
                if (info.door) locs.push('Door: ' + (Array.isArray(info.door) ? info.door.join(', ') : info.door));
                if (info.fg) locs.push('FG: ' + (Array.isArray(info.fg) ? info.fg.join(', ') : info.fg));
                if (locs.length) locTag = '<div class="ahl">\uD83D\uDCCD ' + locs.join(' \xB7 ') + '</div>';
            }

            html += '<div class="ahi">' +
                '<div class="ahn">' + a.l + ' <span class="ahd">(' + a.p + 'pkg / ' + a.t + ')</span></div>' +
                locTag +
                '<div class="ahm">' + generateAdhoc(a) + '</div>' +
                '<button class="ahc" data-i="' + i + '">copy</button>' +
                '</div>';
        }

        html += '</div>';
        panel.innerHTML = html;

        // Attach copy button handlers
        var btns = panel.querySelectorAll('.ahc');
        for (var k = 0; k < btns.length; k++) {
            btns[k].onclick = function (e) {
                e.stopPropagation();
                var idx = +this.getAttribute('data-i');
                copyAdhoc(alerts[idx]);
                this.textContent = '\u2713';
                var btn = this;
                setTimeout(function () { btn.textContent = 'copy'; }, 2000);
            };
        }
    }

    /**
     * Get alerts (staged freight at risk)
     */
    function getAlerts(staged) {
        var alerts = [];
        for (var i = staged.length - 1; i >= 0; i--) {
            var s = staged[i];
            var minutes = parseTimeMinutes(s.t);
            if (s.p >= S.alertPkg && minutes <= S.alertMin) {
                alerts.push({ l: s.l, p: s.p, cn: s.cn || 0, t: s.t, m: minutes });
            }
        }
        if (alerts.length > 1) {
            alerts.sort(function (x, y) { return x.m - y.m; });
        }
        return alerts;
    }


    // ═══════════════════════════════════════════════════════════════
    // CSS GENERATION
    // ═══════════════════════════════════════════════════════════════

    /**
     * Generate main widget CSS
     * @param {boolean} pop - true if generating for pop-out window
     */
    function makeWidgetCSS(pop) {
        var dk = T.dk;
        var bg2 = dk ? '#2a2a3e' : '#FFF';
        var fg = dk ? T.ac : '#000';
        var border = dk ? '#333' : '#D9D9FF';
        var hover = dk ? '#2a2a3e' : '#D9D9FF';
        var css = '';

        // Position/container styles (only for inline widget, not pop-out)
        if (!pop) {
            css += '#cpt-w{position:fixed;width:420px;max-height:500px;border-radius:10px;' +
                'box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:999999;overflow:hidden;' +
                'transform:scale(' + S.scale + ');transform-origin:bottom right;' +
                'display:flex;flex-direction:column}' +
                '#cpt-w.min{max-height:none;height:auto}' +
                '#cpt-w.min .cb{display:none}' +
                '#cpt-w.min .mv{display:flex}' +
                '.mv{display:none}' +
                '#cpt-tb{position:fixed;bottom:15px;right:15px;width:42px;height:42px;border-radius:50%;' +
                'background:' + T.hd + ';color:' + T.ac + ';border:none;' +
                'box-shadow:0 4px 12px rgba(0,0,0,.4);z-index:999999;cursor:pointer;font-size:18px;' +
                'display:flex;align-items:center;justify-content:center}' +
                '.snp{transition:top .25s,left .25s,right .25s,bottom .25s}';
        } else {
            css += '*{box-sizing:border-box;margin:0;padding:0}' +
                'html,body{background:' + T.bg + ';overflow-y:auto;overflow-x:hidden}';
        }

        // Shared styles
        css += '.cw{font:13px "Segoe UI",sans-serif;color:' + fg + ';background:' + T.bg +
            ';display:flex;flex-direction:column;height:100%}' +
            '.ch{background:' + T.hd + ';padding:10px 15px;display:flex;justify-content:space-between;' +
            'align-items:center;cursor:grab;user-select:none;flex-shrink:0' +
            (pop ? ';position:sticky;top:0;z-index:10' : '') + '}' +
            '.ch h3{margin:0;font-size:14px;color:' + T.ac + '}' +
            '.cs{font-size:11px;color:' + T.ac + '}' +
            '.cb{padding:10px 15px;overflow-y:auto;flex:1;min-height:0}' +
            '.sec{margin-bottom:12px}' +
            '.st{font-size:12px;font-weight:bold;text-transform:lowercase;margin-bottom:6px;' +
            'border-bottom:1px solid ' + T.ac + ';padding-bottom:4px;opacity:.8}' +
            'table{width:100%;border-collapse:collapse;font-size:12px}' +
            'th{text-align:left;padding:4px 6px;background:' + T.th + ';color:' + T.ac + ';font-weight:normal;font-size:11px}' +
            'td{padding:4px 6px;border-bottom:1px solid ' + border + '}' +
            'tr:hover{background:' + hover + '}' +
            '.sm{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}' +
            '.si{background:' + bg2 + ';padding:6px 12px;border-radius:6px;text-align:center' +
            (pop ? ';flex:1;min-width:60px' : '') + '}' +
            '.si .n{font-size:18px;font-weight:bold;display:block}' +
            '.si .lb{font-size:10px;color:#888;text-transform:lowercase}' +
            '.bt{background:none;border:none;color:' + T.ac + ';font-size:16px;cursor:pointer;padding:0 5px}' +
            '.bt:hover{opacity:.7}' +
            '.ss{color:#f39c12;font-weight:bold}' +
            '.sl{color:#3498db;font-weight:bold}' +
            '.sd{color:#27ae60;font-weight:bold}' +
            '.sr{color:#e74c3c;font-weight:bold}' +
            '.sc{color:#9b59b6;font-weight:bold}' +
            '.pl{display:inline-block;width:8px;height:8px;border-radius:50%;background:#27ae60;margin-right:6px;animation:p 2s infinite}' +
            '@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}' +
            '.wn{background:#fff3cd;color:#856404;padding:4px 8px;border-radius:4px;font-size:11px;margin-bottom:8px;text-align:center}' +
            '.mv{gap:12px;align-items:center;flex-wrap:wrap;padding:8px 15px;font-size:12px}' +
            '.mi{display:flex;align-items:center;gap:4px}' +
            '.mi .mn{font-weight:bold;font-size:14px}' +
            '.mi .ml{font-size:11px;color:#888;text-transform:lowercase}' +
            '.mu{font-size:10px;color:#888;margin-left:auto}' +
            '.src{font-size:9px;color:#888;text-align:center;margin-top:6px}' +
            // Alert styles
            '.al{background:#e74c3c;color:#FFF;padding:6px 10px;border-radius:6px;margin-bottom:8px;font-size:11px;animation:f 1s infinite}' +
            '.ali{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.2)}' +
            '.ali:last-child{border-bottom:none}' +
            '.alt{font-weight:bold;font-size:12px;margin-bottom:4px}' +
            '.aln{font-weight:bold}' +
            '.ald{font-size:10px;opacity:.9}' +
            '@keyframes f{0%,100%{opacity:1}50%{opacity:.85}}' +
            '.mal{background:#e74c3c;color:#FFF;padding:4px 8px;border-radius:4px;font-size:10px;margin-top:4px;animation:f 1s infinite}' +
            // Adhoc panel styles
            '.ahs{background:' + (dk ? '#2d2040' : '#fce4ec') + ';border:1px solid ' + (dk ? '#6a1b9a' : '#f48fb1') +
            ';border-radius:8px;padding:10px;margin-bottom:10px}' +
            '.aht{font-size:12px;font-weight:bold;margin-bottom:8px;color:' + (dk ? '#ce93d8' : '#880e4f') + '}' +
            '.ahi{background:' + (dk ? '#1e1e2e' : '#fff') + ';border-radius:6px;padding:8px;margin-bottom:6px;' +
            'border:1px solid ' + (dk ? '#333' : '#f8bbd0') + '}' +
            '.ahn{font-size:12px;font-weight:bold;color:' + (dk ? '#f48fb1' : '#c62828') + '}' +
            '.ahd{font-weight:normal;font-size:10px;opacity:.7}' +
            '.ahl{font-size:10px;color:' + (dk ? '#81d4fa' : '#1565c0') + ';font-weight:bold;margin:2px 0}' +
            '.ahm{font-size:10px;background:' + (dk ? '#16213e' : '#f5f5f5') + ';padding:6px;border-radius:4px;' +
            'margin:4px 0;font-family:monospace;word-wrap:break-word;color:' + (dk ? '#cdd6f4' : '#333') + '}' +
            '.ahc{background:' + T.hd + ';color:' + T.ac + ';border:none;padding:4px 10px;border-radius:4px;' +
            'font-size:10px;cursor:pointer;font-weight:bold}';

        return css;
    }

    /**
     * Generate settings panel CSS
     */
    function makeSettingsCSS() {
        var dk = T.dk;
        return '#cpt-sp{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:380px;max-height:85vh;' +
            'background:' + (dk ? '#1e1e2e' : '#fff') + ';color:' + (dk ? '#cdd6f4' : '#333') +
            ';border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.5);z-index:9999999;overflow-y:auto;font:13px sans-serif}' +
            '.sp-h{background:' + T.hd + ';color:' + T.ac + ';padding:12px 18px;display:flex;justify-content:space-between;' +
            'align-items:center;border-radius:12px 12px 0 0}' +
            '.sp-h h3{margin:0;font-size:15px}' +
            '.sp-b{padding:18px}' +
            '.sp-row{margin-bottom:14px}' +
            '.sp-row label{display:block;font-size:11px;font-weight:bold;text-transform:uppercase;margin-bottom:5px;opacity:.7}' +
            '.sp-row input,.sp-row select{width:100%;padding:8px;border:1px solid ' + (dk ? '#444' : '#ddd') +
            ';border-radius:6px;font-size:13px;background:' + (dk ? '#2a2a3e' : '#f9f9f9') + ';color:inherit}' +
            '.sp-themes{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}' +
            '.sp-th{width:100%;aspect-ratio:1;border-radius:8px;border:3px solid transparent;cursor:pointer;position:relative}' +
            '.sp-th.active{border-color:' + T.hd + '}' +
            '.sp-th::after{content:attr(data-name);position:absolute;bottom:2px;left:0;right:0;text-align:center;font-size:9px;color:#666}' +
            '.sp-save{width:100%;padding:10px;background:' + T.hd + ';color:' + T.ac +
            ';border:none;border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;margin-top:8px}' +
            '.sp-save:hover{opacity:.9}' +
            '.sp-val{font-size:11px;color:#888;text-align:right}' +
            '.sp-toggle{display:flex;border-radius:6px;overflow:hidden;border:1px solid ' + (dk ? '#444' : '#ddd') + '}' +
            '.sp-tog{flex:1;padding:8px;text-align:center;cursor:pointer;font-size:12px;font-weight:bold;' +
            'background:' + (dk ? '#2a2a3e' : '#f9f9f9') + ';color:inherit;border:none}' +
            '.sp-tog.active{background:' + T.hd + ';color:' + T.ac + '}' +
            '.sp-cond{margin-top:8px;padding:10px;background:' + (dk ? '#2a2a3e' : '#f5f5f5') + ';border-radius:6px;font-size:11px}' +
            '.sp-status{margin-top:6px;padding:6px 10px;background:' + (dk ? '#1a3a1a' : '#e8f5e9') +
            ';color:' + (dk ? '#81c784' : '#2e7d32') + ';border-radius:4px;font-size:11px}' +
            '.sp-upload{border:2px dashed ' + (dk ? '#555' : '#ccc') + ';border-radius:8px;padding:16px;' +
            'text-align:center;margin-top:8px;cursor:pointer}' +
            '.sp-upload:hover,.sp-upload.active{border-color:' + T.hd + '}' +
            '.sp-upload input{display:none}' +
            '.sp-li{margin-top:6px;padding:6px 10px;background:' + (dk ? '#2d3748' : '#e3f2fd') +
            ';color:' + (dk ? '#90cdf4' : '#1565c0') + ';border-radius:4px;font-size:11px;' +
            'display:flex;justify-content:space-between;align-items:center}' +
            '.sp-lc{background:#e74c3c;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer}' +
            '#cpt-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:9999998}';
    }

    // Apply styles
    var styleEl = GM_addStyle(makeWidgetCSS(false) + makeSettingsCSS());


    // ═══════════════════════════════════════════════════════════════
    // HTML TEMPLATES
    // ═══════════════════════════════════════════════════════════════

    var TABLE_HTML = '<div id="wa"></div><div id="adhoc-panel"></div><div id="ww"></div>' +
        '<div class="sm">' +
        '<div class="si"><span class="n" id="cs">-</span><span class="lb">staged</span></div>' +
        '<div class="si"><span class="n" id="cl">-</span><span class="lb">loading</span></div>' +
        '<div class="si"><span class="n" id="cd">-</span><span class="lb">loaded</span></div>' +
        '<div class="si"><span class="n sr" id="ct">-</span><span class="lb">late</span></div>' +
        '</div>' +
        '<div class="sec"><div class="st">currently staged on floor</div>' +
        '<table><thead><tr><th>lane</th><th>pkgs</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead>' +
        '<tbody id="ts"><tr><td colspan="5">fetching...</td></tr></tbody></table></div>' +
        '<div class="sec"><div class="st">loading into trucks</div>' +
        '<table><thead><tr><th>lane</th><th>loaded</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead>' +
        '<tbody id="tl"><tr><td colspan="5">fetching...</td></tr></tbody></table></div>' +
        '<div class="sec"><div class="st">all active cpts</div>' +
        '<table><thead><tr><th>lane</th><th>total</th><th>in fac</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead>' +
        '<tbody id="ta"><tr><td colspan="6">fetching...</td></tr></tbody></table></div>' +
        '<div class="src" id="src"></div>';

    var WIDGET_HTML = '<div class="ch" id="ch">' +
        '<h3>outbound dock :3 - live</h3>' +
        '<div>' +
        '<span class="cs" id="cst">starting...</span>' +
        '<button class="bt" id="bset" title="settings">\u2699</button>' +
        '<button class="bt" id="bp" title="pop out">\u29C9</button>' +
        '<button class="bt" id="bm" title="minimize">\u2014</button>' +
        '<button class="bt" id="bx" title="close">\u2715</button>' +
        '</div></div>' +
        '<div class="mv" id="mv">' +
        '<div class="mi"><span class="mn ss" id="ms">-</span><span class="ml">staged</span></div>' +
        '<div class="mi"><span class="mn sl" id="ml">-</span><span class="ml">loading</span></div>' +
        '<div class="mi"><span class="mn sd" id="md">-</span><span class="ml">loaded</span></div>' +
        '<div class="mi"><span class="mn sr" id="mt">-</span><span class="ml">late</span></div>' +
        '<div class="mu" id="mu">\u2014</div>' +
        '<div id="ma"></div>' +
        '</div>' +
        '<div class="cb" id="cb">' + TABLE_HTML + '</div>';

    // ═══════════════════════════════════════════════════════════════
    // SETTINGS PANEL
    // ═══════════════════════════════════════════════════════════════

    function openSettings() {
        if (document.getElementById('cpt-sp')) return;

        // Create overlay
        var overlay = document.createElement('div');
        overlay.id = 'cpt-overlay';
        document.body.appendChild(overlay);

        // Create panel
        var panel = document.createElement('div');
        panel.id = 'cpt-sp';

        // Build theme swatches
        var themeHTML = '';
        for (var k in THEMES) {
            var th = THEMES[k];
            themeHTML += '<div class="sp-th' + (S.theme === k ? ' active' : '') +
                '" data-theme="' + k + '" data-name="' + k +
                '" style="background:linear-gradient(135deg,' + th.hd + ' 50%,' + th.bg + ' 50%)"></div>';
        }

        var stagingMin = Math.round(S.stagingRefresh / 60000);
        var isExcel = S.stagingSource === 'excel';

        // Check for local file
        var localData = GM_getValue('cpt_staging_local', null);
        var localInfoHTML = '';
        if (localData) {
            try {
                var ld = JSON.parse(localData);
                localInfoHTML = '<div class="sp-li"><span>\uD83D\uDCC1 ' +
                    (ld.name || 'file') + ' (' + Object.keys(ld.data).length + ' sorts)' +
                    '</span><button class="sp-lc" id="sp-lc">clear</button></div>';
            } catch (e) { /* ignore */ }
        }

        panel.innerHTML =
            '<div class="sp-h"><h3>\u2699 settings</h3><button class="bt" id="sp-close">\u2715</button></div>' +
            '<div class="sp-b">' +
            // Site code
            '<div class="sp-row"><label>site code</label>' +
            '<input id="sp-site" value="' + S.siteCode + '" maxlength="6" style="text-transform:uppercase"></div>' +
            // Staging source toggle
            '<div class="sp-row"><label>staging source</label>' +
            '<div class="sp-toggle">' +
            '<button class="sp-tog' + (isExcel ? '' : ' active') + '" data-src="json">JSON</button>' +
            '<button class="sp-tog' + (isExcel ? ' active' : '') + '" data-src="excel">Excel</button>' +
            '</div>' +
            '<div class="sp-cond" id="sp-jc"' + (isExcel ? ' style="display:none"' : '') + '>' +
            '<input id="sp-surl" value="' + S.stagingUrl + '" placeholder="json url"></div>' +
            '<div class="sp-cond" id="sp-xc"' + (isExcel ? '' : ' style="display:none"') + '>' +
            '<input id="sp-xurl" value="' + S.excelUrl + '" placeholder="xlsx url"></div>' +
            '<div class="sp-status" id="sp-st">\u2139\uFE0F ' + stagingStatus + '</div></div>' +
            // Local upload
            '<div class="sp-row"><label>local upload (overrides remote)</label>' +
            '<div class="sp-upload" id="sp-drop">\uD83D\uDCC2 drag/click to upload (.json/.xlsx)' +
            '<input type="file" id="sp-file" accept=".json,.xlsx,.xls"></div>' +
            localInfoHTML +
            '<div class="sp-status" id="sp-ust"></div></div>' +
            // Staging refresh
            '<div class="sp-row"><label>staging refresh (min)</label>' +
            '<input type="number" id="sp-sr" value="' + stagingMin + '" min="1" max="1440"></div>' +
            // Theme
            '<div class="sp-row"><label>theme</label><div class="sp-themes">' + themeHTML + '</div></div>' +
            // Scale
            '<div class="sp-row"><label>scale</label>' +
            '<input type="range" id="sp-scale" min="0.6" max="1.5" step="0.02" value="' + S.scale + '">' +
            '<div class="sp-val" id="sp-sv">' + Math.round(S.scale * 100) + '%</div></div>' +
            // Alert settings
            '<div class="sp-row"><label>alert threshold (pkgs)</label>' +
            '<input type="number" id="sp-ap" value="' + S.alertPkg + '"></div>' +
            '<div class="sp-row"><label>alert minutes</label>' +
            '<input type="number" id="sp-am" value="' + S.alertMin + '"></div>' +
            // Refresh rates
            '<div class="sp-row"><label>refresh (sec)</label>' +
            '<input type="number" id="sp-rr" value="' + (S.refreshRate / 1000) + '"></div>' +
            '<div class="sp-row"><label>scrape interval (sec)</label>' +
            '<input type="number" id="sp-si" value="' + (S.scrapeRate / 1000) + '"></div>' +
            // Buttons
            '<button class="sp-save" id="sp-sv2">save & apply</button>' +
            '<button class="sp-save" id="sp-rf" style="margin-top:6px;background:#e65100">refresh staging</button>' +
            '<button class="sp-save" id="sp-dl" style="margin-top:6px;background:#1565c0">download json</button>' +
            '</div>';

        document.body.appendChild(panel);

        // --- EVENT HANDLERS ---

    // ═══════════════════════════════════════════════════════════════
    // SETTINGS PANEL EVENT HANDLERS (continued from Part 7)
    // ═══════════════════════════════════════════════════════════════

        // Local upload: drag & drop + click
        var dropZone = panel.querySelector('#sp-drop');
        var fileInput = panel.querySelector('#sp-file');
        var uploadStatus = panel.querySelector('#sp-ust');

        dropZone.onclick = function () { fileInput.click(); };
        fileInput.onchange = function () {
            if (this.files[0]) handleLocalUpload(this.files[0], uploadStatus);
        };
        dropZone.ondragover = function (e) { e.preventDefault(); };
        dropZone.ondrop = function (e) {
            e.preventDefault();
            if (e.dataTransfer.files[0]) handleLocalUpload(e.dataTransfer.files[0], uploadStatus);
        };

        // Clear local upload button
        var clearBtn = panel.querySelector('#sp-lc');
        if (clearBtn) {
            clearBtn.onclick = function () {
                clearLocal(uploadStatus);
                var li = panel.querySelector('.sp-li');
                if (li) li.remove();
            };
        }

        // Source toggle buttons (JSON / Excel)
        var toggleBtns = panel.querySelectorAll('.sp-tog');
        for (var i = 0; i < toggleBtns.length; i++) {
            toggleBtns[i].onclick = function () {
                for (var j = 0; j < toggleBtns.length; j++) toggleBtns[j].classList.remove('active');
                this.classList.add('active');
                var src = this.getAttribute('data-src');
                panel.querySelector('#sp-jc').style.display = src === 'json' ? '' : 'none';
                panel.querySelector('#sp-xc').style.display = src === 'excel' ? '' : 'none';
            };
        }

        // Theme swatch click
        var themeSwatches = panel.querySelectorAll('.sp-th');
        for (var i2 = 0; i2 < themeSwatches.length; i2++) {
            themeSwatches[i2].onclick = function () {
                for (var j = 0; j < themeSwatches.length; j++) themeSwatches[j].classList.remove('active');
                this.classList.add('active');
            };
        }

        // Scale slider
        var scaleSlider = panel.querySelector('#sp-scale');
        var scaleVal = panel.querySelector('#sp-sv');
        scaleSlider.oninput = function () {
            scaleVal.textContent = Math.round(this.value * 100) + '%';
        };

        // Close panel
        function closePanel() {
            panel.remove();
            overlay.remove();
        }
        panel.querySelector('#sp-close').onclick = closePanel;
        overlay.onclick = closePanel;

        // Refresh staging button
        panel.querySelector('#sp-rf').onclick = function () {
            GM_setValue('cpt_staging_cache', null);
            GM_setValue('cpt_staging_local', null);
            this.textContent = '...';
            var btn = this;
            var statusEl = panel.querySelector('#sp-st');
            loadStaging(function () {
                btn.textContent = '\u2713 done';
                statusEl.textContent = '\u2705 ' + stagingStatus;
                setTimeout(function () { btn.textContent = 'refresh staging'; }, 2000);
            });
        };

        // Download JSON button
        panel.querySelector('#sp-dl').onclick = function () { exportJSON(); };

        // Save & Apply button
        panel.querySelector('#sp-sv2').onclick = function () {
            var activeTheme = panel.querySelector('.sp-th.active');
            S.theme = activeTheme ? activeTheme.getAttribute('data-theme') : S.theme;
            S.scale = parseFloat(scaleSlider.value);
            S.alertPkg = parseInt(panel.querySelector('#sp-ap').value) || 130;
            S.alertMin = parseInt(panel.querySelector('#sp-am').value) || 20;
            S.refreshRate = (parseInt(panel.querySelector('#sp-rr').value) || 10) * 1000;
            S.scrapeRate = (parseInt(panel.querySelector('#sp-si').value) || 15) * 1000;
            S.siteCode = (panel.querySelector('#sp-site').value || 'KAFW').toUpperCase().trim();
            S.stagingSource = panel.querySelector('.sp-tog.active').getAttribute('data-src');
            S.stagingUrl = panel.querySelector('#sp-surl').value.trim() || DEFAULTS.stagingUrl;
            S.excelUrl = panel.querySelector('#sp-xurl').value.trim() || DEFAULTS.excelUrl;
            S.stagingRefresh = (parseInt(panel.querySelector('#sp-sr').value) || 5) * 60000;

            saveSettings(S);
            closePanel();

            // Re-apply theme
            T = THEMES[S.theme] || THEMES.pink;
            if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
            styleEl = GM_addStyle(makeWidgetCSS(false) + makeSettingsCSS());
            applyZoom();
            startStagingRefresh();
            GM_setValue('cpt_staging_cache', null);
            loadStaging();
        };
    }

    // Register Tampermonkey menu commands
    GM_registerMenuCommand('CPT Settings', openSettings);
    GM_registerMenuCommand('Show Widget', showWidget);
    GM_registerMenuCommand('Export JSON', exportJSON);
	
    // ═══════════════════════════════════════════════════════════════
    // TOOLBAR BUTTON (closed state)
    // ═══════════════════════════════════════════════════════════════

    function createToolbarBtn() {
        var btn = document.createElement('button');
        btn.id = 'cpt-tb';
        btn.textContent = '\u25A3';
        btn.title = 'Open CPT Widget';
        btn.onclick = showWidget;
        document.body.appendChild(btn);
    }

    function showWidget() {
        var w = document.getElementById('cpt-w');
        var tb = document.getElementById('cpt-tb');
        if (w) w.style.display = '';
        if (tb) tb.style.display = 'none';
        GM_setValue('cpt_widget_closed', false);
    }

    function closeWidget() {
        var w = document.getElementById('cpt-w');
        var tb = document.getElementById('cpt-tb');
        if (w) w.style.display = 'none';
        if (tb) tb.style.display = 'flex';
        GM_setValue('cpt_widget_closed', true);
    }

    // Sync close state across tabs
    GM_addValueChangeListener('cpt_widget_closed', function (name, oldVal, newVal, remote) {
        if (remote) {
            var w = document.getElementById('cpt-w');
            var tb = document.getElementById('cpt-tb');
            if (newVal) {
                if (w) w.style.display = 'none';
                if (tb) tb.style.display = 'flex';
            } else {
                if (w) w.style.display = '';
                if (tb) tb.style.display = 'none';
            }
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DRAG & SNAP
    // ═══════════════════════════════════════════════════════════════

    var dragState = { on: false, moved: false, sx: 0, sy: 0, sl: 0, st: 0, w: null };

    function initDrag(widget) {
        dragState.w = widget;
        widget.querySelector('#ch').addEventListener('mousedown', function (e) {
            if (e.target.closest('button')) return;
            dragState.on = true;
            dragState.moved = false;
            dragState.sx = e.clientX;
            dragState.sy = e.clientY;
            var rect = widget.getBoundingClientRect();
            dragState.sl = rect.left;
            dragState.st = rect.top;
            e.preventDefault();
        });
    }

    document.addEventListener('mousemove', function (e) {
        if (!dragState.on) return;
        var w = dragState.w;
        var dx = e.clientX - dragState.sx;
        var dy = e.clientY - dragState.sy;

        if (!dragState.moved) {
            if (dx * dx + dy * dy < 16) return; // Dead zone
            dragState.moved = true;
            w.classList.remove('snp');
            w.style.right = 'auto';
            w.style.bottom = 'auto';
            w.style.left = dragState.sl + 'px';
            w.style.top = dragState.st + 'px';
        }

        w.style.left = (dragState.sl + dx) + 'px';
        w.style.top = (dragState.st + dy) + 'px';
    });

    document.addEventListener('mouseup', function () {
        if (!dragState.on) return;
        dragState.on = false;
        if (dragState.moved) snapToCorner(dragState.w);
    });

    function snapToCorner(w) {
        var rect = w.getBoundingClientRect();
        var isRight = (rect.left + rect.width / 2) > innerWidth / 2;
        var isBottom = (rect.top + rect.height / 2) > innerHeight / 2;

        w.classList.add('snp');
        w.style.top = '';
        w.style.bottom = '';
        w.style.left = '';
        w.style.right = '';
        w.style[isBottom ? 'bottom' : 'top'] = '10px';
        w.style[isRight ? 'right' : 'left'] = '10px';
        w.style.transformOrigin = (isBottom ? 'bottom' : 'top') + ' ' + (isRight ? 'right' : 'left');

        GM_setValue('cpt_wc', (isBottom ? 'bottom' : 'top') + '-' + (isRight ? 'right' : 'left'));
        setTimeout(function () { w.classList.remove('snp'); }, 300);
    }

    function applyPosition(w) {
        var corner = GM_getValue('cpt_wc', 'bottom-right');
        w.style.top = '';
        w.style.bottom = '';
        w.style.left = '';
        w.style.right = '';
        w.style[corner.indexOf('bottom') !== -1 ? 'bottom' : 'top'] = '10px';
        w.style[corner.indexOf('right') !== -1 ? 'right' : 'left'] = '10px';
        w.style.transformOrigin = corner.replace('-', ' ');
    }

    // ═══════════════════════════════════════════════════════════════
    // MINIMIZE / EXPAND
    // ═══════════════════════════════════════════════════════════════

    function applyMinimize(minimized) {
        var w = document.getElementById('cpt-w');
        if (!w) return;
        if (minimized) {
            w.classList.add('min');
            var btn = w.querySelector('#bm');
            if (btn) btn.textContent = '\u25A2';
        } else {
            w.classList.remove('min');
            var btn2 = w.querySelector('#bm');
            if (btn2) btn2.textContent = '\u2014';
        }
    }

    function applyZoom() {
        var w = document.getElementById('cpt-w');
        if (w) {
            w.style.transform = 'scale(' + (S.scale / (Math.round(devicePixelRatio * 100) / 100)) + ')';
        }
    }

    // Sync minimize state across tabs
    GM_addValueChangeListener('cpt_widget_minimized', function (name, oldVal, newVal, remote) {
        if (remote) applyMinimize(newVal);
    });

    // Sync data updates across tabs
    GM_addValueChangeListener('cpt_widget_data', function (name, oldVal, newVal, remote) {
        if (remote && isVisible) updateWidget();
    });

    // Sync pop-out state
    GM_addValueChangeListener('cpt_widget_popped', function (name, oldVal, newVal, remote) {
        if (remote) {
            var w = document.getElementById('cpt-w');
            if (w) w.style.display = newVal ? 'none' : '';
        }
    });

    // Auto-open CPT View when it's detected
    GM_addValueChangeListener('cpt_view_open', function (name, oldVal, newVal) {
        if (newVal) GM_setValue('cpt_auto_opened', false);
    });


    // ═══════════════════════════════════════════════════════════════
    // AUTO-OPEN CPT VIEW
    // ═══════════════════════════════════════════════════════════════

    function isDataStale() {
        var raw = GM_getValue('cpt_widget_data', null);
        if (!raw) return true;
        try { return (Date.now() - JSON.parse(raw).ts) > 60000; }
        catch (e) { return true; }
    }

    function isCPTViewAlive() {
        return GM_getValue('cpt_view_open', false);
    }

    function autoOpenCPTView() {
        if (isCPTViewAlive() || !isDataStale() || GM_getValue('cpt_auto_opened', false)) return;

        var lastAttempt = GM_getValue('cpt_aol', 0);
        if (Date.now() - lastAttempt < 120000) return; // Don't retry within 2 min

        GM_setValue('cpt_aol', Date.now());
        GM_setValue('cpt_auto_opened', true);
        GM_openInTab(CPT_URL, { active: false, insert: true, setParent: true });
    }

    // ═══════════════════════════════════════════════════════════════
    // UPDATE LOOP
    // ═══════════════════════════════════════════════════════════════

    function startUpdateLoop() {
        if (updateTimer) return;
        updateTimer = setInterval(updateWidget, S.refreshRate);
        monitorTimer = setInterval(function () {
            if (!isCPTViewAlive() && isDataStale()) autoOpenCPTView();
        }, 30000);
    }

    function stopUpdateLoop() {
        if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
        if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    }

    // Pause updates when tab is hidden
    document.addEventListener('visibilitychange', function () {
        isVisible = !document.hidden;
        if (isVisible) { updateWidget(); startUpdateLoop(); }
        else stopUpdateLoop();
    });

    // ═══════════════════════════════════════════════════════════════
    // RENDER FUNCTION (updates widget DOM with latest data)
    // ═══════════════════════════════════════════════════════════════

    var buf = '';

    function render(doc) {
        var raw = GM_getValue('cpt_widget_data', null);
        if (!raw) return;

        var data;
        try { data = JSON.parse(raw); }
        catch (e) { return; }

        var staged = data.s;
        var loading = data.g;
        var all = data.a;
        var timestamp = data.ts;

        // Count late CPTs
        var lateCount = 0;
        var i = all.length;
        while (i--) { if (isLate(all[i].t)) lateCount++; }

        // Update summary counts
        var csEl = doc.getElementById('cs');
        if (!csEl) return;
        csEl.textContent = staged.length;
        doc.getElementById('cl').textContent = loading.length;
        doc.getElementById('cd').textContent = data.d.length;
        doc.getElementById('ct').textContent = lateCount;

        // Critical alerts
        var alerts = getAlerts(staged);
        var alertEl = doc.getElementById('wa');
        if (alertEl) {
            if (!alerts.length) {
                alertEl.innerHTML = '';
            } else {
                buf = '<div class="al"><div class="alt">\u26A0 critical \u2014 staged freight at risk</div>';
                for (i = 0; i < alerts.length; i++) {
                    buf += '<div class="ali"><span class="aln">' + alerts[i].l +
                        '</span><span class="ald">' + alerts[i].p + 'pkg \xB7 ' + alerts[i].t + '</span></div>';
                }
                buf += '</div>';
                alertEl.innerHTML = buf;
            }
        }

        // Adhoc suggestions
        showAdhocPanel(doc, alerts, staged);

        // Stale data warning
        var warnEl = doc.getElementById('ww');
        if (warnEl) {
            var ageMin = (Date.now() - timestamp) / 60000 | 0;
            warnEl.innerHTML = ageMin > 2 ? '<div class="wn">\u26A0\uFE0F data ' + ageMin + 'm old</div>' : '';
        }

        // Staged table
        var tsEl = doc.getElementById('ts');
        if (tsEl) {
            if (!staged.length) {
                tsEl.innerHTML = '<tr><td colspan="5" style="color:#888">none</td></tr>';
            } else {
                buf = '';
                for (i = 0; i < staged.length; i++) {
                    var s = staged[i];
                    buf += '<tr><td>' + s.l + '</td><td>' + s.p +
                        (s.cn > 0 ? ' (+' + s.cn + 'C)' : '') +
                        '</td><td class="sc">' + (s.cp || 0) +
                        '</td><td>' + s.c + '</td><td' +
                        (isUrgent(s.t) ? ' class="sr"' : '') + '>' + s.t + '</td></tr>';
                }
                tsEl.innerHTML = buf;
            }
        }

        // Loading table
        var tlEl = doc.getElementById('tl');
        if (tlEl) {
            if (!loading.length) {
                tlEl.innerHTML = '<tr><td colspan="5" style="color:#888">none</td></tr>';
            } else {
                buf = '';
                for (i = 0; i < loading.length; i++) {
                    var g = loading[i];
                    buf += '<tr><td>' + g.l + '</td><td>' + g.lp + '/' + g.tp +
                        '</td><td class="sc">' + (g.cp || 0) +
                        '</td><td>' + g.c + '</td><td' +
                        (isUrgent(g.t) ? ' class="sr"' : '') + '>' + g.t + '</td></tr>';
                }
                tlEl.innerHTML = buf;
            }
        }

        // All CPTs table
        var taEl = doc.getElementById('ta');
        if (taEl) {
            if (!all.length) {
                taEl.innerHTML = '<tr><td colspan="6" style="color:#888">no data</td></tr>';
            } else {
                all.sort(function (a, b) { return parseTimeMinutes(a.t) - parseTimeMinutes(b.t); });
                buf = '';
                for (i = 0; i < all.length; i++) {
                    var c = all[i];
                    buf += '<tr><td>' + c.l + '</td><td>' + c.tp + '</td><td>' + c.if +
                        '</td><td class="sc">' + (c.cp || 0) +
                        '</td><td>' + c.c + '</td><td' +
                        (isUrgent(c.t) ? ' class="sr"' : '') + '>' + c.t + '</td></tr>';
                }
                taEl.innerHTML = buf;
            }
        }

        // Status bar
        var statusEl = doc.getElementById('cst');
        if (statusEl) {
            statusEl.innerHTML = '<span class="pl"></span>' +
                new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        // Source info
        var srcEl = doc.getElementById('src');
        if (srcEl) {
            srcEl.textContent = 'source: cpt view \xB7 staging: ' + stagingStatus;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // UPDATE WIDGET (called on each refresh cycle)
    // ═══════════════════════════════════════════════════════════════

    function updateWidget() {
        var raw = GM_getValue('cpt_widget_data', null);

        if (!raw) {
            var st = document.getElementById('cst');
            if (st) st.innerHTML = '<span style="color:#f39c12">\u25CF waiting for CPT View...</span>';
            return;
        }

        // Render main widget
        render(document);

        // Update minimized view counts
        var data;
        try { data = JSON.parse(raw); }
        catch (e) { return; }

        var msEl = document.getElementById('ms');
        if (msEl) {
            var lateCount = 0;
            var i = data.a.length;
            while (i--) { if (isLate(data.a[i].t)) lateCount++; }
            msEl.textContent = data.s.length;
            document.getElementById('ml').textContent = data.g.length;
            document.getElementById('md').textContent = data.d.length;
            document.getElementById('mt').textContent = lateCount;
        }

        // Update minimized timestamp
        var muEl = document.getElementById('mu');
        if (muEl) {
            muEl.innerHTML = '<span class="pl"></span>' +
                new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        // Minimized alert badges
        var alerts = getAlerts(data.s);
        var maEl = document.getElementById('ma');
        if (maEl) {
            if (!alerts.length) {
                maEl.innerHTML = '';
            } else {
                buf = '<div class="mal">\u26A0 ';
                for (var j = 0; j < alerts.length; j++) {
                    if (j) buf += ' \xB7 ';
                    buf += alerts[j].l + '(' + alerts[j].p + 'p/' + alerts[j].t + ')';
                }
                buf += '</div>';
                maEl.innerHTML = buf;
            }
        }

        // Update pop-out window if open
        if (popWin && !popWin.closed) render(popWin.document);
    }


    // ═══════════════════════════════════════════════════════════════
    // POP-OUT WINDOW
    // ═══════════════════════════════════════════════════════════════

    function popOut() {
        if (popWin && !popWin.closed) popWin.close();
        if (popInterval) { clearInterval(popInterval); popInterval = null; }

        var pw = 480;
        var ph = 700;

        popWin = window.open(
            'about:blank',
            'CPT_Widget_Pop',
            'width=' + pw + ',height=' + ph +
            ',top=' + ((screen.height - ph) / 2 | 0) +
            ',left=' + ((screen.width - pw) / 2 | 0) +
            ',scrollbars=yes,menubar=no,toolbar=no,location=no,status=no'
        );

        if (!popWin) return alert('Pop-up blocked! Allow pop-ups for this site.');

        popWin.document.open();
        popWin.document.write(
            '<!DOCTYPE html><html><head><title>OB Dock</title><style>' +
            makeWidgetCSS(true) +
            '</style></head><body><div class="cw"><div class="ch">' +
            '<h3>outbound dock :3 - live</h3>' +
            '<div><span class="cs" id="cst">...</span>' +
            '<button class="bt" id="dk">\u29C9</button></div>' +
            '</div><div class="cb" id="cb">' + TABLE_HTML + '</div></div></body></html>'
        );
        popWin.document.close();

        // Dock button in pop-out
        popWin.document.getElementById('dk').onclick = dockWidget;

        // Update state
        GM_setValue('cpt_widget_popped', true);
        GM_setValue('cpt_widget_pop_heartbeat', Date.now());

        // Hide inline widget
        var inlineWidget = document.getElementById('cpt-w');
        var toolbarBtn = document.getElementById('cpt-tb');
        if (inlineWidget) inlineWidget.style.display = 'none';
        if (toolbarBtn) toolbarBtn.style.display = 'none';

        // Monitor pop-out window lifecycle
        var checkInterval = setInterval(function () {
            if (!popWin || popWin.closed) {
                clearInterval(checkInterval);
                if (popInterval) { clearInterval(popInterval); popInterval = null; }
                popWin = null;
                GM_setValue('cpt_widget_popped', false);
                GM_setValue('cpt_widget_pop_heartbeat', 0);

                // Restore inline widget
                var closed = GM_getValue('cpt_widget_closed', false);
                var w = document.getElementById('cpt-w');
                var tb = document.getElementById('cpt-tb');
                if (closed) {
                    if (w) w.style.display = 'none';
                    if (tb) tb.style.display = 'flex';
                } else {
                    if (w) w.style.display = '';
                    if (tb) tb.style.display = 'none';
                }
            } else {
                GM_setValue('cpt_widget_pop_heartbeat', Date.now());
            }
        }, 3000);

        // Initial render + start refresh loop for pop-out
        render(popWin.document);
        popInterval = setInterval(function () {
            if (popWin && !popWin.closed) render(popWin.document);
            else { clearInterval(popInterval); popInterval = null; }
        }, S.refreshRate);
    }

    /**
     * Dock: close pop-out and restore inline widget
     */
    function dockWidget() {
        if (popInterval) { clearInterval(popInterval); popInterval = null; }
        if (popWin && !popWin.closed) popWin.close();
        popWin = null;
        GM_setValue('cpt_widget_popped', false);
        GM_setValue('cpt_widget_pop_heartbeat', 0);

        var closed = GM_getValue('cpt_widget_closed', false);
        var w = document.getElementById('cpt-w');
        var tb = document.getElementById('cpt-tb');
        if (closed) {
            if (w) w.style.display = 'none';
            if (tb) tb.style.display = 'flex';
        } else {
            if (w) w.style.display = '';
            if (tb) tb.style.display = 'none';
        }
        updateWidget();
    }

    // ═══════════════════════════════════════════════════════════════
    // CREATE WIDGET
    // ═══════════════════════════════════════════════════════════════

    function createWidget() {
        createToolbarBtn();

        var widget = document.createElement('div');
        widget.id = 'cpt-w';
        widget.className = 'cw';
        widget.innerHTML = WIDGET_HTML;
        document.body.appendChild(widget);

        // Apply saved position, zoom, minimize state
        applyPosition(widget);
        applyZoom();
        applyMinimize(GM_getValue('cpt_widget_minimized', false));
        initDrag(widget);

        // Apply visibility based on closed/popped state
        var isClosed = GM_getValue('cpt_widget_closed', false);
        var isPopped = GM_getValue('cpt_widget_popped', false);

        if (isClosed) {
            widget.style.display = 'none';
            document.getElementById('cpt-tb').style.display = 'flex';
        } else if (isPopped) {
            widget.style.display = 'none';
            document.getElementById('cpt-tb').style.display = 'none';
        } else {
            document.getElementById('cpt-tb').style.display = 'none';
        }

        // --- Button event handlers ---

        // Minimize button
        widget.querySelector('#bm').onclick = function (e) {
            e.stopPropagation();
            var min = !widget.classList.contains('min');
            applyMinimize(min);
            GM_setValue('cpt_widget_minimized', min);
        };

        // Header click to toggle minimize (if not dragging)
        widget.querySelector('#ch').onclick = function (e) {
            if (e.target.closest('button') || dragState.moved) return;
            var min = !widget.classList.contains('min');
            applyMinimize(min);
            GM_setValue('cpt_widget_minimized', min);
        };

        // Pop-out button
        widget.querySelector('#bp').onclick = function (e) {
            e.stopPropagation();
            popOut();
        };

        // Close button
        widget.querySelector('#bx').onclick = function (e) {
            e.stopPropagation();
            closeWidget();
        };

        // Settings button
        widget.querySelector('#bset').onclick = function (e) {
            e.stopPropagation();
            openSettings();
        };

        // Re-apply zoom on window resize
        window.addEventListener('resize', applyZoom);
    }

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════

    function init() {
        loadStaging(function () {
            createWidget();
            updateWidget();
            autoOpenCPTView();
            startUpdateLoop();
            startStagingRefresh();
        });
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();



