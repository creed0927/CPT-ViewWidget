
// ==UserScript==
// @name         CPT View Live Widget - OB Dock
// @namespace    http://tampermonkey.net/
// @version      4.6
// @description  Memory-optimized CPT widget — minimal allocations, reused buffers, efficient DOM ops
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/refs/heads/main/CPT_ViewWidget.js
// @downloadURL  https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/refs/heads/main/CPT_ViewWidget.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @connect      trans-logistics.amazon.com
// @connect      *.amazon.com
// ==/UserScript==

(function() {
    'use strict';

    if (window.name === 'CPT_Widget_Pop') return;

    // ============================================
    // CONFIG — frozen to prevent accidental mutation
    // ============================================
    const CFG = Object.freeze({
        url: 'https://trans-logistics.amazon.com/ssp/dock/hrz/cpt',
        refresh: 10000,
        scrape: 15000,
        scale: 1.04,
        alertStagedThreshold: 130,
        alertMinutesThreshold: 20,
        pageWait: 800,
        fetchTimeout: 15000,
        dataRefresh: 60000,
        snapMargin: 10
    });

    // ============================================
    // REUSABLE REGEX — compiled once, reused forever
    // ============================================
    const RE_HR = /(\d+)\s*hr/;
    const RE_MIN = /(\d+)\s*min/;
    const RE_NUM = /(\d+)/;

    // ============================================
    // SHARED UTILITY — minimal allocation
    // ============================================
    function tlMin(t) {
        if (!t) return 99999;
        const hm = RE_HR.exec(t);
        const mm = RE_MIN.exec(t);
        return ((hm ? +hm[1] : 0) * 60) + (mm ? +mm[1] : 0);
    }

    function isLate(t) {
        if (!t) return false;
        const c = t.charCodeAt(0);
        // fast check for '-' (45), 'l' (108), 'p' (112)
        if (c === 45) return true;
        const s = t.toLowerCase();
        return s.indexOf('late') !== -1 || s.indexOf('past') !== -1 || tlMin(t) <= 0;
    }

    function isUrg(t) { return tlMin(t) <= 120; }

    function extractCount(cell) {
        if (!cell) return 0;
        const a = cell.firstElementChild;
        if (a && a.tagName === 'A') {
            const n = +a.textContent;
            return n === n ? n : 0; // NaN check without isNaN
        }
        const m = RE_NUM.exec(cell.textContent);
        return m ? +m[1] : 0;
    }

    function extractNum(cell) {
        if (!cell) return 0;
        const a = cell.firstElementChild;
        if (a && a.tagName === 'A') return +a.textContent || 0;
        return +cell.textContent || 0;
    }

    // ============================================
    // PARSER — single pass, reuses object shape
    // ============================================
    function parseRows(rows) {
        const staged = [], loading = [], loaded = [], allCpts = [];
        const len = rows.length;

        for (let i = 0; i < len; i++) {
            const cells = rows[i].cells;
            if (!cells || cells.length < 22) continue;

            const c2 = cells[2];
            const lnSpan = c2.getElementsByTagName('span')[0];
            const ln = lnSpan ? lnSpan.textContent : c2.textContent;
            const arrow = ln.indexOf('->');
            const arrow2 = ln.indexOf('\u2192');
            const dest = arrow !== -1 ? ln.substring(arrow + 2).trim()
                       : arrow2 !== -1 ? ln.substring(arrow2 + 1).trim()
                       : ln.trim();

            const tl = cells[1].textContent.trim();
            const cpt = cells[0].textContent.trim();
            const lip = extractNum(cells[4]);
            const tot = extractCount(cells[8]);
            const inf = extractCount(cells[12]);
            const conP = extractCount(cells[16]);
            const conC = extractCount(cells[17]);
            const stP = extractCount(cells[18]);
            const stC = extractCount(cells[19]);
            const ldP = extractCount(cells[20]);
            const ldC = extractCount(cells[21]);

            allCpts[allCpts.length] = { lane: dest, cpt: cpt, timeLeft: tl, totalPkgs: tot, inFacilityPkgs: inf, containerizedPkgs: conP, stagedPkgs: stP, loadedPkgs: ldP, loadsInProgress: lip };

            if (stP > 0 || stC > 0) staged[staged.length] = { lane: dest, pkgs: stP, containers: stC, containerizedPkgs: conP, cpt: cpt, timeLeft: tl };
            if (lip > 0) loading[loading.length] = { lane: dest, loadedPkgs: ldP, totalPkgs: tot, containerizedPkgs: conP, cpt: cpt, timeLeft: tl };
            if (ldP > 0 || ldC > 0) loaded[loaded.length] = { lane: dest, pkgs: ldP, containers: ldC, cpt: cpt, timeLeft: tl };
        }

        return { staged: staged, loading: loading, loaded: loaded, allCpts: allCpts, timestamp: Date.now() };
    }

    // ============================================
    // DETECT MODE
    // ============================================
    const IS_CPT_VIEW = window.location.href.indexOf('trans-logistics.amazon.com/ssp/dock') !== -1;

    // ============================================
    // MODE 1: SCRAPER on CPT View
    // ============================================
    if (IS_CPT_VIEW) {
        GM_setValue('cpt_view_open', true);
        window.addEventListener('beforeunload', function() { GM_setValue('cpt_view_open', false); });

        GM_addStyle('#cpt-scraper-badge{position:fixed;bottom:10px;right:10px;background:#D39ADB;color:#fff;padding:8px 14px;border-radius:20px;font:11px "Segoe UI",Arial,sans-serif;z-index:999999;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;gap:8px}#cpt-scraper-badge .dot{width:8px;height:8px;border-radius:50%;background:#27ae60;animation:sp 2s infinite}@keyframes sp{0%,100%{opacity:1}50%{opacity:.4}}.st2{font-size:9px;opacity:.8}.sc2{font-size:9px;opacity:.7}');

        const badge = document.createElement('div');
        badge.id = 'cpt-scraper-badge';
        badge.innerHTML = '<span class="dot"></span><span>widget syncing</span><span class="st2" id="scrape-time"></span><span class="sc2" id="scrape-count"></span>';
        document.body.appendChild(badge);

        function refreshTableData() {
            if (window.jQuery) {
                try {
                    const dt = window.jQuery('#cptsLoadInProgress').DataTable();
                    if (dt.ajax && dt.ajax.url()) { dt.ajax.reload(null, false); return; }
                } catch(e) {}
            }
            const btn = document.querySelector('button.refresh,button[title="Refresh"],.refreshBtn,input[type="submit"][value="Search"],button.search-btn,#searchButton,.btn-refresh,[data-action="refresh"]');
            if (btn) { btn.click(); return; }
            if (window.jQuery) { try { window.jQuery('#cptsLoadInProgress').DataTable().draw(false); return; } catch(e) {} }
            window.location.reload();
        }

        function scrapeTable() {
            const tbl = document.getElementById('cptsLoadInProgress');
            if (!tbl) return;
            const rows = tbl.tBodies[0] ? tbl.tBodies[0].rows : null;
            if (!rows || !rows.length) return;
            if (rows.length === 1 && rows[0].textContent.indexOf('oading') !== -1) return;
            if (window.jQuery) {
                try {
                    const dt = window.jQuery('#cptsLoadInProgress').DataTable();
                    const info = dt.page.info();
                    if (info.pages > 1) { scrapeAllPages(dt); return; }
                } catch(e) {}
            }
            finishScrape(rows);
        }

        function scrapeAllPages(dt) {
            const info = dt.page.info();
            const total = info.pages, orig = info.page;
            const collected = [];
            (function next(p) {
                dt.page(p).draw(false);
                setTimeout(function() {
                    const rows = document.querySelectorAll('#cptsLoadInProgress tbody tr');
                    for (let i = 0, l = rows.length; i < l; i++) {
                        if (rows[i].cells && rows[i].cells.length >= 22) collected[collected.length] = rows[i].cloneNode(true);
                    }
                    if (p + 1 < total) next(p + 1);
                    else { dt.page(orig).draw(false); finishScrape(collected); }
                }, CFG.pageWait);
            })(0);
        }

        function finishScrape(rows) {
            const data = parseRows(rows);
            GM_setValue('cpt_widget_data', JSON.stringify(data));
            const te = document.getElementById('scrape-time');
            const ce = document.getElementById('scrape-count');
            if (te) { const d = new Date(); te.textContent = '\xB7 ' + d.toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
            if (ce) ce.textContent = '\xB7 ' + data.allCpts.length + ' cpts';
        }

        function waitForData() {
            const tbl = document.getElementById('cptsLoadInProgress');
            if (!tbl) { setTimeout(waitForData, 2000); return; }
            const rows = tbl.tBodies[0] ? tbl.tBodies[0].rows : null;
            if (!rows || !rows.length || (rows.length === 1 && rows[0].textContent.indexOf('oading') !== -1)) {
                setTimeout(waitForData, 2000); return;
            }
            scrapeTable();
            setInterval(scrapeTable, CFG.scrape);
            setInterval(function() { refreshTableData(); setTimeout(scrapeTable, 5000); }, CFG.dataRefresh);
        }

        setTimeout(waitForData, 3000);
        return;
    }

    // ============================================
    // MODE 2: WIDGET
    // ============================================
    let popWin = null, popInterval = null;
    let fetchMode = 'fetch', failCount = 0;

    // Reusable string buffer for HTML building — avoids repeated concatenation GC
    let _buf = '';

    function isPoppedOut() { return GM_getValue('cpt_widget_popped', false); }
    function setPoppedOut(v) { GM_setValue('cpt_widget_popped', v); }

    // ============================================
    // STYLES — single injection, minified
    // ============================================
    const STYLES = '#cpt-w{position:fixed;width:420px;max-height:500px;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:999999;overflow:hidden;transform:scale(' + CFG.scale + ');transform-origin:bottom right}#cpt-w.min .cw-bd{display:none}#cpt-w.min .cw-mv{display:block}.cw-mv{display:none}.cw{font:13px "Segoe UI",Arial,sans-serif;color:#000;background:#FFADDB}.cw-hd{background:#D39ADB;padding:10px 15px;display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none}.cw-hd h3{margin:0;font-size:14px;color:#FFF}.cw-st{font-size:11px;color:#FFF}.cw-bd{padding:10px 15px;overflow-y:auto}.cw-sec{margin-bottom:12px}.cw-sec-t{font-size:12px;font-weight:bold;text-transform:lowercase;margin-bottom:6px;border-bottom:1px solid #FFF;padding-bottom:4px}.cw table{width:100%;border-collapse:collapse;font-size:12px}.cw th{text-align:left;padding:4px 6px;background:#C99DC7;color:#FFF;font-weight:normal;font-size:11px}.cw td{padding:4px 6px;border-bottom:1px solid #D9D9FF}.cw tr:hover{background:#D9D9FF}.cw-sum{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}.cw-si{background:#FFF;padding:6px 12px;border-radius:6px;text-align:center}.cw-si .n{font-size:18px;font-weight:bold;display:block}.cw-si .l{font-size:10px;color:#888;text-transform:lowercase}.cw-btn{background:none;border:none;color:#FFF;font-size:16px;cursor:pointer;padding:0 5px}.cw-btn:hover{color:#000}.s-stg{color:#f39c12;font-weight:bold}.s-ldg{color:#3498db;font-weight:bold}.s-ldd{color:#27ae60;font-weight:bold}.s-lat{color:#e74c3c;font-weight:bold}.s-con{color:#9b59b6;font-weight:bold}.cw-pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:#27ae60;margin-right:6px;animation:cwp 2s infinite}@keyframes cwp{0%,100%{opacity:1}50%{opacity:.4}}.cw-warn{background:#fff3cd;color:#856404;padding:4px 8px;border-radius:4px;font-size:11px;margin-bottom:8px;text-align:center}.cw-mini{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:8px 15px;font-size:12px}.cw-mi{display:flex;align-items:center;gap:4px}.cw-mi .mn{font-weight:bold;font-size:14px}.cw-mi .ml{font-size:11px;color:#555;text-transform:lowercase}.cw-mu{font-size:10px;color:#555;margin-top:4px}.cw-src{font-size:9px;color:#888;text-align:center;margin-top:6px}.cw-alert{background:#e74c3c;color:#FFF;padding:6px 10px;border-radius:6px;margin-bottom:8px;font-size:11px;animation:cwf 1s infinite}.cw-alert-item{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.2)}.cw-alert-item:last-child{border-bottom:none}.cw-alert-title{font-weight:bold;font-size:12px;margin-bottom:4px}.cw-alert-lane{font-weight:bold}.cw-alert-detail{font-size:10px;opacity:.9}@keyframes cwf{0%,100%{opacity:1}50%{opacity:.85}}.cw-mini-alert{background:#e74c3c;color:#FFF;padding:4px 8px;border-radius:4px;font-size:10px;margin-top:4px;animation:cwf 1s infinite}.cw-snapping{transition:top .25s,left .25s,right .25s,bottom .25s}';

    GM_addStyle(STYLES);

    // ============================================
    // HTML — built once as template strings
    // ============================================
    const TABLES_HTML = '<div id="cw-alert"></div><div id="cw-warn"></div><div class="cw-sum"><div class="cw-si"><span class="n" id="cs">-</span><span class="l">staged</span></div><div class="cw-si"><span class="n" id="cl">-</span><span class="l">loading</span></div><div class="cw-si"><span class="n" id="cd">-</span><span class="l">loaded</span></div><div class="cw-si"><span class="n s-lat" id="ct">-</span><span class="l">late</span></div></div><div class="cw-sec"><div class="cw-sec-t">currently staged on floor</div><table><thead><tr><th>lane</th><th>pkgs</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tb-s"><tr><td colspan="5">fetching data...</td></tr></tbody></table></div><div class="cw-sec"><div class="cw-sec-t">loading into trucks</div><table><thead><tr><th>lane</th><th>loaded</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tb-l"><tr><td colspan="5">fetching data...</td></tr></tbody></table></div><div class="cw-sec"><div class="cw-sec-t">all active cpts</div><table><thead><tr><th>lane</th><th>total</th><th>in fac</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tb-a"><tr><td colspan="6">fetching data...</td></tr></tbody></table></div><div class="cw-src" id="cw-src"></div>';

    const INLINE_HTML = '<div class="cw-hd" id="cw-hd"><h3>outbound dock :3 - live</h3><div><span class="cw-st" id="cw-st">starting up...</span><button class="cw-btn" id="cw-pop" title="pop out">\u29C9</button><button class="cw-btn" id="cw-min">\u2014</button></div></div><div class="cw-mv" id="cw-mv"><div class="cw-mini"><div class="cw-mi"><span class="mn s-stg" id="ms">-</span><span class="ml">staged</span></div><div class="cw-mi"><span class="mn s-ldg" id="ml">-</span><span class="ml">loading</span></div><div class="cw-mi"><span class="mn s-ldd" id="md">-</span><span class="ml">loaded</span></div><div class="cw-mi"><span class="mn s-lat" id="mt">-</span><span class="ml">late</span></div></div><div class="cw-mu" id="mu">\u2014</div><div id="cw-mini-alert"></div></div><div class="cw-bd" id="cw-bd">' + TABLES_HTML + '</div>';

    // ============================================
    // DRAG + SNAP — optimized with cached refs
    // ============================================
    function initDrag(w) {
        const hd = w.querySelector('#cw-hd');
        let drag = false, moved = false, sx, sy, sl, st;

        hd.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            drag = true; moved = false;
            sx = e.clientX; sy = e.clientY;
            const r = w.getBoundingClientRect();
            sl = r.left; st = r.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', function(e) {
            if (!drag) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved) {
                if (dx * dx + dy * dy < 16) return;
                moved = true;
                w.classList.remove('cw-snapping');
                w.style.right = 'auto'; w.style.bottom = 'auto';
                w.style.left = sl + 'px'; w.style.top = st + 'px';
            }
            w.style.left = (sl + dx) + 'px';
            w.style.top = (st + dy) + 'px';
        });

        document.addEventListener('mouseup', function() {
            if (!drag) return;
            drag = false;
            if (moved) snap(w);
        });
    }

    function snap(w) {
        const r = w.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight, m = CFG.snapMargin;
        const isR = (r.left + r.width / 2) > vw / 2;
        const isB = (r.top + r.height / 2) > vh / 2;

        w.classList.add('cw-snapping');
        w.style.top = ''; w.style.bottom = ''; w.style.left = ''; w.style.right = '';

        if (isB) { w.style.bottom = m + 'px'; } else { w.style.top = m + 'px'; }
        if (isR) { w.style.right = m + 'px'; } else { w.style.left = m + 'px'; }
        w.style.transformOrigin = (isB ? 'bottom' : 'top') + ' ' + (isR ? 'right' : 'left');

        GM_setValue('cpt_widget_corner', (isB ? 'bottom' : 'top') + '-' + (isR ? 'right' : 'left'));
        setTimeout(function() { w.classList.remove('cw-snapping'); }, 300);
    }

    function applyPos(w) {
        const c = GM_getValue('cpt_widget_corner', 'bottom-right');
        const m = CFG.snapMargin;
        w.style.top = ''; w.style.bottom = ''; w.style.left = ''; w.style.right = '';
        if (c.indexOf('bottom') !== -1) w.style.bottom = m + 'px'; else w.style.top = m + 'px';
        if (c.indexOf('right') !== -1) w.style.right = m + 'px'; else w.style.left = m + 'px';
        w.style.transformOrigin = c.replace('-', ' ');
    }

    // ============================================
    // MINIMIZE SYNC
    // ============================================
    function applyMin(isMin) {
        const w = document.getElementById('cpt-w');
        if (!w) return;
        if (isMin) { w.classList.add('min'); var b = w.querySelector('#cw-min'); if (b) b.textContent = '\u25A2'; }
        else { w.classList.remove('min'); var b2 = w.querySelector('#cw-min'); if (b2) b2.textContent = '\u2014'; }
    }

    GM_addValueChangeListener('cpt_widget_minimized', function(n, o, v, r) { if (r) applyMin(v); });
    GM_addValueChangeListener('cpt_widget_data', function(n, o, v, r) { if (r) update(); });
    GM_addValueChangeListener('cpt_widget_popped', function(n, o, v, r) {
        if (r) { var w = document.getElementById('cpt-w'); if (w) w.style.display = v ? 'none' : ''; }
    });
    GM_addValueChangeListener('cpt_view_open', function(n, o, v) {
        if (v) { clearWarn(); fetchMode = 'fetch'; failCount = 0; }
    });

    function clearWarn() {
        var e = document.getElementById('cw-warn');
        if (e) e.innerHTML = '';
        if (popWin && !popWin.closed) { var p = popWin.document.getElementById('cw-warn'); if (p) p.innerHTML = ''; }
    }

    // ============================================
    // CREATE WIDGET
    // ============================================
    function createWidget() {
        const w = document.createElement('div');
        w.id = 'cpt-w';
        w.className = 'cw';
        w.innerHTML = INLINE_HTML;
        document.body.appendChild(w);

        applyPos(w);
        applyZoom();
        applyMin(GM_getValue('cpt_widget_minimized', false));
        initDrag(w);

        if (isPoppedOut()) w.style.display = 'none';

        w.querySelector('#cw-min').onclick = function(e) {
            e.stopPropagation();
            var isMin = !w.classList.contains('min');
            applyMin(isMin);
            GM_setValue('cpt_widget_minimized', isMin);
        };

        w.querySelector('#cw-hd').addEventListener('click', function(e) {
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            var isMin = !w.classList.contains('min');
            applyMin(isMin);
            GM_setValue('cpt_widget_minimized', isMin);
        });

        w.querySelector('#cw-pop').onclick = function(e) { e.stopPropagation(); popOut(); };

        window.addEventListener('resize', applyZoom);
    }

    function applyZoom() {
        var w = document.getElementById('cpt-w');
        if (w) w.style.transform = 'scale(' + (CFG.scale / (Math.round(window.devicePixelRatio * 100) / 100)) + ')';
    }

    // ============================================
    // POP-OUT
    // ============================================
    function popOut() {
        if (popWin && !popWin.closed) popWin.close();
        if (popInterval) { clearInterval(popInterval); popInterval = null; }

        const pw = 470, ph = 650;
        popWin = window.open('about:blank', 'CPT_Widget_Pop',
            'width=' + pw + ',height=' + ph + ',top=' + ((screen.height - ph) / 2 | 0) + ',left=' + ((screen.width - pw) / 2 | 0) + ',scrollbars=yes,menubar=no,toolbar=no,location=no,status=no');
        if (!popWin) { alert('Pop-up blocked! Allow pop-ups for this site.'); return; }

        popWin.document.open();
        popWin.document.write('<!DOCTYPE html><html><head><title>outbound dock :3</title><style>*{box-sizing:border-box;margin:0;padding:0}html,body{background:#FFADDB;overflow-y:auto;overflow-x:hidden}' + STYLES + '.cw{border-radius:0}.cw-hd{cursor:default;position:sticky;top:0;z-index:10}.cw-bd{max-height:none;overflow:visible}.cw-si{flex:1;min-width:60px}</style></head><body><div class="cw"><div class="cw-hd"><h3>outbound dock :3 - live</h3><div><span class="cw-st" id="cw-st">starting up...</span><button class="cw-btn" id="cw-dock" title="dock back">\u29C9</button></div></div><div class="cw-bd" id="cw-bd">' + TABLES_HTML + '</div></div></body></html>');
        popWin.document.close();

        popWin.document.getElementById('cw-dock').onclick = dock;
        setPoppedOut(true);
        var iw = document.getElementById('cpt-w'); if (iw) iw.style.display = 'none';

        var chk = setInterval(function() {
            if (!popWin || popWin.closed) {
                clearInterval(chk);
                if (popInterval) { clearInterval(popInterval); popInterval = null; }
                popWin = null;
                setPoppedOut(false);
                var w2 = document.getElementById('cpt-w'); if (w2) w2.style.display = '';
            }
        }, 500);

        renderTo(popWin.document);
        popInterval = setInterval(function() {
            if (popWin && !popWin.closed) renderTo(popWin.document);
            else { clearInterval(popInterval); popInterval = null; }
        }, CFG.refresh);
    }

    function dock() {
        if (popInterval) { clearInterval(popInterval); popInterval = null; }
        if (popWin && !popWin.closed) popWin.close();
        popWin = null;
        setPoppedOut(false);
        var w = document.getElementById('cpt-w'); if (w) w.style.display = '';
        update();
    }

    // ============================================
    // FETCH
    // ============================================
    function fetchData() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: CFG.url,
            timeout: CFG.fetchTimeout,
            headers: { 'Accept': 'text/html', 'Cache-Control': 'no-cache' },
            onload: function(r) {
                if (r.status === 200) {
                    var d = parseHTML(r.responseText);
                    if (d && d.allCpts.length) {
                        fetchMode = 'fetch'; failCount = 0; clearWarn();
                        GM_setValue('cpt_widget_data', JSON.stringify(d));
                    } else { onFail(); }
                } else if (r.status === 401 || r.status === 403) { onFail(true); }
                else { onFail(); }
            },
            onerror: onFail,
            ontimeout: onFail
        });
    }

    function parseHTML(html) {
        try {
            // Use a document fragment approach — parse only the table
            var i = html.indexOf('id="cptsLoadInProgress"');
            if (i === -1) return null;
            var start = html.lastIndexOf('<table', i);
            var end = html.indexOf('</table>', i);
            if (start === -1 || end === -1) return null;
            var chunk = html.substring(start, end + 8);

            var tmp = document.createElement('div');
            tmp.innerHTML = chunk;
            var tbl = tmp.querySelector('table');
            if (!tbl) return null;
            var rows = tbl.tBodies[0] ? tbl.tBodies[0].rows : null;
            if (!rows || !rows.length) return null;
            if (rows.length === 1 && rows[0].cells && rows[0].cells.length < 22) return null;
            var result = parseRows(rows);
            tmp.innerHTML = ''; // free DOM
            tmp = null;
            return result;
        } catch(e) { return null; }
    }

    function onFail(auth) {
        failCount++;
        if (failCount >= 3 && !GM_getValue('cpt_view_open', false)) {
            fetchMode = 'tab';
            var msg = auth
                ? '\u26A0\uFE0F session expired \u2014 <a href="' + CFG.url + '" target="_blank" style="color:#856404;font-weight:bold">open CPT View</a> to re-authenticate'
                : '\u26A0\uFE0F direct fetch unavailable \u2014 <a href="' + CFG.url + '" target="_blank" style="color:#856404;font-weight:bold">open CPT View</a> in any tab to auto-sync';
            var w = document.getElementById('cw-warn');
            if (w) w.innerHTML = '<div class="cw-warn">' + msg + '</div>';
            if (popWin && !popWin.closed) { var p = popWin.document.getElementById('cw-warn'); if (p) p.innerHTML = '<div class="cw-warn">' + msg + '</div>'; }
        }
    }

    // ============================================
    // ALERTS
    // ============================================
    function getAlerts(staged) {
        var alerts = [], i = staged.length;
        while (i--) {
            var s = staged[i], m = tlMin(s.timeLeft);
            if (s.pkgs >= CFG.alertStagedThreshold && m <= CFG.alertMinutesThreshold)
                alerts[alerts.length] = { lane: s.lane, pkgs: s.pkgs, timeLeft: s.timeLeft, min: m };
        }
        if (alerts.length > 1) alerts.sort(function(a, b) { return a.min - b.min; });
        return alerts;
    }

    // ============================================
    // RENDER — uses string buffer, single innerHTML set per element
    // ============================================
    function renderTo(d) {
        var raw = GM_getValue('cpt_widget_data', null);
        if (!raw) return;
        var data;
        try { data = JSON.parse(raw); } catch(e) { return; }

        var staged = data.staged, loading = data.loading, loaded = data.loaded, allCpts = data.allCpts, ts = data.timestamp;
        var late = 0, i = allCpts.length;
        while (i--) { if (isLate(allCpts[i].timeLeft)) late++; }

        var cs = d.getElementById('cs');
        if (!cs) return;
        cs.textContent = staged.length;
        d.getElementById('cl').textContent = loading.length;
        d.getElementById('cd').textContent = loaded.length;
        d.getElementById('ct').textContent = late;

        // Alerts
        var alerts = getAlerts(staged);
        var alertEl = d.getElementById('cw-alert');
        if (alertEl) {
            if (!alerts.length) { if (alertEl.innerHTML) alertEl.innerHTML = ''; }
            else {
                _buf = '<div class="cw-alert"><div class="cw-alert-title">\u26A0 critical \u2014 staged freight at risk</div>';
                for (i = 0; i < alerts.length; i++) {
                    var a = alerts[i];
                    _buf += '<div class="cw-alert-item"><span class="cw-alert-lane">' + a.lane + '</span><span class="cw-alert-detail">' + a.pkgs + ' pkgs staged \xB7 ' + a.timeLeft + ' left</span></div>';
                }
                _buf += '</div>';
                alertEl.innerHTML = _buf;
            }
        }

        // Data age warning
        var warn = d.getElementById('cw-warn');
        if (warn && fetchMode === 'fetch') {
            var age = (Date.now() - ts) / 60000 | 0;
            if (age > 2) { warn.innerHTML = '<div class="cw-warn">\u26A0\uFE0F data is ' + age + ' min old</div>'; }
            else if (warn.innerHTML) { warn.innerHTML = ''; }
        }

        var now = new Date();
        var timeStr = now.toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit',second:'2-digit'});

        // Staged table
        var tbS = d.getElementById('tb-s');
        if (tbS) {
            if (!staged.length) { tbS.innerHTML = '<tr><td colspan="5" style="color:#888">no freight staged</td></tr>'; }
            else {
                _buf = '';
                for (i = 0; i < staged.length; i++) {
                    var s = staged[i];
                    _buf += '<tr><td>' + s.lane + '</td><td>' + s.pkgs + (s.containers > 0 ? ' (+' + s.containers + 'C)' : '') + '</td><td class="s-con">' + (s.containerizedPkgs || 0) + '</td><td>' + s.cpt + '</td><td' + (isUrg(s.timeLeft) ? ' class="s-lat"' : '') + '>' + s.timeLeft + '</td></tr>';
                }
                tbS.innerHTML = _buf;
            }
        }

        // Loading table
        var tbL = d.getElementById('tb-l');
        if (tbL) {
            if (!loading.length) { tbL.innerHTML = '<tr><td colspan="5" style="color:#888">no active loads</td></tr>'; }
            else {
                _buf = '';
                for (i = 0; i < loading.length; i++) {
                    var l = loading[i];
                    _buf += '<tr><td>' + l.lane + '</td><td>' + l.loadedPkgs + ' / ' + l.totalPkgs + '</td><td class="s-con">' + (l.containerizedPkgs || 0) + '</td><td>' + l.cpt + '</td><td' + (isUrg(l.timeLeft) ? ' class="s-lat"' : '') + '>' + l.timeLeft + '</td></tr>';
                }
                tbL.innerHTML = _buf;
            }
        }

        // All CPTs table
        var tbA = d.getElementById('tb-a');
        if (tbA) {
            if (!allCpts.length) { tbA.innerHTML = '<tr><td colspan="6" style="color:#888">no data</td></tr>'; }
            else {
                allCpts.sort(function(a, b) { return tlMin(a.timeLeft) - tlMin(b.timeLeft); });
                _buf = '';
                for (i = 0; i < allCpts.length; i++) {
                    var c = allCpts[i];
                    _buf += '<tr><td>' + c.lane + '</td><td>' + c.totalPkgs + '</td><td>' + c.inFacilityPkgs + '</td><td class="s-con">' + (c.containerizedPkgs || 0) + '</td><td>' + c.cpt + '</td><td' + (isUrg(c.timeLeft) ? ' class="s-lat"' : '') + '>' + c.timeLeft + '</td></tr>';
                }
                tbA.innerHTML = _buf;
            }
        }

        var st = d.getElementById('cw-st');
        if (st) st.innerHTML = '<span class="cw-pulse"></span>' + timeStr;

        var src = d.getElementById('cw-src');
        if (src) src.textContent = fetchMode === 'fetch' ? 'source: direct fetch' : 'source: cpt view tab';
    }

    // ============================================
    // UPDATE
    // ============================================
    function update() {
        var raw = GM_getValue('cpt_widget_data', null);
        if (!raw) {
            var st = document.getElementById('cw-st');
            if (st) st.innerHTML = '<span style="color:#f39c12">\u25CF fetching...</span>';
            return;
        }

        var data;
        try { data = JSON.parse(raw); } catch(e) { return; }

        renderTo(document);

        // Mini summary
        var ms = document.getElementById('ms');
        if (ms) {
            var late = 0, i = data.allCpts.length;
            while (i--) { if (isLate(data.allCpts[i].timeLeft)) late++; }
            ms.textContent = data.staged.length;
            document.getElementById('ml').textContent = data.loading.length;
            document.getElementById('md').textContent = data.loaded.length;
            document.getElementById('mt').textContent = late;
        }

        var now = new Date();
        var mu = document.getElementById('mu');
        if (mu) mu.innerHTML = '<span class="cw-pulse"></span>updated ' + now.toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit',second:'2-digit'});

        // Mini alerts
        var alerts = getAlerts(data.staged);
        var miniAlert = document.getElementById('cw-mini-alert');
        if (miniAlert) {
            if (!alerts.length) { if (miniAlert.innerHTML) miniAlert.innerHTML = ''; }
            else {
                _buf = '<div class="cw-mini-alert">\u26A0 ';
                for (var j = 0; j < alerts.length; j++) {
                    if (j) _buf += ' \xB7 ';
                    _buf += alerts[j].lane + ' (' + alerts[j].pkgs + 'pkg/' + alerts[j].timeLeft + ')';
                }
                _buf += '</div>';
                miniAlert.innerHTML = _buf;
            }
        }

        if (popWin && !popWin.closed) renderTo(popWin.document);
    }

    // ============================================
    // INIT — single event, delayed start
    // ============================================
    function init() {
        createWidget();
        update();
        fetchData();
        setInterval(function() { if (fetchMode === 'fetch') fetchData(); }, CFG.scrape);
        setInterval(update, CFG.refresh);
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();

