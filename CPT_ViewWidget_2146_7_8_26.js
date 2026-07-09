
// ==UserScript==
// @name         CPT View Live Widget - OB Dock
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Pulls staging/loading data from CPT View and displays as a live widget
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/main/shleem.js
// @downloadURL  https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/main/shleem.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      trans-logistics.amazon.com
// @connect      *.amazon.com
// ==/UserScript==

(function() {
    'use strict';

    // ============================================
    // CONFIGURATION — Update these for your site
    // ============================================

    const CONFIG = {
        // The URL of your CPT View page that has the data you need
        cptViewUrl: 'https://trans-logistics.amazon.com/ssp/dock/hrz/cpt',

        // How often to refresh data (in milliseconds)
        refreshInterval: 10000,

        // Your site code
        siteCode: 'KAFW',

        // Widget position on screen
        position: 'top-right'
    };

    // Don't show widget if we're already on CPT View
    if (window.location.href.includes('trans-logistics.amazon.com/ssp/dock')) {
        return;
    }

    // ============================================
    // STYLES — Widget appearance
    // ============================================

    GM_addStyle(`
        #cpt-widget {
            position: fixed;
            bottom: 10px;
            right: 10px;
            width: 520px;
            max-height: 500px;
            background: #FFADDB;
            color: #000000;
            border-radius: 10px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 13px;
            z-index: 999999;
            overflow: hidden;
            transition: all 0.3s ease;
        }

        #cpt-widget.minimized {
            width: 200px;
            max-height: 40px;
        }

        #cpt-widget-header {
            background: #D39ADB;
            padding: 10px 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: grab;
            border-bottom: 1px solid #D39ADB;
        }

        #cpt-widget-header h3 {
            margin: 0;
            font-size: 14px;
            color: #FFFFFF;
        }

        #cpt-widget-status {
            font-size: 11px;
            color: #FFFFFF;
        }

        #cpt-widget-body {
            padding: 10px 15px;
            max-height: 440px;
            overflow-y: auto;
        }

        #cpt-widget.minimized #cpt-widget-body {
            display: none;
        }

        .cpt-section {
            margin-bottom: 12px;
        }

        .cpt-section-title {
            font-size: 12px;
            font-weight: bold;
            color: #000000;
            text-transform: lowercase;
            margin-bottom: 6px;
            border-bottom: 1px solid #FFFFFF;
            padding-bottom: 4px;
        }

        .cpt-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }

        .cpt-table th {
            text-align: left;
            padding: 4px 6px;
            background: #C99DC7;
            color: #FFFFFF;
            font-weight: normal;
            font-size: 11px;
        }

        .cpt-table td {
            padding: 4px 6px;
            border-bottom: 1px solid #D9D9FF;
        }

        .cpt-table tr:hover {
            background: #D9D9FF;
        }

        .status-staged { color: #f39c12; font-weight: bold; }
        .status-loading { color: #3498db; font-weight: bold; }
        .status-loaded { color: #27ae60; font-weight: bold; }
        .status-late { color: #e74c3c; font-weight: bold; }

        .cpt-row-urgent { background: #3d1515 !important; }
        .cpt-row-warning { background: #3d3215 !important; }

        .time-critical { color: #e74c3c; font-weight: bold; }
        .time-warning { color: #f39c12; font-weight: bold; }
        .time-good { color: #27ae60; }

        .cpt-summary-bar {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }

        .cpt-summary-item {
            background: #16213e;
            padding: 6px 12px;
            border-radius: 6px;
            text-align: center;
            flex: 1;
        }

        .cpt-summary-item .number {
            font-size: 18px;
            font-weight: bold;
            display: block;
        }

        .cpt-summary-item .label {
            font-size: 10px;
            color: #888;
            text-transform: lowercase;
        }

        .cpt-minimize-btn {
            background: none;
            border: none;
            color: #888;
            font-size: 16px;
            cursor: grab;
            padding: 0 5px;
        }

        .cpt-minimize-btn:hover {
            color: white;
        }

        .cpt-refresh-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #27ae60;
            margin-right: 6px;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        .cpt-error {
            color: #e74c3c;
            padding: 10px;
            text-align: center;
        }

        .cpt-progress-bar {
            background: #333;
            border-radius: 3px;
            height: 6px;
            width: 50px;
            display: inline-block;
            overflow: hidden;
            vertical-align: middle;
        }

        .cpt-progress-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.3s ease;
        }
    `);

    // ============================================
    // WIDGET CREATION
    // ============================================

    function createWidget() {
        const widget = document.createElement('div');
        widget.id = 'cpt-widget';
        widget.innerHTML = `
            <div id="cpt-widget-header">
                <h3>🚛 outbound dock :3 - live</h3>
                <div>
                    <span id="cpt-widget-status">loading!!!</span>
                    <button class="cpt-minimize-btn" id="cpt-minimize">—</button>
                </div>
            </div>
            <div id="cpt-widget-body">
                <div class="cpt-summary-bar" id="cpt-summary">
                    <div class="cpt-summary-item">
                        <span class="number" id="count-staged">-</span>
                        <span class="label">Staged</span>
                    </div>
                    <div class="cpt-summary-item">
                        <span class="number" id="count-loading">-</span>
                        <span class="label">Loading</span>
                    </div>
                    <div class="cpt-summary-item">
                        <span class="number" id="count-loaded">-</span>
                        <span class="label">Loaded</span>
                    </div>
                    <div class="cpt-summary-item">
                        <span class="number" id="count-late" style="color: #e74c3c;">-</span>
                        <span class="label">critical</span>
                    </div>
                </div>

                <div class="cpt-section">
                    <div class="cpt-section-title">CPT loads in progress</div>
                    <table class="cpt-table">
                        <thead>
                            <tr>
                                <th>CPT</th>
                                <th>time Left</th>
                                <th>lane</th>
                                <th>loads</th>
                                <th>staged</th>
                                <th>loaded</th>
                                <th>progress</th>
                            </tr>
                        </thead>
                        <tbody id="cpt-main-table-body">
                            <tr><td colspan="7">loading...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        document.body.appendChild(widget);

        // Minimize/expand toggle
        document.getElementById('cpt-minimize').addEventListener('click', (e) => {
            e.stopPropagation();
            widget.classList.toggle('minimized');
            e.target.textContent = widget.classList.contains('minimized') ? '▢' : '—';
            GM_setValue('cpt_minimized', widget.classList.contains('minimized'));
        });

        // Click header to toggle too
        document.getElementById('cpt-widget-header').addEventListener('click', () => {
            widget.classList.toggle('minimized');
            const btn = document.getElementById('cpt-minimize');
            btn.textContent = widget.classList.contains('minimized') ? '▢' : '—';
            GM_setValue('cpt_minimized', widget.classList.contains('minimized'));
        });

        // Make draggable
        //makeDraggable(widget);

        // Restore minimized state
        if (GM_getValue('cpt_minimized', false)) {
            widget.classList.add('minimized');
            document.getElementById('cpt-minimize').textContent = '▢';
        }

        // Restore position
        const savedPos = GM_getValue('cpt_position', null);
        if (savedPos) {
            widget.style.bottom = 'auto';
            widget.style.right = 'auto';
            widget.style.top = savedPos.top + 'px';
            widget.style.left = savedPos.left + 'px';
        }
    }

    // ============================================
    // DRAGGABLE WIDGET
    // ============================================

    function makeDraggable(widget) {
        const header = widget.querySelector('#cpt-widget-header');
        let isDragging = false;
        let offsetX, offsetY;

        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            offsetX = e.clientX - widget.getBoundingClientRect().left;
            offsetY = e.clientY - widget.getBoundingClientRect().top;
            widget.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            widget.style.bottom = 'auto';
            widget.style.right = 'auto';
            widget.style.left = (e.clientX - offsetX) + 'px';
            widget.style.top = (e.clientY - offsetY) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                widget.style.transition = 'all 0.3s ease';
                GM_setValue('cpt_position', {
                    top: parseInt(widget.style.top),
                    left: parseInt(widget.style.left)
                });
            }
        });
    }

    // ============================================
    // DATA FETCHING
    // ============================================

    function fetchFromAPI() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: CONFIG.cptViewUrl,
                headers: {
                    'Accept': 'text/html'
                },
                onload: function(response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(parseHTMLResponse(response.responseText));
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: function() {
                    reject(new Error('Network error'));
                },
                ontimeout: function() {
                    reject(new Error('Request timed out'));
                },
                timeout: 15000
            });
        });
    }

    // ============================================
    // PARSE CPT VIEW HTML — Targets #cptsLoadInProgress table
    // ============================================

    function parseHTMLResponse(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const lanes = [];

        // Target the exact table by its ID from CPT View
        const table = doc.querySelector('#cptsLoadInProgress');

        if (!table) {
            console.warn('[CPT Widget] #cptsLoadInProgress table not found');
            return { lanes, totals: {} };
        }

        const rows = table.querySelectorAll('tbody tr');

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 10) return;

            // Column mapping based on #cptsLoadInProgress thead:
            // 0: CPTs (Critical Pull Time)
            // 1: Time Left
            // 2: Lane
            // 3: Complete
            // 4: Loads in Progress
            // 5: Scheduled
            // 6: Ready to Depart
            // 7: Departed
            // 8-9: Total (count / %)
            // 10-11: Expected (count / %)
            // 12-13: All In Facility (count / %)
            // 14-15: Diverted (count / %)
            // 16-17: Containerized (count / %)
            // 18-19: Staged (count / %)
            // 20-21: Loaded (count / %)
            // 22-23: Departed (count / %)

            const entry = {
                cpt: cells[0]?.textContent.trim(),
                timeLeft: cells[1]?.textContent.trim(),
                lane: cells[2]?.textContent.trim(),
                complete: cells[3]?.textContent.trim(),
                loadsInProgress: cells[4]?.textContent.trim(),
                scheduled: cells[5]?.textContent.trim(),
                readyToDepart: cells[6]?.textContent.trim(),
                departed: cells[7]?.textContent.trim(),
                totalCount: cells[8]?.textContent.trim(),
                totalPct: cells[9]?.textContent.trim(),
                expectedCount: cells[10]?.textContent.trim(),
                expectedPct: cells[11]?.textContent.trim(),
                inFacilityCount: cells[12]?.textContent.trim(),
                inFacilityPct: cells[13]?.textContent.trim(),
                divertedCount: cells[14]?.textContent.trim(),
                divertedPct: cells[15]?.textContent.trim(),
                containerizedCount: cells[16]?.textContent.trim(),
                containerizedPct: cells[17]?.textContent.trim(),
                stagedCount: cells[18]?.textContent.trim(),
                stagedPct: cells[19]?.textContent.trim(),
                loadedCount: cells[20]?.textContent.trim(),
                loadedPct: cells[21]?.textContent.trim(),
                departedCount: cells[22]?.textContent.trim(),
                departedPct: cells[23]?.textContent.trim()
            };

            // Determine urgency based on time left
            entry.urgency = getUrgency(entry.timeLeft);

            lanes.push(entry);
        });

        // Calculate totals for summary bar
        const totals = {
            totalLanes: lanes.length,
            activeLoads: lanes.reduce((sum, l) => sum + (parseInt(l.loadsInProgress) || 0), 0),
            totalStaged: lanes.reduce((sum, l) => sum + (parseInt(l.stagedCount) || 0), 0),
            totalLoaded: lanes.reduce((sum, l) => sum + (parseInt(l.loadedCount) || 0), 0),
            critical: lanes.filter(l => l.urgency === 'critical').length
        };

        return { lanes, totals };
    }

    // ============================================
    // DETERMINE URGENCY FROM "TIME LEFT" COLUMN
    // ============================================

    function getUrgency(timeLeft) {
        if (!timeLeft) return 'good';

        const text = timeLeft.toLowerCase();

        // Negative time or keywords indicating late
        if (text.includes('-') || text.includes('late') || text.includes('past')) {
            return 'critical';
        }

        // Try to parse minutes remaining
        let minutes = null;

        // Format: "H:MM" or "HH:MM"
        const timeMatch = timeLeft.match(/(\d+):(\d+)/);
        if (timeMatch) {
            minutes = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
        }

        // Format: "XX min"
        const minMatch = timeLeft.match(/(\d+)\s*min/i);
        if (minMatch) {
            minutes = parseInt(minMatch[1]);
        }

        if (minutes !== null) {
            if (minutes <= 30) return 'critical';
            if (minutes <= 60) return 'warning';
        }

        return 'good';
    }

    // ============================================
    // RENDERING DATA TO THE WIDGET
    // ============================================

    function renderData(data) {
        const { lanes, totals } = data;

        // Update summary counts
        document.getElementById('count-staged').textContent = totals.totalStaged || 0;
        document.getElementById('count-loading').textContent = totals.activeLoads || 0;
        document.getElementById('count-loaded').textContent = totals.totalLoaded || 0;
        document.getElementById('count-late').textContent = totals.critical || 0;

        // Render main CPT table
        const tableBody = document.getElementById('cpt-main-table-body');

        if (lanes.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" style="color:#888;">No active CPTs found</td></tr>';
            return;
        }

        // Sort: critical first, then warning, then good
        const sortOrder = { critical: 0, warning: 1, good: 2 };
        lanes.sort((a, b) => sortOrder[a.urgency] - sortOrder[b.urgency]);

        tableBody.innerHTML = lanes.map(lane => {
            const rowClass = lane.urgency === 'critical' ? 'cpt-row-urgent'
                           : lane.urgency === 'warning' ? 'cpt-row-warning'
                           : '';
            const timeClass = lane.urgency === 'critical' ? 'time-critical'
                            : lane.urgency === 'warning' ? 'time-warning'
                            : 'time-good';

            // Calculate progress percentage (loaded / total)
            const loadedNum = parseInt(lane.loadedCount) || 0;
            const totalNum = parseInt(lane.totalCount) || 1;
            const progressPct = Math.min(100, Math.round((loadedNum / totalNum) * 100));
            const progressColor = progressPct >= 80 ? '#27ae60'
                                : progressPct >= 50 ? '#f39c12'
                                : '#e74c3c';

            return `
                <tr class="${rowClass}">
                    <td>${lane.cpt}</td>
                    <td class="${timeClass}">${lane.timeLeft}</td>
                    <td>${lane.lane}</td>
                    <td>${lane.loadsInProgress}</td>
                    <td>${lane.stagedCount || '—'}</td>
                    <td>${lane.loadedCount || '—'}</td>
                    <td>
                        <span class="cpt-progress-bar">
                            <span class="cpt-progress-fill" style="width:${progressPct}%; background:${progressColor};"></span>
                        </span>
                        ${progressPct}%
                    </td>
                </tr>
            `;
        }).join('');

        // Update status indicator
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        document.getElementById('cpt-widget-status').innerHTML = `
            <span class="cpt-refresh-indicator"></span>Updated ${timeStr}
        `;
    }

    // ============================================
    // ERROR HANDLING
    // ============================================

    function renderError(message) {
        const body = document.getElementById('cpt-widget-body');
        body.innerHTML = `
            <div class="cpt-error">
                ⚠️ ${message}<br>
                <small>Will retry in ${CONFIG.refreshInterval / 1000}s</small>
            </div>
        `;

        document.getElementById('cpt-widget-status').innerHTML = `
            <span style="color: #e74c3c;">● Error</span>
        `;
    }

    // ============================================
    // MAIN LOOP — Fetch and render on interval
    // ============================================

    async function updateWidget() {
        try {
            const data = await fetchFromAPI();
            renderData(data);
        } catch (error) {
            console.error('[CPT Widget] Fetch error:', error.message);
            renderError(error.message);
        }
    }

    // ============================================
    // INITIALIZATION
    // ============================================

    function init() {
        createWidget();

        // First fetch immediately
        updateWidget();

        // Then refresh on interval
        setInterval(updateWidget, CONFIG.refreshInterval);

        console.log(`[CPT Widget] Running. Refreshing every ${CONFIG.refreshInterval / 1000}s`);
    }

    // Wait for page to load, then start
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }

})();

