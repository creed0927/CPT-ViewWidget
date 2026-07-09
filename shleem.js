
// ==UserScript==
// @name         CPT View Live Widget - OB Dock
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Pulls staging/loading data from CPT View and displays as a live widget
// @match        *://*/*
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/main/shleem.js
// @downloadURL  https://raw.githubusercontent.com/creed0927/CPT-ViewWidget/main/shleem.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      https://trans-logistics.amazon.com/ssp/dock/hrz/cpt
// @connect      *.amazon.com
// ==/UserScript==

(function() {
    'use strict';

    // ============================================
    // CONFIGURATION — Update these for your site
    // ============================================

    const CONFIG = {
        // The URL of your CPT View page that has the data you need
        // Look at your browser address bar when you're on CPT View
        cptViewUrl: 'https://trans-logistics.amazon.com/ssp/dock/hrz/cpt',

        // How often to refresh data (in milliseconds)
        // 30000 = 30 seconds, 60000 = 1 minute
        refreshInterval: 10000,

        // Your site code
        siteCode: 'KAFW',

        // Widget position on screen
        position: 'top-right'  // 'bottom-right', 'bottom-left', 'top-right', 'top-left'
    };

    // ============================================
    // STYLES — Widget appearance
    // ============================================

    GM_addStyle(`
        #cpt-widget {
            position: fixed;
            bottom: 10px;
            right: 10px;
            width: 420px;
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
            text-transform: uppercase;
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
        }

        .cpt-summary-item .number {
            font-size: 18px;
            font-weight: bold;
            display: block;
        }

        .cpt-summary-item .label {
            font-size: 10px;
            color: #888;
            text-transform: uppercase;
        }

        .cpt-minimize-btn {
            background: none;
            border: none;
            color: #888;
            font-size: 16px;
            cursor: pointer;
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
    `);

    // ============================================
    // WIDGET CREATION
    // ============================================

    function createWidget() {
        const widget = document.createElement('div');
        widget.id = 'cpt-widget';
        widget.innerHTML = `
            <div id="cpt-widget-header">
                <h3> outbound dock :3 - live </h3>
                <div>
                    <span id="cpt-widget-status">loading!!!</span>
                    <button class="cpt-minimize-btn" id="cpt-minimize">—</button>
                </div>
            </div>
            <div id="cpt-widget-body">
                <div class="cpt-summary-bar" id="cpt-summary">
                    <div class="cpt-summary-item">
                        <span class="number" id="count-staged">-</span>
                        <span class="label">staged</span>
                    </div>
                    <div class="cpt-summary-item">
                        <span class="number" id="count-loading">-</span>
                        <span class="label">loading</span>
                    </div>
                    <div class="cpt-summary-item">
                        <span class="number" id="count-loaded">-</span>
                        <span class="label">loaded</span>
                    </div>
                    <div class="cpt-summary-item">
                        <span class="number" id="count-late" style="color: #e74c3c;">-</span>
                        <span class="label">late</span>
                    </div>
                </div>

                <div class="cpt-section">
                    <div class="cpt-section-title">currently staged on Floor</div>
                    <table class="cpt-table">
                        <thead>
                            <tr>
                                <th>Trailer</th>
                                <th>Destination</th>
                                <th>CPT</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody id="staged-table-body">
                            <tr><td colspan="4">loading...</td></tr>
                        </tbody>
                    </table>
                </div>

                <div class="cpt-section">
                    <div class="cpt-section-title">loading into trucks</div>
                    <table class="cpt-table">
                        <thead>
                            <tr>
                                <th>Trailer</th>
                                <th>Door</th>
                                <th>Progress</th>
                                <th>CPT</th>
                            </tr>
                        </thead>
                        <tbody id="loading-table-body">
                            <tr><td colspan="4">Loading...</td></tr>
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
        });

        // Click header to toggle too
        document.getElementById('cpt-widget-header').addEventListener('click', () => {
            widget.classList.toggle('minimized');
            const btn = document.getElementById('cpt-minimize');
            btn.textContent = widget.classList.contains('minimized') ? '▢' : '—';
        });
    }

    // ============================================
    // DATA FETCHING
    // ============================================

    // --- Option A: Fetch from CPT View API endpoint (if available) ---
    function fetchFromAPI() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: CONFIG.cptViewUrl,
                headers: {
                    'Accept': 'application/json'
                },
                onload: function(response) {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            const data = JSON.parse(response.responseText);
                            resolve(data);
                        } catch (e) {
                            // If not JSON, it's probably an HTML page — use Option B
                            resolve(parseHTMLResponse(response.responseText));
                        }
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

    // --- Option B: Parse HTML page (if CPT View doesn't have a JSON API) ---
    function parseHTMLResponse(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // =============================================
        // CUSTOMIZE THIS SECTION
        // =============================================
        // You need to inspect CPT View's HTML structure using DevTools (F12)
        // and update these selectors to match the actual table/elements.
        //
        // Steps to figure out the selectors:
        // 1. Open CPT View in your browser
        // 2. Press F12 to open DevTools
        // 3. Click the "Select Element" tool (top-left of DevTools)
        // 4. Click on the data table or cells you want
        // 5. Note the class names, IDs, or structure
        // =============================================

        const staged = [];
        const loading = [];

        // Example: Parse rows from a table (adjust selectors!)
        const rows = doc.querySelectorAll('table.data-table tbody tr');

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 4) return;

            const entry = {
                trailer: cells[0]?.textContent.trim(),
                destination: cells[1]?.textContent.trim(),
                door: cells[2]?.textContent.trim(),
                cpt: cells[3]?.textContent.trim(),
                status: cells[4]?.textContent.trim().toLowerCase(),
                progress: cells[5]?.textContent.trim()
            };

            // Sort into staged vs loading based on status
            if (entry.status.includes('staged') || entry.status.includes('floor')) {
                staged.push(entry);
            } else if (entry.status.includes('loading') || entry.status.includes('in progress')) {
                loading.push(entry);
            }
        });

        return { staged, loading };
    }

    // ============================================
    // RENDERING DATA TO THE WIDGET
    // ============================================

    function renderData(data) {
        const { staged, loading } = data;

        // Update summary counts
        document.getElementById('count-staged').textContent = staged.length;
        document.getElementById('count-loading').textContent = loading.length;

        // Count loaded and late (adjust logic to your data)
        const loaded = (data.loaded || []).length;
        const late = staged.filter(item => isLate(item.cpt)).length
                   + loading.filter(item => isLate(item.cpt)).length;

        document.getElementById('count-loaded').textContent = loaded;
        document.getElementById('count-late').textContent = late;

        // Render staged table
        const stagedBody = document.getElementById('staged-table-body');
        if (staged.length === 0) {
            stagedBody.innerHTML = '<tr><td colspan="4" style="color:#888;">No freight staged</td></tr>';
        } else {
            stagedBody.innerHTML = staged.map(item => `
                <tr>
                    <td>${item.trailer}</td>
                    <td>${item.destination}</td>
                    <td class="${isLate(item.cpt) ? 'status-late' : ''}">${item.cpt}</td>
                    <td class="status-staged">${item.status}</td>
                </tr>
            `).join('');
        }

        // Render loading table
        const loadingBody = document.getElementById('loading-table-body');
        if (loading.length === 0) {
            loadingBody.innerHTML = '<tr><td colspan="4" style="color:#888;">No active loads</td></tr>';
        } else {
            loadingBody.innerHTML = loading.map(item => `
                <tr>
                    <td>${item.trailer}</td>
                    <td>${item.door || '—'}</td>
                    <td>${item.progress || '—'}</td>
                    <td class="${isLate(item.cpt) ? 'status-late' : ''}">${item.cpt}</td>
                </tr>
            `).join('');
        }

        // Update status indicator
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        document.getElementById('cpt-widget-status').innerHTML = `
            <span class="cpt-refresh-indicator"></span>Updated ${timeStr}
        `;
    }

    // ============================================
    // HELPER: Check if a CPT time is late
    // ============================================

    function isLate(cptString) {
        if (!cptString) return false;

        // Adjust this parsing based on how CPT View formats times
        // Common formats: "14:30", "2:30 PM", "2026-07-08T14:30:00"
        try {
            const now = new Date();
            let cptTime;

            // Try parsing as a full date string
            cptTime = new Date(cptString);

            // If that didn't work, try as time-only (assume today)
            if (isNaN(cptTime.getTime())) {
                const today = now.toISOString().split('T')[0];
                cptTime = new Date(`${today}T${cptString}`);
            }

            if (isNaN(cptTime.getTime())) return false;

            // It's late if CPT is in the past
            return now > cptTime;
        } catch (e) {
            return false;
        }
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

