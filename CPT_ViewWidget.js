
// ==UserScript==
// @name         CPT View Live Widget - OB Dock
// @namespace    http://tampermonkey.net/
// @version      3.9
// @description  Pulls staging/loading data from CPT View via hidden iframe — full pagination scrape
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

    // ============================================
    // CONFIGURATION
    // ============================================
    const CFG = {
        url: 'https://trans-logistics.amazon.com/ssp/dock/hrz/cpt',
        refresh: 10000,
        scrape: 15000,
        iframeWait: 8000,
        scale: 1.04,
        alertStagedThreshold: 130,
        alertMinutesThreshold: 20,
        pageWait: 800  // ms to wait between page flips during pagination
    };

    // ============================================
    // DETECT MODE: CPT View page or other page?
    // ============================================
    const IS_CPT_VIEW = window.location.href.includes('trans-logistics.amazon.com/ssp/dock/hrz/cpt');

    // ============================================
    // MODE 1: SCRAPER BADGE on CPT View page
    // ============================================
    if (IS_CPT_VIEW) {
        GM_addStyle(`
            #cpt-scraper-badge {
                position: fixed;
                bottom: 10px;
                right: 10px;
                background: #D39ADB;
                color: white;
                padding: 8px 14px;
                border-radius: 20px;
                font-family: 'Segoe UI', Arial, sans-serif;
                font-size: 11px;
                z-index: 999999;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #cpt-scraper-badge .dot {
                display: inline-block;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #27ae60;
                animation: scrapePulse 2s infinite;
            }
            @keyframes scrapePulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.4; }
            }
            #cpt-scraper-badge .scrape-time {
                font-size: 9px;
                opacity: 0.8;
            }
        `);

        const badge = document.createElement('div');
        badge.id = 'cpt-scraper-badge';
        badge.innerHTML = '<span class="dot"></span><span>widget syncing</span><span class="scrape-time" id="scrape-time"></span>';
        document.body.appendChild(badge);

        // Update badge timestamp when data is written
        GM_addValueChangeListener('cpt_widget_data', (name, oldVal, newVal, remote) => {
            if (!remote) {
                const timeEl = document.getElementById('scrape-time');
                if (timeEl) {
                    const now = new Date();
                    timeEl.textContent = '· ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                }
            }
        });

        return;
    }

    // ============================================
    // MODE 2: WIDGET on any other page
    // ============================================

    let popWin = null;
    let iframe = null;
    let scrapeT = null;
    let iframeDead = false;

    // ============================================
    // MINIMAL STYLES — single string, no duplication
    // ============================================
    const BASE_CSS = `
        .cw{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#000;background:#FFADDB}
        .cw-hd{background:#D39ADB;padding:10px 15px;display:flex;justify-content:space-between;align-items:center;cursor:grab}
        .cw-hd h3{margin:0;font-size:14px;color:#FFF}
        .cw-st{font-size:11px;color:#FFF}
        .cw-bd{padding:10px 15px;max-height:440px;overflow-y:auto}
        .cw-sec{margin-bottom:12px}
        .cw-sec-t{font-size:12px;font-weight:bold;text-transform:lowercase;margin-bottom:6px;border-bottom:1px solid #FFF;padding-bottom:4px}
        .cw table{width:100%;border-collapse:collapse;font-size:12px}
        .cw th{text-align:left;padding:4px 6px;background:#C99DC7;color:#FFF;font-weight:normal;font-size:11px}
        .cw td{padding:4px 6px;border-bottom:1px solid #D9D9FF}
        .cw tr:hover{background:#D9D9FF}
        .cw-sum{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}
        .cw-si{background:#FFF;padding:6px 12px;border-radius:6px;text-align:center}
        .cw-si .n{font-size:18px;font-weight:bold;display:block}
        .cw-si .l{font-size:10px;color:#888;text-transform:lowercase}
        .cw-btn{background:none;border:none;color:#FFF;font-size:16px;cursor:pointer;padding:0 5px}
        .cw-btn:hover{color:#000}
        .s-stg{color:#f[MAC_ADDRESS];font-weight:bold}
        .s-ldg{color:#3498db;font-weight:bold}
        .s-ldd{color:#27ae60;font-weight:bold}
        .s-lat{color:#e74c3c;font-weight:bold}
        .cw-pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:#27ae60;margin-right:6px;animation:cwp 2s infinite}
        @keyframes cwp{0%,100%{opacity:1}50%{opacity:.4}}
        .cw-warn{background:#fff3cd;color:#856404;padding:4px 8px;border-radius:4px;font-size:11px;margin-bottom:8px;text-align:center}
        .cw-mini{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:8px 15px;font-size:12px}
        .cw-mi{display:flex;align-items:center;gap:4px}
        .cw-mi .mn{font-weight:bold;font-size:14px}
        .cw-mi .ml{font-size:11px;color:#555;text-transform:lowercase}
        .cw-mu{font-size:10px;color:#555;margin-top:4px}
        .cw-src{font-size:9px;color:#888;text-align:center;margin-top:6px}
        .cw-alert{background:#e74c3c;color:#FFF;padding:6px 10px;border-radius:6px;margin-bottom:8px;font-size:11px;animation:cwflash 1s infinite}
        .cw-alert-item{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.2)}
        .cw-alert-item:last-child{border-bottom:none}
        .cw-alert-title{font-weight:bold;font-size:12px;margin-bottom:4px;display:flex;align-items:center;gap:6px}
        .cw-alert-lane{font-weight:bold}
        .cw-alert-detail{font-size:10px;opacity:.9}
        @keyframes cwflash{0%,100%{opacity:1}50%{opacity:.85}}
        .cw-mini-alert{background:#e74c3c;color:#FFF;padding:4px 8px;border-radius:4px;font-size:10px;margin-top:4px;animation:cwflash 1s infinite}
    `;

    GM_addStyle(`
        #cpt-w{position:fixed;bottom:10px;right:10px;width:420px;max-height:500px;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:999999;overflow:hidden;transition:all .3s ease;transform:scale(${CFG.scale});transform-origin:bottom right}
        #cpt-w.min .cw-bd{display:none}
        #cpt-w.min .cw-mv{display:block}
        .cw-mv{display:none}
        ${BASE_CSS}
    `);

    // ============================================
    // TEMPLATE — Reused for inline & popout (built once)
    // ============================================
    function buildHTML(isPopout) {
        return `
        <div class="cw-hd" id="cw-hd">
            <h3>outbound dock :3 - live</h3>
            <div>
                <span class="cw-st" id="cw-st">loading!!!</span>
                ${isPopout
                    ? '<button class="cw-btn" id="cw-dock" title="dock back">⧉</button>'
                    : '<button class="cw-btn" id="cw-pop" title="pop out">⧉</button><button class="cw-btn" id="cw-min">—</button>'}
            </div>
        </div>
        ${!isPopout ? `<div class="cw-mv" id="cw-mv">
            <div class="cw-mini">
                <div class="cw-mi"><span class="mn s-stg" id="ms">-</span><span class="ml">staged</span></div>
                <div class="cw-mi"><span class="mn s-ldg" id="ml">-</span><span class="ml">loading</span></div>
                <div class="cw-mi"><span class="mn s-ldd" id="md">-</span><span class="ml">loaded</span></div>
                <div class="cw-mi"><span class="mn s-lat" id="mt">-</span><span class="ml">late</span></div>
            </div>
            <div class="cw-mu" id="mu">—</div>
            <div id="cw-mini-alert"></div>
        </div>` : ''}
        <div class="cw-bd" id="cw-bd">
            <div id="cw-alert"></div>
            <div id="cw-warn"></div>
            <div class="cw-sum">
                <div class="cw-si"><span class="n" id="cs">-</span><span class="l">staged</span></div>
                <div class="cw-si"><span class="n" id="cl">-</span><span class="l">loading</span></div>
                <div class="cw-si"><span class="n" id="cd">-</span><span class="l">loaded</span></div>
                <div class="cw-si"><span class="n s-lat" id="ct">-</span><span class="l">late</span></div>
            </div>
            <div class="cw-sec"><div class="cw-sec-t">currently staged on floor</div>
                <table><thead><tr><th>lane</th><th>pkgs</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tb-s"><tr><td colspan="4">starting up...</td></tr></tbody></table>
            </div>
            <div class="cw-sec"><div class="cw-sec-t">loading into trucks</div>
                <table><thead><tr><th>lane</th><th>loaded</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tb-l"><tr><td colspan="4">starting up...</td></tr></tbody></table>
            </div>
            <div class="cw-sec"><div class="cw-sec-t">all active cpts</div>
                <table><thead><tr><th>lane</th><th>total</th><th>in fac</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tb-a"><tr><td colspan="5">starting up...</td></tr></tbody></table>
            </div>
            <div class="cw-src" id="cw-src"></div>
        </div>`;
    }

    // ============================================
    // SYNCED MINIMIZE STATE ACROSS TABS
    // ============================================
    function setMinState(isMin) {
        GM_setValue('cpt_widget_minimized', isMin);
    }

    function getMinState() {
        return GM_getValue('cpt_widget_minimized', false);
    }

    function applyMinState(isMin) {
        const w = document.getElementById('cpt-w');
        if (!w) return;
        const btn = w.querySelector('#cw-min');

        if (isMin) {
            w.classList.add('min');
            if (btn) btn.textContent = '▢';
        } else {
            w.classList.remove('min');
            if (btn) btn.textContent = '—';
        }
    }

    GM_addValueChangeListener('cpt_widget_minimized', (name, oldVal, newVal, remote) => {
        if (remote) applyMinState(newVal);
    });

    // ============================================
    // WIDGET CREATION (inline)
    // ============================================
    function createWidget() {
        const w = document.createElement('div');
        w.id = 'cpt-w';
        w.className = 'cw';
        w.innerHTML = buildHTML(false);
        document.body.appendChild(w);
        applyZoom();

        applyMinState(getMinState());

        w.querySelector('#cw-min').onclick = e => {
            e.stopPropagation();
            const isMin = !w.classList.contains('min');
            applyMinState(isMin);
            setMinState(isMin);
        };
        w.querySelector('#cw-hd').onclick = e => {
            if (e.target.tagName === 'BUTTON') return;
            const isMin = !w.classList.contains('min');
            applyMinState(isMin);
            setMinState(isMin);
        };
        w.querySelector('#cw-pop').onclick = e => { e.stopPropagation(); popOut(); };

        window.addEventListener('resize', applyZoom);
        if (window.visualViewport) window.visualViewport.addEventListener('resize', applyZoom);
    }

    function applyZoom() {
        const w = document.getElementById('cpt-w');
        if (!w) return;
        const z = Math.round(window.devicePixelRatio * 100) / 100;
        w.style.transform = `scale(${CFG.scale / z})`;
    }

    // ============================================
    // POP-OUT
    // ============================================
    function popOut() {
        const pw = 440, ph = 550;
        const l = Math.round((screen.width - pw) / 2);
        const t = Math.round((screen.height - ph) / 2);

        popWin = window.open('', 'CPT_W', `width=${pw},height=${ph},top=${t},left=${l},resizable=no,scrollbars=no,menubar=no,toolbar=no,location=no,status=no`);
        if (!popWin) { alert('Pop-up blocked!'); return; }

        popWin.document.write(`<!DOCTYPE html><html><head><title>outbound dock :3</title><style>
            *{box-sizing:border-box}html,body{margin:0;padding:0;overflow:hidden}
            .cw{padding-top:30px}${BASE_CSS}
            .cw-si{flex:1;min-width:60px}
        </style></head><body><div class="cw" id="cpt-w">${buildHTML(true)}</div></body></html>`);
        popWin.document.close();

        popWin.document.getElementById('cw-dock').onclick = dock;

        const chk = setInterval(() => {
            if (popWin && popWin.closed) { clearInterval(chk); popWin = null; showInline(); }
        }, 500);

        hideInline();
        update();
    }

    function dock() {
        if (popWin && !popWin.closed) popWin.close();
        popWin = null;
        showInline();
        update();
    }

    function hideInline() { const w = document.getElementById('cpt-w'); if (w) w.style.display = 'none'; }
    function showInline() { const w = document.getElementById('cpt-w'); if (w) w.style.display = ''; }

    function getDoc() {
        if (popWin && !popWin.closed) return popWin.document;
        return document;
    }

    // ============================================
    // IFRAME SCRAPER — FULL PAGINATION SUPPORT
    // ============================================
    function startScrape() {
        if (iframe) { iframe.remove(); iframe = null; }

        iframe = document.createElement('iframe');
        iframe.src = CFG.url;
        iframe.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;opacity:0;pointer-events:none;border:none;';
        document.body.appendChild(iframe);

        let loaded = false;
        iframe.onload = () => {
            loaded = true;
            setTimeout(doScrape, CFG.iframeWait);
        };
        iframe.onerror = () => { iframeDead = true; destroyIframe(); showFallback(); };

        setTimeout(() => {
            if (!loaded && !GM_getValue('cpt_widget_data', null)) {
                iframeDead = true;
                destroyIframe();
                showFallback();
            }
        }, 20000);
    }

    function doScrape() {
        if (!iframe) return;
        try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            const iframeWin = iframe.contentWindow;
            if (!doc || !iframeWin) throw new Error('cross-origin');

            const tbl = doc.querySelector('#cptsLoadInProgress');
            if (!tbl) { setTimeout(doScrape, 3000); return; }

            const rows = tbl.querySelectorAll('tbody tr');
            if (!rows.length || (rows.length === 1 && rows[0].textContent.toLowerCase().includes('loading'))) {
                setTimeout(doScrape, 3000);
                return;
            }

            // ---- STRATEGY 1: Use DataTables API to show all rows ----
            if (iframeWin.jQuery) {
                try {
                    const dt = iframeWin.jQuery('#cptsLoadInProgress').DataTable();
                    const info = dt.page.info();

                    if (info.pages > 1) {
                        // Attempt to show all rows at once
                        dt.page.len(-1).draw(false);

                        setTimeout(() => {
                            const allRows = doc.querySelectorAll('#cptsLoadInProgress tbody tr');
                            if (allRows.length > rows.length) {
                                // show-all worked
                                finishScrape(allRows);
                            } else {
                                // -1 didn't expand, reset and fall back to page looping
                                dt.page.len(info.length).draw(false);
                                setTimeout(() => scrapeAllPages(dt, doc), 500);
                            }
                        }, 2000);
                        return;
                    }
                    // Only 1 page — scrape directly
                } catch (e) {
                    console.log('[CPT Widget] DataTables API failed, trying dropdown fallback');
                }
            }

            // ---- STRATEGY 2: Change the page-length dropdown ----
            const select = doc.querySelector('select[name="cptsLoadInProgress_length"]');
            if (select) {
                const allOption = [...select.options].find(o => o.value === '-1' || o.textContent.trim().toLowerCase() === 'all');
                const maxOption = [...select.options].reduce((max, o) => {
                    const v = parseInt(o.value);
                    return (!isNaN(v) && v > parseInt(max.value)) ? o : max;
                }, select.options[0]);

                const targetOption = allOption || maxOption;
                if (targetOption && select.value !== targetOption.value) {
                    select.value = targetOption.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));

                    setTimeout(() => {
                        const allRows = doc.querySelectorAll('#cptsLoadInProgress tbody tr');
                        finishScrape(allRows);
                    }, 2000);
                    return;
                }
            }

            // ---- STRATEGY 3: Scrape visible rows (single page fallback) ----
            finishScrape(rows);

        } catch (e) {
            iframeDead = true;
            destroyIframe();
            showFallback();
        }
    }

    // ---- Loop through all DataTable pages one by one ----
    function scrapeAllPages(dt, doc) {
        const info = dt.page.info();
        const totalPages = info.pages;
        const collectedRows = [];

        function scrapePage(pageNum) {
            dt.page(pageNum).draw(false);

            setTimeout(() => {
                const rows = doc.querySelectorAll('#cptsLoadInProgress tbody tr');
                for (let i = 0; i < rows.length; i++) {
                    if (rows[i].cells && rows[i].cells.length >= 22) {
                        collectedRows.push(rows[i].cloneNode(true));
                    }
                }

                if (pageNum + 1 < totalPages) {
                    scrapePage(pageNum + 1);
                } else {
                    finishScrape(collectedRows);
                }
            }, CFG.pageWait);
        }

        scrapePage(0);
    }

    // ---- Final step: parse all collected rows and store ----
    function finishScrape(rows) {
        const data = parseRows(rows);
        GM_setValue('cpt_widget_data', JSON.stringify(data));
        iframeDead = false;
        console.log(`[CPT Widget] Scraped ${data.allCpts.length} total CPTs across all pages.`);
        destroyIframe();
        scrapeT = setTimeout(startScrape, CFG.scrape);
    }

    function destroyIframe() {
        if (iframe) {
            iframe.onload = null;
            iframe.onerror = null;
            iframe.src = 'about:blank';
            iframe.remove();
            iframe = null;
        }
    }

    function showFallback() {
        const d = getDoc();
        const el = d.getElementById('cw-warn');
        if (el) el.innerHTML = `<div class="cw-warn">⚠️ iframe blocked — open <a href="${CFG.url}" target="_blank" style="color:#856404;font-weight:bold;">CPT View</a> in a tab</div>`;
    }

    // ============================================
    // TABLE PARSER — minimal allocations
    // ============================================
    function parseRows(rows) {
        const staged = [], loading = [], loaded = [], allCpts = [];
        const len = rows.length;

        for (let i = 0; i < len; i++) {
            const cells = rows[i].cells;
            if (!cells || cells.length < 22) continue;

            const lnSpan = cells[2].querySelector('span.laneName');
            const ln = lnSpan ? lnSpan.textContent.trim() : cells[2].textContent.trim();
            const dest = ln.includes('->') ? ln.split('->')[1] : (ln.includes('→') ? ln.split('→')[1] : ln);
            const tl = cells[1].textContent.trim();
            const cpt = cells[0].textContent.trim();
            const lip = parseInt(cells[4].textContent.trim()) || 0;

            const tot = xCount(cells[8]);
            const inf = xCount(cells[12]);
            const stP = xCount(cells[18]);
            const stC = xCount(cells[19]);
            const ldP = xCount(cells[20]);
            const ldC = xCount(cells[21]);

            allCpts.push({ lane: dest, cpt, timeLeft: tl, totalPkgs: tot, inFacilityPkgs: inf, stagedPkgs: stP, loadedPkgs: ldP, loadsInProgress: lip });

            if (stP > 0 || stC > 0) staged.push({ lane: dest, pkgs: stP, containers: stC, cpt, timeLeft: tl });
            if (lip > 0) loading.push({ lane: dest, loadedPkgs: ldP, totalPkgs: tot, cpt, timeLeft: tl });
            if (ldP > 0 || ldC > 0) loaded.push({ lane: dest, pkgs: ldP, containers: ldC, cpt, timeLeft: tl });
        }

        return { staged, loading, loaded, allCpts, timestamp: Date.now() };
    }

    function xCount(cell) {
        const a = cell.querySelector('a');
        if (a) return parseInt(a.textContent) || 0;
        const m = cell.textContent.match(/[PC]:\s*(\d+)/);
        return m ? parseInt(m[1]) : 0;
    }

    // ============================================
    // HELPERS
    // ============================================
    function tlMin(t) {
        if (!t) return 99999;
        const h = (t.match(/(\d+)\s*hr/) || [, 0])[1] | 0;
        const m = (t.match(/(\d+)\s*min/) || [, 0])[1] | 0;
        return h * 60 + m;
    }
    function isLate(t) {
        if (!t) return false;
        const s = t.toLowerCase();
        if (s.includes('-') || s.includes('late') || s.includes('past')) return true;
        return tlMin(t) <= 0;
    }
    function isUrg(t) { return tlMin(t) <= 120; }

    // ============================================
    // CRITICAL ALERT
    // ============================================
    function getCriticalAlerts(data) {
        const alerts = [];
        const { staged } = data;

        for (let i = 0; i < staged.length; i++) {
            const s = staged[i];
            const mins = tlMin(s.timeLeft);
            if (s.pkgs >= CFG.alertStagedThreshold && mins <= CFG.alertMinutesThreshold) {
                alerts.push({ lane: s.lane, pkgs: s.pkgs, timeLeft: s.timeLeft, minutes: mins });
            }
        }

        alerts.sort((a, b) => a.minutes - b.minutes);
        return alerts;
    }

    function renderAlerts(alerts, doc) {
        const alertEl = doc.getElementById('cw-alert');
        if (alertEl) {
            if (!alerts.length) {
                alertEl.innerHTML = '';
            } else {
                let h = '<div class="cw-alert"><div class="cw-alert-title">⚠ critical — staged freight at risk</div>';
                for (let i = 0; i < alerts.length; i++) {
                    const a = alerts[i];
                    h += `<div class="cw-alert-item"><span class="cw-alert-lane">${a.lane}</span><span class="cw-alert-detail">${a.pkgs} pkgs staged · ${a.timeLeft} left</span></div>`;
                }
                h += '</div>';
                alertEl.innerHTML = h;
            }
        }

        const miniAlert = document.getElementById('cw-mini-alert');
        if (miniAlert) {
            if (!alerts.length) {
                miniAlert.innerHTML = '';
            } else {
                let h = '<div class="cw-mini-alert">⚠ ';
                for (let i = 0; i < alerts.length; i++) {
                    const a = alerts[i];
                    h += `${a.lane} (${a.pkgs}pkg/${a.timeLeft})`;
                    if (i < alerts.length - 1) h += ' · ';
                }
                h += '</div>';
                miniAlert.innerHTML = h;
            }
        }
    }

    // ============================================
    // RENDER
    // ============================================
    function render(data) {
        const d = getDoc();
        const { staged, loading, loaded, allCpts, timestamp } = data;
        const late = allCpts.reduce((c, i) => c + (isLate(i.timeLeft) ? 1 : 0), 0);

        const cs = d.getElementById('cs');
        if (!cs) return;
        cs.textContent = staged.length;
        d.getElementById('cl').textContent = loading.length;
        d.getElementById('cd').textContent = loaded.length;
        d.getElementById('ct').textContent = late;

        const ms = document.getElementById('ms');
        if (ms) {
            ms.textContent = staged.length;
            document.getElementById('ml').textContent = loading.length;
            document.getElementById('md').textContent = loaded.length;
            document.getElementById('mt').textContent = late;
        }

        const alerts = getCriticalAlerts(data);
        renderAlerts(alerts, d);

        const warn = d.getElementById('cw-warn');
        if (warn && !iframeDead) {
            const age = Math.floor((Date.now() - timestamp) / 60000);
            warn.innerHTML = age > 2 ? `<div class="cw-warn">⚠️ data is ${age} min old</div>` : '';
        }

        const now = new Date();
        const ts = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const mu = document.getElementById('mu');
        if (mu) mu.innerHTML = `<span class="cw-pulse"></span>updated ${ts}`;

        const tbS = d.getElementById('tb-s');
        if (!staged.length) {
            tbS.innerHTML = '<tr><td colspan="4" style="color:#888">no freight staged</td></tr>';
        } else {
            let h = '';
            for (let i = 0; i < staged.length; i++) {
                const s = staged[i];
                h += `<tr><td>${s.lane}</td><td>${s.pkgs}${s.containers > 0 ? ' (+' + s.containers + 'C)' : ''}</td><td>${s.cpt}</td><td class="${isUrg(s.timeLeft) ? 's-lat' : ''}">${s.timeLeft}</td></tr>`;
            }
            tbS.innerHTML = h;
        }

        const tbL = d.getElementById('tb-l');
        if (!loading.length) {
            tbL.innerHTML = '<tr><td colspan="4" style="color:#888">no active loads</td></tr>';
        } else {
            let h = '';
            for (let i = 0; i < loading.length; i++) {
                const l = loading[i];
                h += `<tr><td>${l.lane}</td><td>${l.loadedPkgs} / ${l.totalPkgs}</td><td>${l.cpt}</td><td class="${isUrg(l.timeLeft) ? 's-lat' : ''}">${l.timeLeft}</td></tr>`;
            }
            tbL.innerHTML = h;
        }

        const tbA = d.getElementById('tb-a');
        if (!allCpts.length) {
            tbA.innerHTML = '<tr><td colspan="5" style="color:#888">no data</td></tr>';
        } else {
            allCpts.sort((a, b) => tlMin(a.timeLeft) - tlMin(b.timeLeft));
            let h = '';
            for (let i = 0; i < allCpts.length; i++) {
                const c = allCpts[i];
                h += `<tr><td>${c.lane}</td><td>${c.totalPkgs}</td><td>${c.inFacilityPkgs}</td><td>${c.cpt}</td><td class="${isUrg(c.timeLeft) ? 's-lat' : ''}">${c.timeLeft}</td></tr>`;
            }
            tbA.innerHTML = h;
        }

        const st = d.getElementById('cw-st');
        if (st) st.innerHTML = `<span class="cw-pulse"></span>${ts}`;

        const src = d.getElementById('cw-src');
        if (src) src.textContent = iframeDead ? 'source: cpt view tab' : 'source: auto-iframe';

        if (popWin && !popWin.closed) {
            const wEl = popWin.document.getElementById('cpt-w');
            if (wEl) {
                const ch = popWin.outerHeight - popWin.innerHeight;
                const cw = popWin.outerWidth - popWin.innerWidth;
                popWin.resizeTo(440 + cw, wEl.scrollHeight + ch);
            }
        }
    }

    // ============================================
    // MAIN LOOP
    // ============================================
    function update() {
        const raw = GM_getValue('cpt_widget_data', null);
        if (!raw) {
            const st = getDoc().getElementById('cw-st');
            if (st) st.innerHTML = '<span style="color:#f[MAC_ADDRESS]">● connecting...</span>';
            return;
        }
        try { render(JSON.parse(raw)); } catch (e) {}
    }

    // ============================================
    // INIT
    // ============================================
    function init() {
        createWidget();
        update();
        startScrape();
        setInterval(update, CFG.refresh);
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();

