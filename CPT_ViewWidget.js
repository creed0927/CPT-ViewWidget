
// ==UserScript==
// @name         CPT View Live Widget - OB Dock
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  Memory & power optimized — visibility-aware, no background CPU waste
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
// @connect      trans-logistics.amazon.com
// @connect      *.amazon.com
// ==/UserScript==

(function() {
    'use strict';

    if (window.name === 'CPT_Widget_Pop') return;

    // ============================================
    // SETTINGS
    // ============================================
    var DEFAULTS = {theme:'pink',scale:1.04,alertPkg:130,alertMin:20,refreshRate:10000,scrapeRate:15000,dataRefresh:60000};
    var THEMES = {
        pink:{bg:'#FFADDB',hd:'#D39ADB',th:'#C99DC7',ac:'#FFF',dk:0},
        dark:{bg:'#1e1e2e',hd:'#2d2d44',th:'#3d3d5c',ac:'#cdd6f4',dk:1},
        ocean:{bg:'#e0f7fa',hd:'#00838f',th:'#00695c',ac:'#fff',dk:0},
        sunset:{bg:'#fff3e0',hd:'#e65100',th:'#bf360c',ac:'#fff',dk:0},
        forest:{bg:'#e8f5e9',hd:'#2e7d32',th:'#1b5e20',ac:'#fff',dk:0},
        midnight:{bg:'#0d1117',hd:'#161b22',th:'#21262d',ac:'#c9d1d9',dk:1},
        lavender:{bg:'#f3e5f5',hd:'#7b1fa2',th:'#6a1b9a',ac:'#fff',dk:0}
    };

    function getS(){var s=GM_getValue('cpt_ws',null);if(s){try{return JSON.parse(s);}catch(e){}}return DEFAULTS;}
    function setS(s){GM_setValue('cpt_ws',JSON.stringify(s));}
    var S=getS(),T=THEMES[S.theme]||THEMES.pink;
    var URL='https://trans-logistics.amazon.com/ssp/dock/hrz/cpt';

    // Shared helpers (minimal footprint)
    var RH=/(\d+)\s*hr/,RM=/(\d+)\s*min/,RN=/(\d+)/;
    function tm(t){if(!t)return 99999;var h=RH.exec(t),m=RM.exec(t);return((h?+h[1]:0)*60)+(m?+m[1]:0);}
    function late(t){return t&&(t.charCodeAt(0)===45||t.indexOf('late')!==-1||tm(t)<=0);}
    function urg(t){return tm(t)<=120;}
    function ec(c){if(!c)return 0;var a=c.firstElementChild;if(a&&a.tagName==='A')return+a.textContent||0;var m=RN.exec(c.textContent);return m?+m[1]:0;}

    function parse(rows){
        var st=[],ld=[],dd=[],all=[],i=0,len=rows.length,cs,c2,sp,ln,ai,a2,dest,tl,cpt,lip,tot,inf,conP,stP,stC,ldP,ldC;
        for(;i<len;i++){
            cs=rows[i].cells;if(!cs||cs.length<22)continue;
            c2=cs[2];sp=c2.getElementsByTagName('span')[0];
            ln=sp?sp.textContent:c2.textContent;
            ai=ln.indexOf('->');a2=ln.indexOf('\u2192');
            dest=ai!==-1?ln.substring(ai+2).trim():a2!==-1?ln.substring(a2+1).trim():ln.trim();
            tl=cs[1].textContent.trim();cpt=cs[0].textContent.trim();
            lip=ec(cs[4]);tot=ec(cs[8]);inf=ec(cs[12]);
            conP=ec(cs[16]);stP=ec(cs[18]);stC=ec(cs[19]);ldP=ec(cs[20]);ldC=ec(cs[21]);
            all.push({l:dest,c:cpt,t:tl,tp:tot,if:inf,cp:conP,sp:stP,lp:ldP,li:lip});
            if(stP>0||stC>0)st.push({l:dest,p:stP,cn:stC,cp:conP,c:cpt,t:tl});
            if(lip>0)ld.push({l:dest,lp:ldP,tp:tot,cp:conP,c:cpt,t:tl});
            if(ldP>0||ldC>0)dd.push({l:dest,p:ldP,cn:ldC,c:cpt,t:tl});
        }
        return{s:st,g:ld,d:dd,a:all,ts:Date.now()};
    }

    // Orphan check
    if(GM_getValue('cpt_widget_popped',false)&&Date.now()-GM_getValue('cpt_widget_pop_heartbeat',0)>5000)GM_setValue('cpt_widget_popped',false);

    // ============================================
    // MODE 1: CPT VIEW SCRAPER (on CPT View page)
    // ============================================
    if(window.location.href.indexOf('trans-logistics.amazon.com/ssp/dock')!==-1){
        GM_setValue('cpt_view_open',true);
        window.addEventListener('beforeunload',function(){GM_setValue('cpt_view_open',false);});

        GM_addStyle('#cpt-sb{position:fixed;bottom:10px;right:10px;background:'+T.hd+';color:'+T.ac+';padding:8px 14px;border-radius:20px;font:11px "Segoe UI",sans-serif;z-index:999999;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;gap:8px}.sbd{width:8px;height:8px;border-radius:50%;background:#27ae60;animation:sp 2s infinite}@keyframes sp{0%,100%{opacity:1}50%{opacity:.4}}.sbt{font-size:9px;opacity:.8}');
        var badge=document.createElement('div');badge.id='cpt-sb';
        badge.innerHTML='<span class="sbd"></span><span>widget syncing</span><span class="sbt" id="sbt"></span><span class="sbt" id="sbc"></span>';
        document.body.appendChild(badge);

        var scrTimer=null,rfrTimer=null;

        function rfr(){
            if(window.jQuery){try{var dt=window.jQuery('#cptsLoadInProgress').DataTable();if(dt.ajax&&dt.ajax.url()){dt.ajax.reload(null,false);return;}}catch(e){}}
            var b=document.querySelector('button.refresh,button[title="Refresh"],.refreshBtn,#searchButton,[data-action="refresh"]');
            if(b){b.click();return;}
            if(window.jQuery){try{window.jQuery('#cptsLoadInProgress').DataTable().draw(false);return;}catch(e){}}
            window.location.reload();
        }

        function scr(){
            var tbl=document.getElementById('cptsLoadInProgress');
            if(!tbl||!tbl.tBodies[0])return;
            var rows=tbl.tBodies[0].rows;
            if(!rows.length||(rows.length===1&&rows[0].textContent.indexOf('oading')!==-1))return;
            if(window.jQuery){try{var dt=window.jQuery('#cptsLoadInProgress').DataTable(),inf=dt.page.info();if(inf.pages>1){scrAll(dt,inf);return;}}catch(e){}}
            fin(rows);
        }

        function scrAll(dt,inf){
            var tot=inf.pages,orig=inf.page,col=[];
            (function nx(p){
                dt.page(p).draw(false);
                setTimeout(function(){
                    var r=document.querySelectorAll('#cptsLoadInProgress tbody tr');
                    for(var i=0,l=r.length;i<l;i++)if(r[i].cells&&r[i].cells.length>=22)col.push(r[i].cloneNode(true));
                    if(p+1<tot)nx(p+1);else{dt.page(orig).draw(false);fin(col);col=null;}
                },800);
            })(0);
        }

        function fin(rows){
            var d=parse(rows);
            GM_setValue('cpt_widget_data',JSON.stringify(d));
            var te=document.getElementById('sbt'),ce=document.getElementById('sbc');
            if(te)te.textContent='\xB7 '+new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
            if(ce)ce.textContent='\xB7 '+d.a.length+' cpts';
        }

        // Visibility-aware scraping — pause when tab hidden
        function startScraping(){
            if(scrTimer)return;
            scrTimer=setInterval(scr,S.scrapeRate);
            rfrTimer=setInterval(function(){rfr();setTimeout(scr,5000);},S.dataRefresh);
        }
        function stopScraping(){
            if(scrTimer){clearInterval(scrTimer);scrTimer=null;}
            if(rfrTimer){clearInterval(rfrTimer);rfrTimer=null;}
        }

        document.addEventListener('visibilitychange',function(){
            if(document.hidden)stopScraping();else{scr();startScraping();}
        });

        (function wait(){
            var tbl=document.getElementById('cptsLoadInProgress');
            if(!tbl||!tbl.tBodies[0]){setTimeout(wait,2000);return;}
            var r=tbl.tBodies[0].rows;
            if(!r.length||(r.length===1&&r[0].textContent.indexOf('oading')!==-1)){setTimeout(wait,2000);return;}
            scr();startScraping();
        })();
        return;
    }

    // ============================================
    // MODE 2: WIDGET (on all other pages)
    // ============================================
    var popWin=null,popI=null,updTimer=null,monTimer=null;
    var isVisible=!document.hidden;

    // Minimal CSS builder
    function css(){
        var d=T.dk,bg2=d?'#2a2a3e':'#FFF',fg=d?T.ac:'#000',bd=d?'#333':'#D9D9FF',hv=d?'#2a2a3e':'#D9D9FF';
        return '#cpt-w{position:fixed;width:420px;max-height:500px;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:999999;overflow:hidden;transform:scale('+S.scale+');transform-origin:bottom right;display:flex;flex-direction:column}#cpt-w.min{max-height:none;height:auto}#cpt-w.min .cb{display:none}#cpt-w.min .mv{display:flex}.mv{display:none}.cw{font:13px "Segoe UI",sans-serif;color:'+fg+';background:'+T.bg+';display:flex;flex-direction:column;height:100%}.ch{background:'+T.hd+';padding:10px 15px;display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none;flex-shrink:0}.ch h3{margin:0;font-size:14px;color:'+T.ac+'}.cs{font-size:11px;color:'+T.ac+'}.cb{padding:10px 15px;overflow-y:auto;flex:1;min-height:0}.sec{margin-bottom:12px}.st{font-size:12px;font-weight:bold;text-transform:lowercase;margin-bottom:6px;border-bottom:1px solid '+T.ac+';padding-bottom:4px;opacity:.8}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;padding:4px 6px;background:'+T.th+';color:'+T.ac+';font-weight:normal;font-size:11px}td{padding:4px 6px;border-bottom:1px solid '+bd+'}tr:hover{background:'+hv+'}.sm{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}.si{background:'+bg2+';padding:6px 12px;border-radius:6px;text-align:center}.si .n{font-size:18px;font-weight:bold;display:block}.si .lb{font-size:10px;color:#888;text-transform:lowercase}.bt{background:none;border:none;color:'+T.ac+';font-size:16px;cursor:pointer;padding:0 5px}.bt:hover{opacity:.7}.ss{color:#f39c12;font-weight:bold}.sl{color:#3498db;font-weight:bold}.sd{color:#27ae60;font-weight:bold}.sr{color:#e74c3c;font-weight:bold}.sc{color:#9b59b6;font-weight:bold}.pl{display:inline-block;width:8px;height:8px;border-radius:50%;background:#27ae60;margin-right:6px;animation:p 2s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}.wn{background:#fff3cd;color:#856404;padding:4px 8px;border-radius:4px;font-size:11px;margin-bottom:8px;text-align:center}.mv{gap:12px;align-items:center;flex-wrap:wrap;padding:8px 15px;font-size:12px}.mi{display:flex;align-items:center;gap:4px}.mi .mn{font-weight:bold;font-size:14px}.mi .ml{font-size:11px;color:#888;text-transform:lowercase}.mu{font-size:10px;color:#888;margin-left:auto}.src{font-size:9px;color:#888;text-align:center;margin-top:6px}.al{background:#e74c3c;color:#FFF;padding:6px 10px;border-radius:6px;margin-bottom:8px;font-size:11px;animation:f 1s infinite}.ali{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.2)}.ali:last-child{border-bottom:none}.alt{font-weight:bold;font-size:12px;margin-bottom:4px}.aln{font-weight:bold}.ald{font-size:10px;opacity:.9}@keyframes f{0%,100%{opacity:1}50%{opacity:.85}}.mal{background:#e74c3c;color:#FFF;padding:4px 8px;border-radius:4px;font-size:10px;margin-top:4px;animation:f 1s infinite}.snp{transition:top .25s,left .25s,right .25s,bottom .25s}'+
        '#cpt-tb{position:fixed;bottom:15px;right:15px;width:42px;height:42px;border-radius:50%;background:'+T.hd+';color:'+T.ac+';border:none;box-shadow:0 4px 12px rgba(0,0,0,.4);z-index:999999;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;transition:transform .2s}#cpt-tb:hover{transform:scale(1.1)}'+
        '#cpt-sp{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:360px;max-height:80vh;background:'+(d?'#1e1e2e':'#fff')+';color:'+(d?'#cdd6f4':'#333')+';border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.5);z-index:9999999;overflow-y:auto;font:13px "Segoe UI",sans-serif}#cpt-sp .sp-h{background:'+T.hd+';color:'+T.ac+';padding:12px 18px;display:flex;justify-content:space-between;align-items:center;border-radius:12px 12px 0 0}#cpt-sp .sp-h h3{margin:0;font-size:15px}#cpt-sp .sp-b{padding:18px}#cpt-sp .sp-row{margin-bottom:14px}#cpt-sp .sp-row label{display:block;font-size:11px;font-weight:bold;text-transform:uppercase;margin-bottom:5px;opacity:.7}#cpt-sp .sp-row select,#cpt-sp .sp-row input{width:100%;padding:8px 10px;border:1px solid '+(d?'#444':'#ddd')+';border-radius:6px;font-size:13px;background:'+(d?'#2a2a3e':'#f9f9f9')+';color:inherit}#cpt-sp .sp-themes{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}#cpt-sp .sp-th{width:100%;aspect-ratio:1;border-radius:8px;border:3px solid transparent;cursor:pointer;position:relative;transition:border-color .2s}#cpt-sp .sp-th.active{border-color:'+T.hd+'}#cpt-sp .sp-th::after{content:attr(data-name);position:absolute;bottom:2px;left:0;right:0;text-align:center;font-size:9px;color:#666}#cpt-sp .sp-save{width:100%;padding:10px;background:'+T.hd+';color:'+T.ac+';border:none;border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;margin-top:8px}#cpt-sp .sp-save:hover{opacity:.9}#cpt-sp .sp-val{font-size:11px;color:#888;text-align:right}#cpt-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:9999998}';
    }

    var styleEl=GM_addStyle(css());

    var TBL='<div id="wa"></div><div id="ww"></div><div class="sm"><div class="si"><span class="n" id="cs">-</span><span class="lb">staged</span></div><div class="si"><span class="n" id="cl">-</span><span class="lb">loading</span></div><div class="si"><span class="n" id="cd">-</span><span class="lb">loaded</span></div><div class="si"><span class="n sr" id="ct">-</span><span class="lb">late</span></div></div><div class="sec"><div class="st">currently staged on floor</div><table><thead><tr><th>lane</th><th>pkgs</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="ts"><tr><td colspan="5">fetching data...</td></tr></tbody></table></div><div class="sec"><div class="st">loading into trucks</div><table><thead><tr><th>lane</th><th>loaded</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="tl"><tr><td colspan="5">fetching data...</td></tr></tbody></table></div><div class="sec"><div class="st">all active cpts</div><table><thead><tr><th>lane</th><th>total</th><th>in fac</th><th>cont.</th><th>cpt</th><th>time left</th></tr></thead><tbody id="ta"><tr><td colspan="6">fetching data...</td></tr></tbody></table></div><div class="src" id="src"></div>';

    var IHTML='<div class="ch" id="ch"><h3>outbound dock :3 - live</h3><div><span class="cs" id="cst">starting up...</span><button class="bt" id="bset" title="settings">\u2699</button><button class="bt" id="bp" title="pop out">\u29C9</button><button class="bt" id="bm" title="minimize">\u2014</button><button class="bt" id="bx" title="close to toolbar">\u2715</button></div></div><div class="mv" id="mv"><div class="mi"><span class="mn ss" id="ms">-</span><span class="ml">staged</span></div><div class="mi"><span class="mn sl" id="ml">-</span><span class="ml">loading</span></div><div class="mi"><span class="mn sd" id="md">-</span><span class="ml">loaded</span></div><div class="mi"><span class="mn sr" id="mt">-</span><span class="ml">late</span></div><div class="mu" id="mu">\u2014</div><div id="ma"></div></div><div class="cb" id="cb">'+TBL+'</div>';

    // ============================================
    // SETTINGS PANEL (created on demand only)
    // ============================================
    function openSettings(){
        if(document.getElementById('cpt-sp'))return;
        var ov=document.createElement('div');ov.id='cpt-overlay';document.body.appendChild(ov);
        var p=document.createElement('div');p.id='cpt-sp';
        var tg='';for(var k in THEMES){var th=THEMES[k];tg+='<div class="sp-th'+(S.theme===k?' active':'')+'" data-theme="'+k+'" data-name="'+k+'" style="background:linear-gradient(135deg,'+th.hd+' 50%,'+th.bg+' 50%)"></div>';}
        p.innerHTML='<div class="sp-h"><h3>\u2699 settings</h3><button class="bt" id="sp-close">\u2715</button></div><div class="sp-b"><div class="sp-row"><label>theme</label><div class="sp-themes">'+tg+'</div></div><div class="sp-row"><label>scale</label><input type="range" id="sp-scale" min="0.6" max="1.5" step="0.02" value="'+S.scale+'"><div class="sp-val" id="sp-sv">'+Math.round(S.scale*100)+'%</div></div><div class="sp-row"><label>alert pkgs threshold</label><input type="number" id="sp-ap" value="'+S.alertPkg+'" min="10" max="1000"></div><div class="sp-row"><label>alert minutes threshold</label><input type="number" id="sp-am" value="'+S.alertMin+'" min="1" max="120"></div><div class="sp-row"><label>refresh rate (sec)</label><input type="number" id="sp-rr" value="'+(S.refreshRate/1000)+'" min="3" max="60"></div><div class="sp-row"><label>scrape interval (sec)</label><input type="number" id="sp-si" value="'+(S.scrapeRate/1000)+'" min="5" max="120"></div><button class="sp-save" id="sp-sv2">save & apply</button></div>';
        document.body.appendChild(p);
        var ths=p.querySelectorAll('.sp-th');for(var i=0;i<ths.length;i++)ths[i].onclick=function(){var a=p.querySelectorAll('.sp-th');for(var j=0;j<a.length;j++)a[j].classList.remove('active');this.classList.add('active');};
        var sl=p.querySelector('#sp-scale'),sv=p.querySelector('#sp-sv');
        sl.oninput=function(){sv.textContent=Math.round(this.value*100)+'%';};
        function cl(){p.remove();ov.remove();}
        p.querySelector('#sp-close').onclick=cl;ov.onclick=cl;
        p.querySelector('#sp-sv2').onclick=function(){
            var at=p.querySelector('.sp-th.active');
            S.theme=at?at.getAttribute('data-theme'):S.theme;
            S.scale=parseFloat(sl.value);S.alertPkg=parseInt(p.querySelector('#sp-ap').value)||130;
            S.alertMin=parseInt(p.querySelector('#sp-am').value)||20;
            S.refreshRate=(parseInt(p.querySelector('#sp-rr').value)||10)*1000;
            S.scrapeRate=(parseInt(p.querySelector('#sp-si').value)||15)*1000;
            setS(S);cl();T=THEMES[S.theme]||THEMES.pink;
            if(styleEl&&styleEl.parentNode)styleEl.parentNode.removeChild(styleEl);
            styleEl=GM_addStyle(css());aZoom();
        };
    }

    GM_registerMenuCommand('CPT Widget Settings',openSettings);
    GM_registerMenuCommand('Show CPT Widget',showWidget);

    // Toolbar
    function createTB(){var b=document.createElement('button');b.id='cpt-tb';b.textContent='\u25A3';b.title='Open CPT Widget';b.onclick=showWidget;document.body.appendChild(b);}
    function showWidget(){var w=document.getElementById('cpt-w'),tb=document.getElementById('cpt-tb');if(w)w.style.display='';if(tb)tb.style.display='none';GM_setValue('cpt_widget_closed',false);}
    function closeTB(){var w=document.getElementById('cpt-w'),tb=document.getElementById('cpt-tb');if(w)w.style.display='none';if(tb)tb.style.display='flex';GM_setValue('cpt_widget_closed',true);}

    GM_addValueChangeListener('cpt_widget_closed',function(n,o,v,r){if(r){var w=document.getElementById('cpt-w'),tb=document.getElementById('cpt-tb');if(v){if(w)w.style.display='none';if(tb)tb.style.display='flex';}else{if(w)w.style.display='';if(tb)tb.style.display='none';}}});

    // Drag (reuses single listeners)
    var dState={on:false,moved:false,sx:0,sy:0,sl:0,st:0,w:null};
    function initDrag(w){
        dState.w=w;
        w.querySelector('#ch').addEventListener('mousedown',function(e){
            if(e.target.tagName==='BUTTON'||e.target.closest('button'))return;
            dState.on=true;dState.moved=false;dState.sx=e.clientX;dState.sy=e.clientY;
            var r=w.getBoundingClientRect();dState.sl=r.left;dState.st=r.top;e.preventDefault();
        });
    }
    document.addEventListener('mousemove',function(e){
        if(!dState.on)return;var w=dState.w,dx=e.clientX-dState.sx,dy=e.clientY-dState.sy;
        if(!dState.moved){if(dx*dx+dy*dy<16)return;dState.moved=true;w.classList.remove('snp');w.style.right='auto';w.style.bottom='auto';w.style.left=dState.sl+'px';w.style.top=dState.st+'px';}
        w.style.left=(dState.sl+dx)+'px';w.style.top=(dState.st+dy)+'px';
    });
    document.addEventListener('mouseup',function(){if(!dState.on)return;dState.on=false;if(dState.moved)snap(dState.w);});

    function snap(w){
        var r=w.getBoundingClientRect(),isR=(r.left+r.width/2)>innerWidth/2,isB=(r.top+r.height/2)>innerHeight/2;
        w.classList.add('snp');w.style.top='';w.style.bottom='';w.style.left='';w.style.right='';
        if(isB)w.style.bottom='10px';else w.style.top='10px';
        if(isR)w.style.right='10px';else w.style.left='10px';
        w.style.transformOrigin=(isB?'bottom':'top')+' '+(isR?'right':'left');
        GM_setValue('cpt_wc',(isB?'bottom':'top')+'-'+(isR?'right':'left'));
        setTimeout(function(){w.classList.remove('snp');},300);
    }
    function aPos(w){var c=GM_getValue('cpt_wc','bottom-right');w.style.top='';w.style.bottom='';w.style.left='';w.style.right='';if(c.indexOf('bottom')!==-1)w.style.bottom='10px';else w.style.top='10px';if(c.indexOf('right')!==-1)w.style.right='10px';else w.style.left='10px';w.style.transformOrigin=c.replace('-',' ');}
    function aMin(v){var w=document.getElementById('cpt-w');if(!w)return;var b=w.querySelector('#bm');if(v){w.classList.add('min');if(b)b.textContent='\u25A2';}else{w.classList.remove('min');if(b)b.textContent='\u2014';}}
    function aZoom(){var w=document.getElementById('cpt-w');if(w)w.style.transform='scale('+(S.scale/(Math.round(devicePixelRatio*100)/100))+')';}

    GM_addValueChangeListener('cpt_widget_minimized',function(n,o,v,r){if(r)aMin(v);});
    GM_addValueChangeListener('cpt_widget_data',function(n,o,v,r){if(r&&isVisible)upd();});
    GM_addValueChangeListener('cpt_widget_popped',function(n,o,v,r){if(r){var w=document.getElementById('cpt-w');if(w)w.style.display=v?'none':'';}});
    GM_addValueChangeListener('cpt_view_open',function(n,o,v){if(v){var e=document.getElementById('ww');if(e&&e.innerHTML)e.innerHTML='';if(popWin&&!popWin.closed){var p=popWin.document.getElementById('ww');if(p&&p.innerHTML)p.innerHTML='';}}});

    // Auto-open CPT View (single-instance lock)
    function stale(){var r=GM_getValue('cpt_widget_data',null);if(!r)return true;try{return(Date.now()-JSON.parse(r).ts)>60000;}catch(e){return true;}}
    function alive(){return GM_getValue('cpt_view_open',false);}
    function autoOpen(){
        if(alive()||!stale())return;
        var lk=GM_getValue('cpt_aol',0);if(Date.now()-lk<30000)return;
        GM_setValue('cpt_aol',Date.now());
        setTimeout(function(){
            if(alive())return;
            GM_openInTab(URL,{active:false,insert:true,setParent:true});
            var w=document.getElementById('ww');if(w)w.innerHTML='<div class="wn">\u2139\uFE0F auto-opened CPT View in background</div>';
            var ck=setInterval(function(){if(!stale()){clearInterval(ck);var e=document.getElementById('ww');if(e&&e.innerHTML.indexOf('auto-opened')!==-1)e.innerHTML='';}},5000);
        },Math.floor(Math.random()*2000));
    }

    // ============================================
    // VISIBILITY-AWARE UPDATE LOOP
    // ============================================
    function startLoop(){
        if(updTimer)return;
        updTimer=setInterval(upd,S.refreshRate);
        monTimer=setInterval(function(){if(!alive()&&stale()){var lk=GM_getValue('cpt_aol',0);if(Date.now()-lk>30000)autoOpen();}},30000);
    }
    function stopLoop(){
        if(updTimer){clearInterval(updTimer);updTimer=null;}
        if(monTimer){clearInterval(monTimer);monTimer=null;}
    }

    document.addEventListener('visibilitychange',function(){
        isVisible=!document.hidden;
        if(isVisible){upd();startLoop();}else stopLoop();
    });

    // Create widget
    function create(){
        createTB();
        var w=document.createElement('div');w.id='cpt-w';w.className='cw';w.innerHTML=IHTML;
        document.body.appendChild(w);aPos(w);aZoom();aMin(GM_getValue('cpt_widget_minimized',false));initDrag(w);
        var cl=GM_getValue('cpt_widget_closed',false),po=GM_getValue('cpt_widget_popped',false);
        if(cl){w.style.display='none';document.getElementById('cpt-tb').style.display='flex';}
        else if(po){w.style.display='none';document.getElementById('cpt-tb').style.display='none';}
        else document.getElementById('cpt-tb').style.display='none';

        w.querySelector('#bm').onclick=function(e){e.stopPropagation();var m=!w.classList.contains('min');aMin(m);GM_setValue('cpt_widget_minimized',m);};
        w.querySelector('#ch').onclick=function(e){if(e.target.tagName==='BUTTON'||e.target.closest('button'))return;var m=!w.classList.contains('min');aMin(m);GM_setValue('cpt_widget_minimized',m);};
        w.querySelector('#bp').onclick=function(e){e.stopPropagation();pop();};
        w.querySelector('#bx').onclick=function(e){e.stopPropagation();closeTB();};
        w.querySelector('#bset').onclick=function(e){e.stopPropagation();openSettings();};
        window.addEventListener('resize',aZoom);
    }

    // Pop-out
    function pop(){
        if(popWin&&!popWin.closed)popWin.close();
        if(popI){clearInterval(popI);popI=null;}
        var pw=470,ph=650;
        popWin=window.open('about:blank','CPT_Widget_Pop','width='+pw+',height='+ph+',top='+((screen.height-ph)/2|0)+',left='+((screen.width-pw)/2|0)+',scrollbars=yes,menubar=no,toolbar=no,location=no,status=no');
        if(!popWin){alert('Pop-up blocked!');return;}
        var d=T.dk,bg2=d?'#2a2a3e':'#FFF',fg=d?T.ac:'#000',bd=d?'#333':'#D9D9FF',hv=d?'#2a2a3e':'#D9D9FF';
        var pcss='*{box-sizing:border-box;margin:0;padding:0}html,body{background:'+T.bg+';overflow-y:auto;overflow-x:hidden}.cw{font:13px "Segoe UI",sans-serif;color:'+fg+';background:'+T.bg+'}.ch{background:'+T.hd+';padding:10px 15px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10}.ch h3{margin:0;font-size:14px;color:'+T.ac+'}.cs{font-size:11px;color:'+T.ac+'}.cb{padding:10px 15px}.sec{margin-bottom:12px}.st{font-size:12px;font-weight:bold;text-transform:lowercase;margin-bottom:6px;border-bottom:1px solid '+T.ac+';padding-bottom:4px;opacity:.8}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;padding:4px 6px;background:'+T.th+';color:'+T.ac+';font-weight:normal;font-size:11px}td{padding:4px 6px;border-bottom:1px solid '+bd+'}tr:hover{background:'+hv+'}.sm{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}.si{background:'+bg2+';padding:6px 12px;border-radius:6px;text-align:center;flex:1;min-width:60px}.si .n{font-size:18px;font-weight:bold;display:block}.si .lb{font-size:10px;color:#888;text-transform:lowercase}.bt{background:none;border:none;color:'+T.ac+';font-size:16px;cursor:pointer;padding:0 5px}.bt:hover{opacity:.7}.ss{color:#f39c12;font-weight:bold}.sl{color:#3498db;font-weight:bold}.sd{color:#27ae60;font-weight:bold}.sr{color:#e74c3c;font-weight:bold}.sc{color:#9b59b6;font-weight:bold}.pl{display:inline-block;width:8px;height:8px;border-radius:50%;background:#27ae60;margin-right:6px;animation:p 2s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}.wn{background:#fff3cd;color:#856404;padding:4px 8px;border-radius:4px;font-size:11px;margin-bottom:8px;text-align:center}.src{font-size:9px;color:#888;text-align:center;margin-top:6px}.al{background:#e74c3c;color:#FFF;padding:6px 10px;border-radius:6px;margin-bottom:8px;font-size:11px;animation:f 1s infinite}.ali{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.2)}.ali:last-child{border-bottom:none}.alt{font-weight:bold;font-size:12px;margin-bottom:4px}.aln{font-weight:bold}.ald{font-size:10px;opacity:.9}@keyframes f{0%,100%{opacity:1}50%{opacity:.85}}';
        popWin.document.open();
        popWin.document.write('<!DOCTYPE html><html><head><title>outbound dock :3</title><style>'+pcss+'</style></head><body><div class="cw"><div class="ch"><h3>outbound dock :3 - live</h3><div><span class="cs" id="cst">starting up...</span><button class="bt" id="dk" title="dock back">\u29C9</button></div></div><div class="cb" id="cb">'+TBL+'</div></div></body></html>');
        popWin.document.close();
        popWin.document.getElementById('dk').onclick=dock;
        GM_setValue('cpt_widget_popped',true);GM_setValue('cpt_widget_pop_heartbeat',Date.now());
        var iw=document.getElementById('cpt-w');if(iw)iw.style.display='none';
        var tb=document.getElementById('cpt-tb');if(tb)tb.style.display='none';

        var chk=setInterval(function(){
            if(!popWin||popWin.closed){clearInterval(chk);if(popI){clearInterval(popI);popI=null;}popWin=null;GM_setValue('cpt_widget_popped',false);GM_setValue('cpt_widget_pop_heartbeat',0);var cl2=GM_getValue('cpt_widget_closed',false),w2=document.getElementById('cpt-w'),tb2=document.getElementById('cpt-tb');if(cl2){if(w2)w2.style.display='none';if(tb2)tb2.style.display='flex';}else{if(w2)w2.style.display='';if(tb2)tb2.style.display='none';}}
            else GM_setValue('cpt_widget_pop_heartbeat',Date.now());
        },3000);

        rend(popWin.document);
        popI=setInterval(function(){if(popWin&&!popWin.closed)rend(popWin.document);else{clearInterval(popI);popI=null;}},S.refreshRate);
    }

    function dock(){if(popI){clearInterval(popI);popI=null;}if(popWin&&!popWin.closed)popWin.close();popWin=null;GM_setValue('cpt_widget_popped',false);GM_setValue('cpt_widget_pop_heartbeat',0);var cl=GM_getValue('cpt_widget_closed',false),w=document.getElementById('cpt-w'),tb=document.getElementById('cpt-tb');if(cl){if(w)w.style.display='none';if(tb)tb.style.display='flex';}else{if(w)w.style.display='';if(tb)tb.style.display='none';}upd();}

    // Alerts
    function gAlerts(st){var a=[],i=st.length,s,m;while(i--){s=st[i];m=tm(s.t);if(s.p>=S.alertPkg&&m<=S.alertMin)a.push({l:s.l,p:s.p,t:s.t,m:m});}if(a.length>1)a.sort(function(x,y){return x.m-y.m;});return a;}

    // Render (single reusable buffer)
    var buf='';
    function rend(d){
        var raw=GM_getValue('cpt_widget_data',null);if(!raw)return;
        var data;try{data=JSON.parse(raw);}catch(e){return;}
        var staged=data.s,loading=data.g,loaded=data.d,all=data.a,tst=data.ts;
        var lt=0,i=all.length;while(i--)if(late(all[i].t))lt++;
        var cs=d.getElementById('cs');if(!cs)return;
        cs.textContent=staged.length;d.getElementById('cl').textContent=loading.length;d.getElementById('cd').textContent=loaded.length;d.getElementById('ct').textContent=lt;

        var alerts=gAlerts(staged),ae=d.getElementById('wa');
        if(ae){if(!alerts.length){if(ae.innerHTML)ae.innerHTML='';}else{buf='<div class="al"><div class="alt">\u26A0 critical \u2014 staged freight at risk</div>';for(i=0;i<alerts.length;i++)buf+='<div class="ali"><span class="aln">'+alerts[i].l+'</span><span class="ald">'+alerts[i].p+' pkgs \xB7 '+alerts[i].t+' left</span></div>';buf+='</div>';ae.innerHTML=buf;}}

        var wn=d.getElementById('ww');
        if(wn){var age=(Date.now()-tst)/60000|0;if(age>2)wn.innerHTML='<div class="wn">\u26A0\uFE0F data is '+age+' min old</div>';else if(wn.innerHTML&&wn.innerHTML.indexOf('min old')!==-1)wn.innerHTML='';}

        var ts2=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        var tbS=d.getElementById('ts');
        if(tbS){if(!staged.length)tbS.innerHTML='<tr><td colspan="5" style="color:#888">no freight staged</td></tr>';else{buf='';for(i=0;i<staged.length;i++){var s=staged[i];buf+='<tr><td>'+s.l+'</td><td>'+s.p+(s.cn>0?' (+'+s.cn+'C)':'')+'</td><td class="sc">'+(s.cp||0)+'</td><td>'+s.c+'</td><td'+(urg(s.t)?' class="sr"':'')+'>'+s.t+'</td></tr>';}tbS.innerHTML=buf;}}

        var tbL=d.getElementById('tl');
        if(tbL){if(!loading.length)tbL.innerHTML='<tr><td colspan="5" style="color:#888">no active loads</td></tr>';else{buf='';for(i=0;i<loading.length;i++){var g=loading[i];buf+='<tr><td>'+g.l+'</td><td>'+g.lp+' / '+g.tp+'</td><td class="sc">'+(g.cp||0)+'</td><td>'+g.c+'</td><td'+(urg(g.t)?' class="sr"':'')+'>'+g.t+'</td></tr>';}tbL.innerHTML=buf;}}

        var tbA=d.getElementById('ta');
        if(tbA){if(!all.length)tbA.innerHTML='<tr><td colspan="6" style="color:#888">no data</td></tr>';else{all.sort(function(a,b){return tm(a.t)-tm(b.t);});buf='';for(i=0;i<all.length;i++){var c=all[i];buf+='<tr><td>'+c.l+'</td><td>'+c.tp+'</td><td>'+c.if+'</td><td class="sc">'+(c.cp||0)+'</td><td>'+c.c+'</td><td'+(urg(c.t)?' class="sr"':'')+'>'+c.t+'</td></tr>';}tbA.innerHTML=buf;}}

        var st=d.getElementById('cst');if(st)st.innerHTML='<span class="pl"></span>'+ts2;
        var src=d.getElementById('src');if(src)src.textContent='source: cpt view tab';
    }

    function upd(){
        var raw=GM_getValue('cpt_widget_data',null);
        if(!raw){var st=document.getElementById('cst');if(st)st.innerHTML='<span style="color:#f39c12">\u25CF opening CPT View...</span>';return;}
        var data;try{data=JSON.parse(raw);}catch(e){return;}
        rend(document);
        var ms=document.getElementById('ms');
        if(ms){var lt=0,i=data.a.length;while(i--)if(late(data.a[i].t))lt++;ms.textContent=data.s.length;document.getElementById('ml').textContent=data.g.length;document.getElementById('md').textContent=data.d.length;document.getElementById('mt').textContent=lt;}
        var mu=document.getElementById('mu');if(mu)mu.innerHTML='<span class="pl"></span>'+new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        var alerts=gAlerts(data.s),ma=document.getElementById('ma');
        if(ma){if(!alerts.length){if(ma.innerHTML)ma.innerHTML='';}else{buf='<div class="mal">\u26A0 ';for(var j=0;j<alerts.length;j++){if(j)buf+=' \xB7 ';buf+=alerts[j].l+' ('+alerts[j].p+'pkg/'+alerts[j].t+')';}buf+='</div>';ma.innerHTML=buf;}}
        if(popWin&&!popWin.closed)rend(popWin.document);
    }

    // Init
    function init(){create();upd();autoOpen();startLoop();}
    if(document.readyState==='complete')init();else window.addEventListener('load',init);
})();

