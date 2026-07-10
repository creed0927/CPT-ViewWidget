
// ==UserScript==
// @name         CPT View Live Widget - OB Dock
// @namespace    http://tampermonkey.net/
// @version      4.4.3
// @description  Self-contained CPT widget — draggable with corner snap, auto-refreshes data, shows containerized pkgs
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
    // BAIL OUT IF WE'RE INSIDE THE POP-OUT WINDOW
    // (prevents the script from injecting a duplicate widget)
    // ============================================
    if (window.name === 'CPT_Widget_Pop') return;

    // ============================================
    // CONFIGURATION
    // ============================================
    const CFG = {
        url: 'https://trans-logistics.amazon.com/ssp/dock/hrz/cpt',
        refresh: 10000,
        scrape: 15000,
        scale: 1.04,
        alertStagedThreshold: 130,
        alertMinutesThreshold: 20,
        pageWait: 800,
        fetchTimeout: 15000,
        dataRefresh: 60000,
        pageReload: 300000,
        snapMargin: 10,
        snapThreshold: 80
    };

    // ============================================
    // SHARED FUNCTIONS
    // ============================================
    function parseRows(rows) {
        const staged = [], loading = [], loaded = [], allCpts = [];
        const len = rows.length;

        for (let i = 0; i < len; i++) {
            const cells = rows[i].cells;
            if (!cells || cells.length < 22) continue;

            const lnSpan = cells[2].querySelector('span.laneName');
            const ln = lnSpan ? lnSpan.textContent.trim() : cells[2].textContent.trim();
            const dest = ln.includes('->') ? ln.split('->')[1].trim()
                       : ln.includes('\u2192') ? ln.split('\u2192')[1].trim()
                       : ln;

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

            allCpts.push({ lane: dest, cpt, timeLeft: tl, totalPkgs: tot, inFacilityPkgs: inf, containerizedPkgs: conP, containerizedContainers: conC, stagedPkgs: stP, loadedPkgs: ldP, loadsInProgress: lip });

            if (stP > 0 || stC > 0) staged.push({ lane: dest, pkgs: stP, containers: stC, containerizedPkgs: conP, cpt, timeLeft: tl });
            if (lip > 0) loading.push({ lane: dest, loadedPkgs: ldP, totalPkgs: tot, containerizedPkgs: conP, cpt, timeLeft: tl });
            if (ldP > 0 || ldC > 0) loaded.push({ lane: dest, pkgs: ldP, containers: ldC, cpt, timeLeft: tl });
        }

        return { staged, loading, loaded, allCpts, timestamp: Date.now() };
    }

    function extractCount(cell) {
        if (!cell) return 0;
        const a = cell.querySelector('a');
        if (a) {
            const n = parseInt(a.textContent.trim());
            return isNaN(n) ? 0 : n;
        }
        const text = cell.textContent;
        const match = text.match(/(\d+)/);
        return match ? parseInt(match[1]) : 0;
    }

    function extractNum(cell) {
        if (!cell) return 0;
        const a = cell.querySelector('a');
        if (a) return parseInt(a.textContent.trim()) || 0;
        const text = cell.textContent.trim();
        const n = parseInt(text);
        return isNaN(n) ? 0 : n;
    }

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
    // DETECT MODE
    // ============================================
    const IS_CPT_VIEW = window.location.href.includes('trans-logistics.amazon.com/ssp/dock');

    // ============================================
    // MODE 1: ACTIVE SCRAPER on CPT View page
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
            #cpt-scraper-badge .scrape-time { font-size: 9px; opacity: 0.8; }
            #cpt-scraper-badge .scrape-count { font-size: 9px; opacity: 0.7; }
        `);

        const badge = document.createElement('div');
        badge.id = 'cpt-scraper-badge';
        badge.innerHTML = '<span class="dot"></span><span>widget syncing</span><span class="scrape-time" id="scrape-time"></span><span class="scrape-count" id="scrape-count"></span>';
        document.body.appendChild(badge);

        function refreshTableData() {
            if (window.jQuery) {
                try {
                    const dt = window.jQuery('#cptsLoadInProgress').DataTable();
                    if (dt.ajax && dt.ajax.url()) { dt.ajax.reload(null, false); return; }
                } catch(e) {}
            }
            const refreshBtn = document.querySelector(
                'button.refresh, button[title="Refresh"], .refreshBtn, ' +
                'input[type="submit"][value="Search"], button.search-btn, ' +
                '#searchButton, .btn-refresh, [data-action="refresh"]'
            );
            if (refreshBtn) { refreshBtn.click(); return; }
            if (window.jQuery) {
                try { window.jQuery('#cptsLoadInProgress').DataTable().draw(false); return; } catch(e) {}
            }
            window.location.reload();
        }

        function scrapeTable() {
            const tbl = document.querySelector('#cptsLoadInProgress');
            if (!tbl) return;
            const rows = tbl.querySelectorAll('tbody tr');
            if (!rows.length) return;
            if (rows.length === 1 && rows[0].textContent.toLowerCase().includes('loading')) return;
            if (window.jQuery) {
                try {
                    const dt = window.jQuery('#cptsLoadInProgress').DataTable();
                    const info = dt.page.info();
                    if (info.pages > 1) { scrapeAllPagesLocal(dt); return; }
                } catch(e) {}
            }
            finishLocalScrape(rows);
        }

        function scrapeAllPagesLocal(dt) {
            const info = dt.page.info();
            const totalPages = info.pages;
            const originalPage = info.page;
            const collectedRows = [];
            function scrapePage(pageNum) {
                dt.page(pageNum).draw(false);
                setTimeout(() => {
                    const rows = document.querySelectorAll('#cptsLoadInProgress tbody tr');
                    for (let i = 0; i < rows.length; i++) {
                        if (rows[i].cells && rows[i].cells.length >= 22) collectedRows.push(rows[i].cloneNode(true));
                    }
                    if (pageNum + 1 < totalPages) scrapePage(pageNum + 1);
                    else { dt.page(originalPage).draw(false); finishLocalScrape(collectedRows); }
                }, CFG.pageWait);
            }
            scrapePage(0);
        }

        function finishLocalScrape(rows) {
            const data = parseRows(rows);
            GM_setValue('cpt_widget_data', JSON.stringify(data));
            const timeEl = document.getElementById('scrape-time');
            const countEl = document.getElementById('scrape-count');
            if (timeEl) {
                const now = new Date();
                timeEl.textContent = '\xB7 ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            }
            if (countEl) countEl.textContent = `\xB7 ${data.allCpts.length} cpts`;
        }

        function waitForData() {
            const tbl = document.querySelector('#cptsLoadInProgress');
            if (!tbl) { setTimeout(waitForData, 2000); return; }
            const rows = tbl.querySelectorAll('tbody tr');
            if (!rows.length || (rows.length === 1 && rows[0].textContent.toLowerCase().includes('loading'))) {
                setTimeout(waitForData, 2000); return;
            }
            scrapeTable();
            setInterval(scrapeTable, CFG.scrape);
            setInterval(() => { refreshTableData(); setTimeout(scrapeTable, 5000); }, CFG.dataRefresh);
        }

        setTimeout(waitForData, 3000);
        return;
    }

    // ============================================
    // MODE 2: WIDGET + SELF-CONTAINED FETCHER
    // ============================================

    let popWin = null;
    let popUpdateInterval = null;
    let fetchMode = 'fetch';
    let fetchFailCount = 0;

    const BASE_CSS = `
        .cw{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#000;background:#FFADDB}
        .cw-hd{background:#D39ADB;padding:10px 15px;display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none}
        .cw-hd h3{margin:0;font-size:14px;color:#FFF}
        .cw-st{font-size:11px;color:#FFF}
        .cw-bd{padding:10px 15px;overflow-y:auto}
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
        .s-stg{color:#f39c12;font-weight:bold}
        .s-ldg{color:#3498db;font-weight:bold}
        .s-ldd{color:#27ae60;font-weight:bold}
        .s-lat{color:#e74c3c;font-weight:bold}
        .s-con{color:#9b59b6;font-weight:bold}
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
        .cw-snapping{transition:top .25s ease,left .25s ease,right .25s ease,bottom .25s ease !important}
    `;

    GM_addStyle(`
        #cpt-w{position:fixed;width:420px;max-height:500px;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:999999;overflow:hidden;transform:scale(${CFG.scale});transform-origin:bottom right}
        #cpt-w.min .cw-bd{display:none}
        #cpt-w.min .cw-mv{display:block}
        .cw-mv{display:none}
        ${BASE_CSS}
    `);

    // ============================================
    // HTML BUILDERS
    // ============================================
    function buildInlineHTML() {
        return `
        <div class="cw-hd" id="cw-hd">
            <h3>outbound dock :3 - live</h3>
            <div>
                <span class="cw-st" id="cw-st">starting up...</span>
                <button class="cw-btn" id="cw-pop" title="pop out">\u29C9</button>
                <button class="cw-btn" id="cw-min">\u2014</button>
            </div>
        </div>
        <div class="cw-mv" id="cw-mv">
            <div class="cw-mini">
                <div class="cw-mi"><span class="mn s-stg" id="ms">-</span><span class="ml">staged</span></div>
                <div class="cw-mi"><span class="mn s-ldg" id="ml">-</span><span class="ml">loading</span></div>
                <div class="cw-mi"><span class="mn s-ldd" id="md">-</span><span class="ml">loaded</span></div>
                <div class="cw-mi"><span class="mn s-lat" id="mt">-</span><span class="ml">late</span></div>
            </div>
            <div class="cw-mu" id="mu">\u2014</div>
            <div id="cw-mini-alert"></div>
        </div>
        <div class="cw-bd" id="cw-bd">
            ${buildTablesHTML()}
        </div>`;
    }

    function buildPopoutHTML() {
        return `<!DOCTYPE html>
<html>
<head>
<title>outbound dock :3</title>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
        background: #FFADDB;
        overflow-y: auto;
        overflow-x: hidden;
    }
    ${BASE_CSS}
    .cw { border-radius: 0; }
    .cw-hd { cursor: default; position: sticky; top: 0; z-index: 10; }
    .cw-bd { max-height: none; overflow: visible; }
    .cw-si { flex: 1; min-width: 60px; }
</style>
</head>
<body>
<div class="cw">
    <div class="cw-hd">
        <h3>outbound dock :3 - live</h3>
        <div>
            <span class="cw-st" id="cw-st">starting up...</span>
            <button class="cw-btn" id="cw-dock" title="dock back">\u29C9</button>
        </div>
    </div>
    <div class="cw-bd" id="cw-bd">
        ${buildTablesHTML()}
    </div>
</div>
</body>
</html>`;
    }

    function buildTablesHTML() {
        return `
            <div id="cw-alert"></div>
            <div id="cw-warn"></div>
            <div class="cw-sum">
                <div class="cw-si"><span class="n" id="cs">-</span><span class="l">staged</span></div>
                <div class="cw-si"><span class="n" id="cl">-</span><span class="l">loading</span></div>
                <div class="cw-si"><span class="n" id="cd">-</span><span class="l">loaded</span></div>
                <div class="cw-si"><span class="n s-lat" id="ct">-</span><span class="l">late</span></div>
            </div>
            <div class="cw-sec"><div class="cw-sec-t">currently staged on floor</div>
                <table><thead><tr><th>lane</th><th>pkgs</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tb-s"><tr><td colspan="5">fetching data...</td></tr></tbody></table>
            </div>
            <div class="cw-sec"><div class="cw-sec-t">loading into trucks</div>
                <table><thead><tr><th>lane</th><th>loaded</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tb-l"><tr><td colspan="5">fetching data...</td></tr></tbody></table>
            </div>
            <div class="cw-sec"><div class="cw-sec-t">all active cpts</div>
                <table><thead><tr><th>lane</th><th>total</th><th>in fac</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tb-a"><tr><td colspan="6">fetching data...</td></tr></tbody></table>
            </div>
            <div class="cw-src" id="cw-src"></div>`;
    }

    // ============================================
    // DRAG + CORNER SNAP
    // ============================================
    function initDrag(widget) {
        const header = widget.querySelector('#cw-hd');
        let isDragging = false;
        let startX, startY, startLeft, startTop;
        let hasMoved = false;

        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            isDragging = true;
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = widget.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!hasMoved) {
                if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
                hasMoved = true;
                widget.classList.remove('cw-snapping');
                widget.style.right = 'auto';
                widget.style.bottom = 'auto';
                widget.style.left = startLeft + 'px';
                widget.style.top = startTop + 'px';
            }
            widget.style.left = (startLeft + dx) + 'px';
            widget.style.top = (startTop + dy) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            if (!hasMoved) return;
            snapToCorner(widget);
        });
    }

    function snapToCorner(widget) {
        const rect = widget.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const m = CFG.snapMargin;

        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const isRight = cx > vw / 2;
        const isBottom = cy > vh / 2;

        widget.classList.add('cw-snapping');
        widget.style.top = '';
        widget.style.bottom = '';
        widget.style.left = '';
        widget.style.right = '';

        if (isBottom && isRight) {
            widget.style.bottom = m + 'px'; widget.style.right = m + 'px';
            widget.style.transformOrigin = 'bottom right';
        } else if (isBottom && !isRight) {
            widget.style.bottom = m + 'px'; widget.style.left = m + 'px';
            widget.style.transformOrigin = 'bottom left';
        } else if (!isBottom && isRight) {
            widget.style.top = m + 'px'; widget.style.right = m + 'px';
            widget.style.transformOrigin = 'top right';
        } else {
            widget.style.top = m + 'px'; widget.style.left = m + 'px';
            widget.style.transformOrigin = 'top left';
        }

        GM_setValue('cpt_widget_corner', (isBottom ? 'bottom' : 'top') + '-' + (isRight ? 'right' : 'left'));
        setTimeout(() => widget.classList.remove('cw-snapping'), 300);
    }

    function applyStoredPosition(widget) {
        const corner = GM_getValue('cpt_widget_corner', 'bottom-right');
        const m = CFG.snapMargin;
        widget.style.top = ''; widget.style.bottom = ''; widget.style.left = ''; widget.style.right = '';
        switch (corner) {
            case 'bottom-right': widget.style.bottom = m+'px'; widget.style.right = m+'px'; widget.style.transformOrigin = 'bottom right'; break;
            case 'bottom-left': widget.style.bottom = m+'px'; widget.style.left = m+'px'; widget.style.transformOrigin = 'bottom left'; break;
            case 'top-right': widget.style.top = m+'px'; widget.style.right = m+'px'; widget.style.transformOrigin = 'top right'; break;
            case 'top-left': widget.style.top = m+'px'; widget.style.left = m+'px'; widget.style.transformOrigin = 'top left'; break;
        }
    }

    // ============================================
    // SYNCED MINIMIZE STATE
    // ============================================
    function setMinState(isMin) { GM_setValue('cpt_widget_minimized', isMin); }
    function getMinState() { return GM_getValue('cpt_widget_minimized', false); }

    function applyMinState(isMin) {
        const w = document.getElementById('cpt-w');
        if (!w) return;
        const btn = w.querySelector('#cw-min');
        if (isMin) { w.classList.add('min'); if (btn) btn.textContent = '\u25A2'; }
        else { w.classList.remove('min'); if (btn) btn.textContent = '\u2014'; }
    }

    GM_addValueChangeListener('cpt_widget_minimized', (name, oldVal, newVal, remote) => {
        if (remote) applyMinState(newVal);
    });

    GM_addValueChangeListener('cpt_widget_data', (name, oldVal, newVal, remote) => {
        if (remote) update();
    });

    // ============================================
    // WIDGET CREATION
    // ============================================
    function createWidget() {
        const w = document.createElement('div');
        w.id = 'cpt-w';
        w.className = 'cw';
        w.innerHTML = buildInlineHTML();
        document.body.appendChild(w);

        applyStoredPosition(w);
        applyZoom();
        applyMinState(getMinState());
        initDrag(w);

        w.querySelector('#cw-min').onclick = e => {
            e.stopPropagation();
            const isMin = !w.classList.contains('min');
            applyMinState(isMin);
            setMinState(isMin);
        };

        w.querySelector('#cw-hd').addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            const isMin = !w.classList.contains('min');
            applyMinState(isMin);
            setMinState(isMin);
        });

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
        // Close any existing pop-out first
        if (popWin && !popWin.closed) popWin.close();
        if (popUpdateInterval) { clearInterval(popUpdateInterval); popUpdateInterval = null; }
        popWin = null;

        const pw = 470, ph = 650;
        const l = Math.round((screen.width - pw) / 2);
        const t = Math.round((screen.height - ph) / 2);

        popWin = window.open('about:blank', 'CPT_Widget_Pop', `width=${pw},height=${ph},top=${t},left=${l},scrollbars=yes,menubar=no,toolbar=no,location=no,status=no`);
        if (!popWin) { alert('Pop-up blocked! Allow pop-ups for this site.'); return; }

        // Write fresh document into the pop-out
        popWin.document.open();
        popWin.document.write(buildPopoutHTML());
        popWin.document.close();

        // Wire dock button
        popWin.document.getElementById('cw-dock').addEventListener('click', () => dock());

        // Monitor for window close
        const chk = setInterval(() => {
            if (!popWin || popWin.closed) {
                clearInterval(chk);
                if (popUpdateInterval) { clearInterval(popUpdateInterval); popUpdateInterval = null; }
                popWin = null;
                showInline();
            }
        }, 500);

        // Hide inline widget
        hideInline();

        // Render immediately
        renderToDoc(popWin.document);

        // Independent update loop for pop-out
        popUpdateInterval = setInterval(() => {
            if (popWin && !popWin.closed) renderToDoc(popWin.document);
            else { clearInterval(popUpdateInterval); popUpdateInterval = null; }
        }, CFG.refresh);
    }

    function dock() {
        if (popUpdateInterval) { clearInterval(popUpdateInterval); popUpdateInterval = null; }
        if (popWin && !popWin.closed) popWin.close();
        popWin = null;
        showInline();
        update();
    }

    function hideInline() { const w = document.getElementById('cpt-w'); if (w) w.style.display = 'none'; }
    function showInline() { const w = document.getElementById('cpt-w'); if (w) w.style.display = ''; }

    // ============================================
    // GM_XMLHTTPREQUEST FETCHER
    // ============================================
    function fetchCPTData() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: CFG.url,
            timeout: CFG.fetchTimeout,
            headers: { 'Accept': 'text/html,application/xhtml+xml', 'Cache-Control': 'no-cache' },
            onload: function(response) {
                if (response.status === 200) {
                    const parsed = parseHTMLResponse(response.responseText);
                    if (parsed && parsed.allCpts.length > 0) {
                        fetchMode = 'fetch'; fetchFailCount = 0;
                        GM_setValue('cpt_widget_data', JSON.stringify(parsed));
                    } else { handleFetchEmpty(); }
                } else if (response.status === 401 || response.status === 403) { handleFetchAuthError(); }
                else { handleFetchError(); }
            },
            onerror: function() { handleFetchError(); },
            ontimeout: function() { handleFetchError(); }
        });
    }

    function parseHTMLResponse(html) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const tbl = doc.querySelector('#cptsLoadInProgress');
            if (!tbl) return null;
            const rows = tbl.querySelectorAll('tbody tr');
            if (!rows.length) return null;
            if (rows.length === 1) {
                const text = rows[0].textContent.toLowerCase();
                if (text.includes('loading') || text.includes('no data') || text.trim() === '') return null;
            }
            if (rows[0].cells && rows[0].cells.length < 22) return null;
            return parseRows(rows);
        } catch (e) { return null; }
    }

    function handleFetchEmpty() { fetchFailCount++; if (fetchFailCount >= 3) { fetchMode = 'tab'; showFallback('tab'); } }
    function handleFetchAuthError() { fetchFailCount++; fetchMode = 'tab'; showFallback('auth'); }
    function handleFetchError() { fetchFailCount++; if (fetchFailCount >= 3) { fetchMode = 'tab'; showFallback('tab'); } }

    function showFallback(type) {
        const msg = type === 'auth'
            ? `\u26A0\uFE0F session expired \u2014 <a href="${CFG.url}" target="_blank" style="color:#856404;font-weight:bold">open CPT View</a> to re-authenticate`
            : `\u26A0\uFE0F direct fetch unavailable \u2014 <a href="${CFG.url}" target="_blank" style="color:#856404;font-weight:bold">open CPT View</a> in any tab to auto-sync`;
        const warn = document.getElementById('cw-warn');
        if (warn) warn.innerHTML = `<div class="cw-warn">${msg}</div>`;
        if (popWin && !popWin.closed) {
            const pw = popWin.document.getElementById('cw-warn');
            if (pw) pw.innerHTML = `<div class="cw-warn">${msg}</div>`;
        }
    }

    function scrapeLoop() { if (fetchMode === 'fetch') fetchCPTData(); }

    // ============================================
    // CRITICAL ALERT
    // ============================================
    function getCriticalAlerts(data) {
        const alerts = [];
        for (let i = 0; i < data.staged.length; i++) {
            const s = data.staged[i];
            const mins = tlMin(s.timeLeft);
            if (s.pkgs >= CFG.alertStagedThreshold && mins <= CFG.alertMinutesThreshold) {
                alerts.push({ lane: s.lane, pkgs: s.pkgs, timeLeft: s.timeLeft, minutes: mins });
            }
        }
        alerts.sort((a, b) => a.minutes - b.minutes);
        return alerts;
    }

    function renderAlertsTo(alerts, doc) {
        const alertEl = doc.getElementById('cw-alert');
        if (!alertEl) return;
        if (!alerts.length) { alertEl.innerHTML = ''; return; }
        let h = '<div class="cw-alert"><div class="cw-alert-title">\u26A0 critical \u2014 staged freight at risk</div>';
        for (let i = 0; i < alerts.length; i++) {
            const a = alerts[i];
            h += `<div class="cw-alert-item"><span class="cw-alert-lane">${a.lane}</span><span class="cw-alert-detail">${a.pkgs} pkgs staged \xB7 ${a.timeLeft} left</span></div>`;
        }
        h += '</div>';
        alertEl.innerHTML = h;
    }

    function renderMiniAlerts(alerts) {
        const miniAlert = document.getElementById('cw-mini-alert');
        if (!miniAlert) return;
        if (!alerts.length) { miniAlert.innerHTML = ''; return; }
        let h = '<div class="cw-mini-alert">\u26A0 ';
        for (let i = 0; i < alerts.length; i++) {
            h += `${alerts[i].lane} (${alerts[i].pkgs}pkg/${alerts[i].timeLeft})`;
            if (i < alerts.length - 1) h += ' \xB7 ';
        }
        h += '</div>';
        miniAlert.innerHTML = h;
    }

    // ============================================
    // RENDER — targets a specific document
    // ============================================
    function renderToDoc(d) {
        const raw = GM_getValue('cpt_widget_data', null);
        if (!raw) return;
        let data;
        try { data = JSON.parse(raw); } catch(e) { return; }

        const { staged, loading, loaded, allCpts, timestamp } = data;
        const late = allCpts.reduce((c, i) => c + (isLate(i.timeLeft) ? 1 : 0), 0);

        const cs = d.getElementById('cs');
        if (!cs) return;
        cs.textContent = staged.length;
        d.getElementById('cl').textContent = loading.length;
        d.getElementById('cd').textContent = loaded.length;
        d.getElementById('ct').textContent = late;

        const alerts = getCriticalAlerts(data);
        renderAlertsTo(alerts, d);

        const warn = d.getElementById('cw-warn');
        if (warn && fetchMode === 'fetch') {
            const age = Math.floor((Date.now() - timestamp) / 60000);
            warn.innerHTML = age > 2 ? `<div class="cw-warn">\u26A0\uFE0F data is ${age} min old</div>` : '';
        }

        const now = new Date();
        const ts = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        // Staged table
        const tbS = d.getElementById('tb-s');
        if (tbS) {
            if (!staged.length) {
                tbS.innerHTML = '<tr><td colspan="5" style="color:#888">no freight staged</td></tr>';
            } else {
                let h = '';
                for (let i = 0; i < staged.length; i++) {
                    const s = staged[i];
                    h += `<tr><td>${s.lane}</td><td>${s.pkgs}${s.containers > 0 ? ' (+' + s.containers + 'C)' : ''}</td><td class="s-con">${s.containerizedPkgs || 0}</td><td>${s.cpt}</td><td class="${isUrg(s.timeLeft) ? 's-lat' : ''}">${s.timeLeft}</td></tr>`;
                }
                tbS.innerHTML = h;
            }
        }

        // Loading table
        const tbL = d.getElementById('tb-l');
        if (tbL) {
            if (!loading.length) {
                tbL.innerHTML = '<tr><td colspan="5" style="color:#888">no active loads</td></tr>';
            } else {
                let h = '';
                for (let i = 0; i < loading.length; i++) {
                    const l = loading[i];
                    h += `<tr><td>${l.lane}</td><td>${l.loadedPkgs} / ${l.totalPkgs}</td><td class="s-con">${l.containerizedPkgs || 0}</td><td>${l.cpt}</td><td class="${isUrg(l.timeLeft) ? 's-lat' : ''}">${l.timeLeft}</td></tr>`;
                }
                tbL.innerHTML = h;
            }
        }

        // All CPTs table
        const tbA = d.getElementById('tb-a');
        if (tbA) {
            if (!allCpts.length) {
                tbA.innerHTML = '<tr><td colspan="6" style="color:#888">no data</td></tr>';
            } else {
                allCpts.sort((a, b) => tlMin(a.timeLeft) - tlMin(b.timeLeft));
                let h = '';
                for (let i = 0; i < allCpts.length; i++) {
                    const c = allCpts[i];
                    h += `<tr><td>${c.lane}</td><td>${c.totalPkgs}</td><td>${c.inFacilityPkgs}</td><td class="s-con">${c.containerizedPkgs || 0}</td><td>${c.cpt}</td><td class="${isUrg(c.timeLeft) ? 's-lat' : ''}">${c.timeLeft}</td></tr>`;
                }
                tbA.innerHTML = h;
            }
        }

        const st = d.getElementById('cw-st');
        if (st) st.innerHTML = `<span class="cw-pulse"></span>${ts}`;

        const src = d.getElementById('cw-src');
        if (src) src.textContent = fetchMode === 'fetch' ? 'source: direct fetch' : 'source: cpt view tab';
    }

    // ============================================
    // UPDATE — renders to inline + pop-out
    // ============================================
    function update() {
        const raw = GM_getValue('cpt_widget_data', null);
        if (!raw) {
            const st = document.getElementById('cw-st');
            if (st) st.innerHTML = '<span style="color:#f39c12">\u25CF fetching...</span>';
            return;
        }

        let data;
        try { data = JSON.parse(raw); } catch(e) { return; }

        // Render to inline widget
        renderToDoc(document);

        // Update minimized summary
        const ms = document.getElementById('ms');
        if (ms) {
            ms.textContent = data.staged.length;
            document.getElementById('ml').textContent = data.loading.length;
            document.getElementById('md').textContent = data.loaded.length;
            document.getElementById('mt').textContent = data.allCpts.reduce((c, i) => c + (isLate(i.timeLeft) ? 1 : 0), 0);
        }

        const now = new Date();
        const ts = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const mu = document.getElementById('mu');
        if (mu) mu.innerHTML = `<span class="cw-pulse"></span>updated ${ts}`;

        renderMiniAlerts(getCriticalAlerts(data));

        // Also render to pop-out if open
        if (popWin && !popWin.closed) renderToDoc(popWin.document);
    }

    // ============================================
    // INIT
    // ============================================
    function init() {
        createWidget();
        update();
        fetchCPTData();
        setInterval(scrapeLoop, CFG.scrape);
        setInterval(update, CFG.refresh);
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();

