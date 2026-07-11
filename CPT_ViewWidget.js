
// ==UserScript==
// @name         CPT View Live Widget - OB Dock
// @namespace    http://tampermonkey.net/
// @version      4.7
// @description  Memory-optimized CPT widget — scrollable body, minimal allocations
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

    // CONFIG
    var URL = 'https://trans-logistics.amazon.com/ssp/dock/hrz/cpt',
        REFRESH = 10000,
        SCRAPE = 15000,
        SCALE = 1.04,
        ALERT_PKG = 130,
        ALERT_MIN = 20,
        PG_WAIT = 800,
        TIMEOUT = 15000,
        DATA_REFRESH = 60000,
        SNAP_M = 10;

    // Pre-compiled regex
    var RH = /(\d+)\s*hr/, RM = /(\d+)\s*min/, RN = /(\d+)/;

    // Shared buffer
    var B = '';

    // Utils
    function tm(t) {
        if (!t) return 99999;
        var h = RH.exec(t), m = RM.exec(t);
        return ((h ? +h[1] : 0) * 60) + (m ? +m[1] : 0);
    }
    function late(t) {
        if (!t) return false;
        if (t.charCodeAt(0) === 45) return true;
        return t.indexOf('late') !== -1 || t.indexOf('past') !== -1 || tm(t) <= 0;
    }
    function urg(t) { return tm(t) <= 120; }
    function ec(c) {
        if (!c) return 0;
        var a = c.firstElementChild;
        if (a && a.tagName === 'A') return +a.textContent || 0;
        var m = RN.exec(c.textContent);
        return m ? +m[1] : 0;
    }

    // Parser — single pass
    function parse(rows) {
        var st = [], ld = [], dd = [], all = [], i = 0, len = rows.length;
        for (; i < len; i++) {
            var cs = rows[i].cells;
            if (!cs || cs.length < 22) continue;
            var c2 = cs[2], sp = c2.getElementsByTagName('span')[0];
            var ln = sp ? sp.textContent : c2.textContent;
            var ai = ln.indexOf('->'), a2 = ln.indexOf('\u2192');
            var dest = ai !== -1 ? ln.substring(ai + 2).trim() : a2 !== -1 ? ln.substring(a2 + 1).trim() : ln.trim();
            var tl = cs[1].textContent.trim(), cpt = cs[0].textContent.trim();
            var lip = ec(cs[4]), tot = ec(cs[8]), inf = ec(cs[12]);
            var conP = ec(cs[16]), stP = ec(cs[18]), stC = ec(cs[19]), ldP = ec(cs[20]), ldC = ec(cs[21]);

            all[all.length] = {l:dest,c:cpt,t:tl,tp:tot,if:inf,cp:conP,sp:stP,lp:ldP,li:lip};
            if (stP > 0 || stC > 0) st[st.length] = {l:dest,p:stP,cn:stC,cp:conP,c:cpt,t:tl};
            if (lip > 0) ld[ld.length] = {l:dest,lp:ldP,tp:tot,cp:conP,c:cpt,t:tl};
            if (ldP > 0 || ldC > 0) dd[dd.length] = {l:dest,p:ldP,cn:ldC,c:cpt,t:tl};
        }
        return {s:st,g:ld,d:dd,a:all,ts:Date.now()};
    }

    // ============================================
    // MODE 1: CPT VIEW SCRAPER
    // ============================================
    if (window.location.href.indexOf('trans-logistics.amazon.com/ssp/dock') !== -1) {
        GM_setValue('cpt_view_open', true);
        window.addEventListener('beforeunload', function() { GM_setValue('cpt_view_open', false); });

        GM_addStyle('#cpt-sb{position:fixed;bottom:10px;right:10px;background:#D39ADB;color:#fff;padding:8px 14px;border-radius:20px;font:11px "Segoe UI",sans-serif;z-index:999999;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;gap:8px}.sbd{width:8px;height:8px;border-radius:50%;background:#27ae60;animation:sp 2s infinite}@keyframes sp{0%,100%{opacity:1}50%{opacity:.4}}.sbt{font-size:9px;opacity:.8}');

        var badge = document.createElement('div');
        badge.id = 'cpt-sb';
        badge.innerHTML = '<span class="sbd"></span><span>widget syncing</span><span class="sbt" id="sbt"></span><span class="sbt" id="sbc"></span>';
        document.body.appendChild(badge);

        function rfr() {
            if (window.jQuery) { try { var dt = window.jQuery('#cptsLoadInProgress').DataTable(); if (dt.ajax && dt.ajax.url()) { dt.ajax.reload(null, false); return; } } catch(e) {} }
            var b = document.querySelector('button.refresh,button[title="Refresh"],.refreshBtn,input[type="submit"][value="Search"],#searchButton,[data-action="refresh"]');
            if (b) { b.click(); return; }
            if (window.jQuery) { try { window.jQuery('#cptsLoadInProgress').DataTable().draw(false); return; } catch(e) {} }
            window.location.reload();
        }

        function scr() {
            var tbl = document.getElementById('cptsLoadInProgress');
            if (!tbl || !tbl.tBodies[0]) return;
            var rows = tbl.tBodies[0].rows;
            if (!rows.length || (rows.length === 1 && rows[0].textContent.indexOf('oading') !== -1)) return;
            if (window.jQuery) { try { var dt = window.jQuery('#cptsLoadInProgress').DataTable(), inf = dt.page.info(); if (inf.pages > 1) { scrAll(dt, inf); return; } } catch(e) {} }
            fin(rows);
        }

        function scrAll(dt, inf) {
            var tot = inf.pages, orig = inf.page, col = [];
            (function nx(p) {
                dt.page(p).draw(false);
                setTimeout(function() {
                    var r = document.querySelectorAll('#cptsLoadInProgress tbody tr');
                    for (var i = 0, l = r.length; i < l; i++) if (r[i].cells && r[i].cells.length >= 22) col[col.length] = r[i].cloneNode(true);
                    if (p + 1 < tot) nx(p + 1); else { dt.page(orig).draw(false); fin(col); col = null; }
                }, PG_WAIT);
            })(0);
        }

        function fin(rows) {
            var d = parse(rows);
            GM_setValue('cpt_widget_data', JSON.stringify(d));
            var te = document.getElementById('sbt'), ce = document.getElementById('sbc');
            if (te) te.textContent = '\xB7 ' + new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
            if (ce) ce.textContent = '\xB7 ' + d.a.length + ' cpts';
        }

        (function wait() {
            var tbl = document.getElementById('cptsLoadInProgress');
            if (!tbl || !tbl.tBodies[0]) { setTimeout(wait, 2000); return; }
            var r = tbl.tBodies[0].rows;
            if (!r.length || (r.length === 1 && r[0].textContent.indexOf('oading') !== -1)) { setTimeout(wait, 2000); return; }
            scr();
            setInterval(scr, SCRAPE);
            setInterval(function() { rfr(); setTimeout(scr, 5000); }, DATA_REFRESH);
        })();
        return;
    }

    // ============================================
    // MODE 2: WIDGET
    // ============================================
    var popWin = null, popI = null, fMode = 'fetch', fFail = 0;

    // Minified CSS — single allocation
    GM_addStyle('#cpt-w{position:fixed;width:420px;max-height:500px;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:999999;overflow:hidden;transform:scale('+SCALE+');transform-origin:bottom right;display:flex;flex-direction:column}#cpt-w.min .cb{display:none}#cpt-w.min .mv{display:flex}.mv{display:none}.cw{font:13px "Segoe UI",sans-serif;color:#000;background:#FFADDB;height:100%;display:flex;flex-direction:column}.ch{background:#D39ADB;padding:10px 15px;display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none;flex-shrink:0}.ch h3{margin:0;font-size:14px;color:#FFF}.cs{font-size:11px;color:#FFF}.cb{padding:10px 15px;overflow-y:auto;flex:1;min-height:0}.sec{margin-bottom:12px}.st{font-size:12px;font-weight:bold;text-transform:lowercase;margin-bottom:6px;border-bottom:1px solid #FFF;padding-bottom:4px}.cw table{width:100%;border-collapse:collapse;font-size:12px}.cw th{text-align:left;padding:4px 6px;background:#C99DC7;color:#FFF;font-weight:normal;font-size:11px}.cw td{padding:4px 6px;border-bottom:1px solid #D9D9FF}.cw tr:hover{background:#D9D9FF}.sm{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}.si{background:#FFF;padding:6px 12px;border-radius:6px;text-align:center}.si .n{font-size:18px;font-weight:bold;display:block}.si .lb{font-size:10px;color:#888;text-transform:lowercase}.bt{background:none;border:none;color:#FFF;font-size:16px;cursor:pointer;padding:0 5px}.bt:hover{color:#000}.ss{color:#f39c12;font-weight:bold}.sl{color:#3498db;font-weight:bold}.sd{color:#27ae60;font-weight:bold}.sr{color:#e74c3c;font-weight:bold}.sc{color:#9b59b6;font-weight:bold}.pl{display:inline-block;width:8px;height:8px;border-radius:50%;background:#27ae60;margin-right:6px;animation:p 2s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}.wn{background:#fff3cd;color:#856404;padding:4px 8px;border-radius:4px;font-size:11px;margin-bottom:8px;text-align:center}.mv{gap:12px;align-items:center;flex-wrap:wrap;padding:8px 15px;font-size:12px}.mi{display:flex;align-items:center;gap:4px}.mi .mn{font-weight:bold;font-size:14px}.mi .ml{font-size:11px;color:#555;text-transform:lowercase}.mu{font-size:10px;color:#555;margin-top:4px}.src{font-size:9px;color:#888;text-align:center;margin-top:6px}.al{background:#e74c3c;color:#FFF;padding:6px 10px;border-radius:6px;margin-bottom:8px;font-size:11px;animation:f 1s infinite}.ali{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.2)}.ali:last-child{border-bottom:none}.alt{font-weight:bold;font-size:12px;margin-bottom:4px}.aln{font-weight:bold}.ald{font-size:10px;opacity:.9}@keyframes f{0%,100%{opacity:1}50%{opacity:.85}}.mal{background:#e74c3c;color:#FFF;padding:4px 8px;border-radius:4px;font-size:10px;margin-top:4px;animation:f 1s infinite}.snp{transition:top .25s,left .25s,right .25s,bottom .25s}');

    // HTML templates
    var TBL = '<div id="wa"></div><div id="ww"></div><div class="sm"><div class="si"><span class="n" id="cs">-</span><span class="lb">staged</span></div><div class="si"><span class="n" id="cl">-</span><span class="lb">loading</span></div><div class="si"><span class="n" id="cd">-</span><span class="lb">loaded</span></div><div class="si"><span class="n sr" id="ct">-</span><span class="lb">late</span></div></div><div class="sec"><div class="st">currently staged on floor</div><table><thead><tr><th>lane</th><th>pkgs</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="ts"><tr><td colspan="5">fetching data...</td></tr></tbody></table></div><div class="sec"><div class="st">loading into trucks</div><table><thead><tr><th>lane</th><th>loaded</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tl"><tr><td colspan="5">fetching data...</td></tr></tbody></table></div><div class="sec"><div class="st">all active cpts</div><table><thead><tr><th>lane</th><th>total</th><th>in fac</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="ta"><tr><td colspan="6">fetching data...</td></tr></tbody></table></div><div class="src" id="src"></div>';

    var IHTML = '<div class="ch" id="ch"><h3>outbound dock :3 - live</h3><div><span class="cs" id="cst">starting up...</span><button class="bt" id="bp" title="pop out">\u29C9</button><button class="bt" id="bm">\u2014</button></div></div><div class="mv" id="mv"><div class="mi"><span class="mn ss" id="ms">-</span><span class="ml">staged</span></div><div class="mi"><span class="mn sl" id="ml">-</span><span class="ml">loading</span></div><div class="mi"><span class="mn sd" id="md">-</span><span class="ml">loaded</span></div><div class="mi"><span class="mn sr" id="mt">-</span><span class="ml">late</span></div><div class="mu" id="mu">\u2014</div><div id="ma"></div></div><div class="cb" id="cb">' + TBL + '</div>';

    // Drag
    function initDrag(w) {
        var hd = w.querySelector('#ch'), drag = false, moved = false, sx, sy, sl, st2;
        hd.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            drag = true; moved = false; sx = e.clientX; sy = e.clientY;
            var r = w.getBoundingClientRect(); sl = r.left; st2 = r.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!drag) return;
            var dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved) { if (dx*dx+dy*dy < 16) return; moved = true; w.classList.remove('snp'); w.style.right='auto'; w.style.bottom='auto'; w.style.left=sl+'px'; w.style.top=st2+'px'; }
            w.style.left = (sl+dx)+'px'; w.style.top = (st2+dy)+'px';
        });
        document.addEventListener('mouseup', function() { if (!drag) return; drag = false; if (moved) snp(w); });
    }

    function snp(w) {
        var r = w.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
        var isR = (r.left+r.width/2) > vw/2, isB = (r.top+r.height/2) > vh/2;
        w.classList.add('snp'); w.style.top=''; w.style.bottom=''; w.style.left=''; w.style.right='';
        if (isB) w.style.bottom=SNAP_M+'px'; else w.style.top=SNAP_M+'px';
        if (isR) w.style.right=SNAP_M+'px'; else w.style.left=SNAP_M+'px';
        w.style.transformOrigin = (isB?'bottom':'top')+' '+(isR?'right':'left');
        GM_setValue('cpt_widget_corner',(isB?'bottom':'top')+'-'+(isR?'right':'left'));
        setTimeout(function(){w.classList.remove('snp');},300);
    }

    function aPos(w) {
        var c = GM_getValue('cpt_widget_corner','bottom-right');
        w.style.top='';w.style.bottom='';w.style.left='';w.style.right='';
        if (c.indexOf('bottom')!==-1) w.style.bottom=SNAP_M+'px'; else w.style.top=SNAP_M+'px';
        if (c.indexOf('right')!==-1) w.style.right=SNAP_M+'px'; else w.style.left=SNAP_M+'px';
        w.style.transformOrigin=c.replace('-',' ');
    }

    // Minimize
    function aMin(v) {
        var w = document.getElementById('cpt-w'); if (!w) return;
        var b = w.querySelector('#bm');
        if (v) { w.classList.add('min'); if (b) b.textContent='\u25A2'; }
        else { w.classList.remove('min'); if (b) b.textContent='\u2014'; }
    }

    GM_addValueChangeListener('cpt_widget_minimized',function(n,o,v,r){if(r) aMin(v);});
    GM_addValueChangeListener('cpt_widget_data',function(n,o,v,r){if(r) upd();});
    GM_addValueChangeListener('cpt_widget_popped',function(n,o,v,r){if(r){var w=document.getElementById('cpt-w');if(w) w.style.display=v?'none':'';}});
    GM_addValueChangeListener('cpt_view_open',function(n,o,v){if(v){cWarn();fMode='fetch';fFail=0;}});

    function cWarn() {
        var e = document.getElementById('ww'); if (e && e.innerHTML) e.innerHTML='';
        if (popWin&&!popWin.closed){var p=popWin.document.getElementById('ww');if(p&&p.innerHTML) p.innerHTML='';}
    }

    // Create widget
    function create() {
        var w = document.createElement('div');
        w.id='cpt-w'; w.className='cw'; w.innerHTML=IHTML;
        document.body.appendChild(w);
        aPos(w); aZoom(); aMin(GM_getValue('cpt_widget_minimized',false)); initDrag(w);
        if (GM_getValue('cpt_widget_popped',false)) w.style.display='none';

        w.querySelector('#bm').onclick=function(e){e.stopPropagation();var m=!w.classList.contains('min');aMin(m);GM_setValue('cpt_widget_minimized',m);};
        w.querySelector('#ch').addEventListener('click',function(e){if(e.target.tagName==='BUTTON'||e.target.closest('button'))return;var m=!w.classList.contains('min');aMin(m);GM_setValue('cpt_widget_minimized',m);});
        w.querySelector('#bp').onclick=function(e){e.stopPropagation();pop();};
        window.addEventListener('resize',aZoom);
    }

    function aZoom(){var w=document.getElementById('cpt-w');if(w) w.style.transform='scale('+(SCALE/(Math.round(devicePixelRatio*100)/100))+')';}

    // Pop-out
    function pop() {
        if (popWin&&!popWin.closed) popWin.close();
        if (popI) {clearInterval(popI);popI=null;}
        var pw=470,ph=650;
        popWin=window.open('about:blank','CPT_Widget_Pop','width='+pw+',height='+ph+',top='+((screen.height-ph)/2|0)+',left='+((screen.width-pw)/2|0)+',scrollbars=yes,menubar=no,toolbar=no,location=no,status=no');
        if (!popWin){alert('Pop-up blocked!');return;}
        popWin.document.open();
        popWin.document.write('<!DOCTYPE html><html><head><title>outbound dock :3</title><style>*{box-sizing:border-box;margin:0;padding:0}html,body{background:#FFADDB;overflow-y:auto;overflow-x:hidden}.cw{font:13px "Segoe UI",sans-serif;color:#000;background:#FFADDB}.ch{background:#D39ADB;padding:10px 15px;display:flex;justify-content:space-between;align-items:center;cursor:default;position:sticky;top:0;z-index:10;flex-shrink:0}.ch h3{margin:0;font-size:14px;color:#FFF}.cs{font-size:11px;color:#FFF}.cb{padding:10px 15px;overflow:visible}.sec{margin-bottom:12px}.st{font-size:12px;font-weight:bold;text-transform:lowercase;margin-bottom:6px;border-bottom:1px solid #FFF;padding-bottom:4px}.cw table{width:100%;border-collapse:collapse;font-size:12px}.cw th{text-align:left;padding:4px 6px;background:#C99DC7;color:#FFF;font-weight:normal;font-size:11px}.cw td{padding:4px 6px;border-bottom:1px solid #D9D9FF}.cw tr:hover{background:#D9D9FF}.sm{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}.si{background:#FFF;padding:6px 12px;border-radius:6px;text-align:center;flex:1;min-width:60px}.si .n{font-size:18px;font-weight:bold;display:block}.si .lb{font-size:10px;color:#888;text-transform:lowercase}.bt{background:none;border:none;color:#FFF;font-size:16px;cursor:pointer;padding:0 5px}.bt:hover{color:#000}.ss{color:#f39c12;font-weight:bold}.sl{color:#3498db;font-weight:bold}.sd{color:#27ae60;font-weight:bold}.sr{color:#e74c3c;font-weight:bold}.sc{color:#9b59b6;font-weight:bold}.pl{display:inline-block;width:8px;height:8px;border-radius:50%;background:#27ae60;margin-right:6px;animation:p 2s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}.wn{background:#fff3cd;color:#856404;padding:4px 8px;border-radius:4px;font-size:11px;margin-bottom:8px;text-align:center}.src{font-size:9px;color:#888;text-align:center;margin-top:6px}.al{background:#e74c3c;color:#FFF;padding:6px 10px;border-radius:6px;margin-bottom:8px;font-size:11px;animation:f 1s infinite}.ali{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.2)}.ali:last-child{border-bottom:none}.alt{font-weight:bold;font-size:12px;margin-bottom:4px}.aln{font-weight:bold}.ald{font-size:10px;opacity:.9}@keyframes f{0%,100%{opacity:1}50%{opacity:.85}}</style></head><body><div class="cw"><div class="ch"><h3>outbound dock :3 - live</h3><div><span class="cs" id="cst">starting up...</span><button class="bt" id="dk" title="dock back">\u29C9</button></div></div><div class="cb" id="cb">'+TBL+'</div></div></body></html>');
        popWin.document.close();
        popWin.document.getElementById('dk').onclick=dock;
        GM_setValue('cpt_widget_popped',true);
        var iw=document.getElementById('cpt-w');if(iw) iw.style.display='none';

        var chk=setInterval(function(){
            if(!popWin||popWin.closed){clearInterval(chk);if(popI){clearInterval(popI);popI=null;}popWin=null;GM_setValue('cpt_widget_popped',false);var w2=document.getElementById('cpt-w');if(w2) w2.style.display='';}
        },500);

        rend(popWin.document);
        popI=setInterval(function(){if(popWin&&!popWin.closed) rend(popWin.document); else{clearInterval(popI);popI=null;}},REFRESH);
    }

    function dock(){if(popI){clearInterval(popI);popI=null;}if(popWin&&!popWin.closed) popWin.close();popWin=null;GM_setValue('cpt_widget_popped',false);var w=document.getElementById('cpt-w');if(w) w.style.display='';upd();}

    // Fetch
    function fetch2() {
        GM_xmlhttpRequest({method:'GET',url:URL,timeout:TIMEOUT,headers:{'Accept':'text/html','Cache-Control':'no-cache'},
            onload:function(r){
                if(r.status===200){var d=pHTML(r.responseText);if(d&&d.a.length){fMode='fetch';fFail=0;cWarn();GM_setValue('cpt_widget_data',JSON.stringify(d));}else fail();}
                else if(r.status===401||r.status===403) fail(1); else fail();
            },onerror:fail,ontimeout:fail});
    }

    function pHTML(h) {
        try {
            var i=h.indexOf('id="cptsLoadInProgress"');if(i===-1)return null;
            var s=h.lastIndexOf('<table',i),e=h.indexOf('</table>',i);if(s===-1||e===-1)return null;
            var tmp=document.createElement('div');tmp.innerHTML=h.substring(s,e+8);
            var tbl=tmp.firstElementChild;if(!tbl||!tbl.tBodies[0])return null;
            var rows=tbl.tBodies[0].rows;if(!rows.length||(rows.length===1&&rows[0].cells&&rows[0].cells.length<22))return null;
            var res=parse(rows);tmp.innerHTML='';tmp=null;return res;
        }catch(e){return null;}
    }

    function fail(auth) {
        fFail++;
        if(fFail>=3&&!GM_getValue('cpt_view_open',false)){
            fMode='tab';
            var msg=auth?'\u26A0\uFE0F session expired \u2014 <a href="'+URL+'" target="_blank" style="color:#856404;font-weight:bold">open CPT View</a>':'\u26A0\uFE0F direct fetch unavailable \u2014 <a href="'+URL+'" target="_blank" style="color:#856404;font-weight:bold">open CPT View</a> in any tab';
            var w=document.getElementById('ww');if(w) w.innerHTML='<div class="wn">'+msg+'</div>';
            if(popWin&&!popWin.closed){var p=popWin.document.getElementById('ww');if(p) p.innerHTML='<div class="wn">'+msg+'</div>';}
        }
    }

    // Alerts
    function gAlerts(staged) {
        var a=[],i=staged.length;
        while(i--){var s=staged[i],m=tm(s.t);if(s.p>=ALERT_PKG&&m<=ALERT_MIN) a[a.length]={l:s.l,p:s.p,t:s.t,m:m};}
        if(a.length>1) a.sort(function(x,y){return x.m-y.m;});
        return a;
    }

    // Render
    function rend(d) {
        var raw=GM_getValue('cpt_widget_data',null);if(!raw)return;
        var data;try{data=JSON.parse(raw);}catch(e){return;}
        var staged=data.s,loading=data.g,loaded=data.d,all=data.a,tst=data.ts;
        var lt=0,i=all.length;while(i--) if(late(all[i].t)) lt++;

        var cs=d.getElementById('cs');if(!cs)return;
        cs.textContent=staged.length;
        d.getElementById('cl').textContent=loading.length;
        d.getElementById('cd').textContent=loaded.length;
        d.getElementById('ct').textContent=lt;

        // Alerts
        var alerts=gAlerts(staged),ae=d.getElementById('wa');
        if(ae){
            if(!alerts.length){if(ae.innerHTML) ae.innerHTML='';}
            else{B='<div class="al"><div class="alt">\u26A0 critical \u2014 staged freight at risk</div>';for(i=0;i<alerts.length;i++) B+='<div class="ali"><span class="aln">'+alerts[i].l+'</span><span class="ald">'+alerts[i].p+' pkgs \xB7 '+alerts[i].t+' left</span></div>';B+='</div>';ae.innerHTML=B;}
        }

        // Data age
        var wn=d.getElementById('ww');
        if(wn&&fMode==='fetch'){var age=(Date.now()-tst)/60000|0;if(age>2) wn.innerHTML='<div class="wn">\u26A0\uFE0F data is '+age+' min old</div>';else if(wn.innerHTML) wn.innerHTML='';}

        var now=new Date(),ts2=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

        // Staged
        var tbS=d.getElementById('ts');
        if(tbS){
            if(!staged.length) tbS.innerHTML='<tr><td colspan="5" style="color:#888">no freight staged</td></tr>';
            else{B='';for(i=0;i<staged.length;i++){var s=staged[i];B+='<tr><td>'+s.l+'</td><td>'+s.p+(s.cn>0?' (+'+s.cn+'C)':'')+'</td><td class="sc">'+(s.cp||0)+'</td><td>'+s.c+'</td><td'+(urg(s.t)?' class="sr"':'')+ '>'+s.t+'</td></tr>';}tbS.innerHTML=B;}
        }

        // Loading
        var tbL=d.getElementById('tl');
        if(tbL){
            if(!loading.length) tbL.innerHTML='<tr><td colspan="5" style="color:#888">no active loads</td></tr>';
            else{B='';for(i=0;i<loading.length;i++){var g=loading[i];B+='<tr><td>'+g.l+'</td><td>'+g.lp+' / '+g.tp+'</td><td class="sc">'+(g.cp||0)+'</td><td>'+g.c+'</td><td'+(urg(g.t)?' class="sr"':'')+ '>'+g.t+'</td></tr>';}tbL.innerHTML=B;}
        }

        // All CPTs
        var tbA=d.getElementById('ta');
        if(tbA){
            if(!all.length) tbA.innerHTML='<tr><td colspan="6" style="color:#888">no data</td></tr>';
            else{all.sort(function(a,b){return tm(a.t)-tm(b.t);});B='';for(i=0;i<all.length;i++){var c=all[i];B+='<tr><td>'+c.l+'</td><td>'+c.tp+'</td><td>'+c.if+'</td><td class="sc">'+(c.cp||0)+'</td><td>'+c.c+'</td><td'+(urg(c.t)?' class="sr"':'')+ '>'+c.t+'</td></tr>';}tbA.innerHTML=B;}
        }

        var st=d.getElementById('cst');if(st) st.innerHTML='<span class="pl"></span>'+ts2;
        var src=d.getElementById('src');if(src) src.textContent=fMode==='fetch'?'source: direct fetch':'source: cpt view tab';
    }

    // Update
    function upd() {
        var raw=GM_getValue('cpt_widget_data',null);
        if(!raw){var st=document.getElementById('cst');if(st) st.innerHTML='<span style="color:#f39c12">\u25CF fetching...</span>';return;}
        var data;try{data=JSON.parse(raw);}catch(e){return;}

        rend(document);

        // Mini
        var ms=document.getElementById('ms');
        if(ms){var lt=0,i=data.a.length;while(i--) if(late(data.a[i].t)) lt++;
            ms.textContent=data.s.length;document.getElementById('ml').textContent=data.g.length;
            document.getElementById('md').textContent=data.d.length;document.getElementById('mt').textContent=lt;
        }
        var mu=document.getElementById('mu');
        if(mu) mu.innerHTML='<span class="pl"></span>updated '+new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

        // Mini alerts
        var alerts=gAlerts(data.s),ma=document.getElementById('ma');
        if(ma){
            if(!alerts.length){if(ma.innerHTML) ma.innerHTML='';}
            else{B='<div class="mal">\u26A0 ';for(var j=0;j<alerts.length;j++){if(j) B+=' \xB7 ';B+=alerts[j].l+' ('+alerts[j].p+'pkg/'+alerts[j].t+')';}B+='</div>';ma.innerHTML=B;}
        }

        if(popWin&&!popWin.closed) rend(popWin.document);
    }

    // Init
    function init(){create();upd();fetch2();setInterval(function(){if(fMode==='fetch') fetch2();},SCRAPE);setInterval(upd,REFRESH);}
    if(document.readyState==='complete') init(); else window.addEventListener('load',init);
})();

