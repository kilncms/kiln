(function(){"use strict";document.readyState==="loading"?document.addEventListener("DOMContentLoaded",D):D();function $(){try{return(localStorage.getItem("kiln_admin")||localStorage.getItem("kiln_editor"))&&sessionStorage.getItem("kiln_pause")!=="1"}catch(e){return!1}}function D(){H(),$()||(L(),M(),N())}function L(){const e=new Set;document.querySelectorAll("[data-kiln-tags]").forEach(l=>{l.parentElement&&e.add(l.parentElement)}),document.querySelectorAll("[data-kiln-filters]").forEach(l=>e.add(l));for(const l of e){const i=[...l.children].filter(c=>c.hasAttribute("data-kiln-tags")||c.matches("[data-cms], article, li, div, tr, figure")),t=[];for(const c of i)for(const g of q(c.getAttribute("data-kiln-tags")))t.includes(g)||t.push(g);if(!t.length)continue;const o=document.createElement("div");o.className="kiln-filterbar",o.setAttribute("role","toolbar"),o.setAttribute("aria-label","Filter list");const x=(c,g)=>{const u=document.createElement("button");return u.type="button",u.className="kiln-pill",u.textContent=c,u.onclick=()=>{o.querySelectorAll(".kiln-pill").forEach(r=>r.classList.remove("kiln-pill-on")),u.classList.add("kiln-pill-on");for(const r of i){const b=q(r.getAttribute("data-kiln-tags"));r.style.display=!g||b.includes(g)?"":"none"}},u},f=x("All",null);f.classList.add("kiln-pill-on"),o.appendChild(f),t.forEach(c=>o.appendChild(x(c,c)));const p=l.closest("table")||l;p.parentElement.insertBefore(o,p)}}function q(e){return String(e||"").split(",").map(l=>l.trim()).filter(Boolean)}function M(){document.querySelectorAll("[data-kiln-gallery]").forEach(e=>{e.classList.add("kiln-gallery-grid");const l=()=>[...e.querySelectorAll("img")];e.addEventListener("click",i=>{const t=i.target.closest("img");!t||!e.contains(t)||(i.preventDefault(),T(l(),l().indexOf(t)))})})}function T(e,l){if(!e.length)return;let i=l<0?0:l;const t=document.createElement("div");t.className="kiln-lightbox",t.setAttribute("role","dialog"),t.setAttribute("aria-label","Image viewer"),t.innerHTML=`
      <button class="kiln-lb-close" aria-label="Close">\u2715</button>
      <button class="kiln-lb-prev" aria-label="Previous image">\u2039</button>
      <figure class="kiln-lb-stage"><img alt=""><figcaption></figcaption></figure>
      <button class="kiln-lb-next" aria-label="Next image">\u203A</button>
      <div class="kiln-lb-count"></div>`,document.body.appendChild(t),document.documentElement.style.overflow="hidden";const o=t.querySelector("img"),x=t.querySelector("figcaption"),f=t.querySelector(".kiln-lb-count");function p(r){var n,s;i=(r+e.length)%e.length;const b=(n=e[i].closest("a"))==null?void 0:n.getAttribute("href");o.src=b&&/\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(b)?b:e[i].currentSrc||e[i].src,o.alt=e[i].alt||"";const a=(s=e[i].closest("figure"))==null?void 0:s.querySelector("figcaption");x.textContent=a?a.textContent:e[i].alt||"",f.textContent=`${i+1} / ${e.length}`,t.querySelector(".kiln-lb-prev").style.visibility=e.length>1?"":"hidden",t.querySelector(".kiln-lb-next").style.visibility=e.length>1?"":"hidden"}function c(){t.remove(),document.documentElement.style.overflow="",document.removeEventListener("keydown",g)}function g(r){r.key==="Escape"?c():r.key==="ArrowLeft"?p(i-1):r.key==="ArrowRight"&&p(i+1)}t.querySelector(".kiln-lb-close").onclick=c,t.querySelector(".kiln-lb-prev").onclick=r=>{r.stopPropagation(),p(i-1)},t.querySelector(".kiln-lb-next").onclick=r=>{r.stopPropagation(),p(i+1)},t.addEventListener("click",r=>{r.target===t&&c()}),document.addEventListener("keydown",g);let u=null;t.addEventListener("touchstart",r=>{u=r.touches[0].clientX},{passive:!0}),t.addEventListener("touchend",r=>{if(u===null)return;const b=r.changedTouches[0].clientX-u;Math.abs(b)>40&&p(b>0?i-1:i+1),u=null},{passive:!0}),p(i)}function N(){document.querySelectorAll("[data-kiln-events]").forEach(_)}function I(e){return[...e.children].map(l=>{var p,c;const i=l.querySelectorAll("time[datetime]"),t=i[0]?new Date(i[0].getAttribute("datetime")):null,o=i[1]?new Date(i[1].getAttribute("datetime")):null;if(!t||isNaN(t))return null;const x=(((p=l.querySelector(".kiln-ev-title, h1,h2,h3,h4"))==null?void 0:p.textContent)||"Event").trim(),f=(((c=l.querySelector(".kiln-ev-loc"))==null?void 0:c.textContent)||"").trim();return{el:l,start:t,end:o,title:x,loc:f}}).filter(Boolean).sort((l,i)=>l.start-i.start)}const F=new Intl.DateTimeFormat(void 0,{month:"long",year:"numeric"}),z=new Intl.DateTimeFormat(void 0,{weekday:"long",month:"long",day:"numeric",year:"numeric"}),j=new Intl.DateTimeFormat(void 0,{hour:"numeric",minute:"2-digit"}),k=e=>`${e.getFullYear()}-${e.getMonth()}-${e.getDate()}`;function _(e){const l=document.createElement("div");l.className="kiln-evbar",l.innerHTML=`
      <div class="kiln-evbar-views" role="tablist" aria-label="Calendar view">
        ${["list","month","week","day"].map(a=>`<button type="button" class="kiln-pill" data-view="${a}">${a[0].toUpperCase()+a.slice(1)}</button>`).join("")}
      </div>
      <div class="kiln-evbar-nav" hidden>
        <button type="button" class="kiln-pill" data-nav="-1" aria-label="Previous">\u2039</button>
        <span class="kiln-evbar-label"></span>
        <button type="button" class="kiln-pill" data-nav="1" aria-label="Next">\u203A</button>
        <button type="button" class="kiln-pill" data-nav="0">Today</button>
      </div>`,e.parentElement.insertBefore(l,e);const i=document.createElement("div");i.className="kiln-cal",i.hidden=!0,e.parentElement.insertBefore(i,e.nextSibling);let t="list";try{t=sessionStorage.getItem("kiln_ev_view")||"list"}catch(a){}["list","month","week","day"].includes(t)||(t="list");let o=new Date;const x=l.querySelector(".kiln-evbar-nav"),f=l.querySelector(".kiln-evbar-label");function p(){l.querySelectorAll("[data-view]").forEach(n=>n.classList.toggle("kiln-pill-on",n.dataset.view===t));try{sessionStorage.setItem("kiln_ev_view",t)}catch(n){}const a=I(e);if(t==="list"){e.hidden=!1,i.hidden=!0,x.hidden=!0;return}e.hidden=!0,i.hidden=!1,x.hidden=!1,t==="month"?u(a):t==="week"?r(a):b(a)}function c(a){const n=document.createElement("button");return n.type="button",n.className="kiln-ev-chip",n.innerHTML=`<span class="kiln-ev-chip-t">${A(j.format(a.start))}</span> ${A(a.title)}`,n.onclick=()=>g(a),n}function g(a){var h;(h=document.querySelector(".kiln-ev-pop"))==null||h.remove();const n=document.createElement("div");n.className="kiln-ev-pop";const s=document.createElement("div");s.className="kiln-ev-pop-card",s.appendChild(a.el.cloneNode(!0));const m=document.createElement("button");m.className="kiln-lb-close",m.textContent="\u2715",m.setAttribute("aria-label","Close"),m.onclick=()=>n.remove(),s.prepend(m),n.appendChild(s),n.addEventListener("click",w=>{w.target===n&&n.remove()}),document.body.appendChild(n)}function u(a){const n=o.getFullYear(),s=o.getMonth();f.textContent=F.format(o);const h=new Date(n,s,1).getDay(),w=new Date(n,s+1,0).getDate(),y={};for(const d of a)(y[k(d.start)]=y[k(d.start)]||[]).push(d);let v='<div class="kiln-cal-month">'+["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>`<div class="kiln-cal-dow">${d}</div>`).join("");for(let d=0;d<h;d++)v+='<div class="kiln-cal-cell kiln-cal-pad"></div>';const S=k(new Date);for(let d=1;d<=w;d++){const C=`${n}-${s}-${d}`;v+=`<div class="kiln-cal-cell${C===S?" kiln-cal-today":""}" data-day="${d}"><div class="kiln-cal-n">${d}</div></div>`}v+="</div>",i.innerHTML=v;for(let d=1;d<=w;d++){const C=y[`${n}-${s}-${d}`];if(!C)continue;const B=i.querySelector(`[data-day="${d}"]`);C.forEach(P=>B.appendChild(c(P)))}}function r(a){const n=new Date(o);n.setDate(n.getDate()-n.getDay());const s=new Date(n);s.setDate(s.getDate()+6);const m=new Intl.DateTimeFormat(void 0,{month:"short",day:"numeric"});f.textContent=`${m.format(n)} \u2013 ${m.format(s)}`,i.innerHTML='<div class="kiln-cal-week"></div>';const h=i.firstChild,w=k(new Date);for(let y=0;y<7;y++){const E=new Date(n);E.setDate(n.getDate()+y);const v=document.createElement("div");v.className="kiln-cal-wcol"+(k(E)===w?" kiln-cal-today":""),v.innerHTML=`<div class="kiln-cal-dow">${new Intl.DateTimeFormat(void 0,{weekday:"short",day:"numeric"}).format(E)}</div>`,a.filter(S=>k(S.start)===k(E)).forEach(S=>v.appendChild(c(S))),h.appendChild(v)}}function b(a){f.textContent=z.format(o),i.innerHTML='<div class="kiln-cal-day"></div>';const n=i.firstChild,s=a.filter(m=>k(m.start)===k(o));if(!s.length){n.innerHTML='<p class="kiln-cal-empty">No events this day.</p>';return}s.forEach(m=>{const h=document.createElement("div");h.className="kiln-cal-dayitem",h.appendChild(m.el.cloneNode(!0)),n.appendChild(h)})}l.querySelectorAll("[data-view]").forEach(a=>a.onclick=()=>{t=a.dataset.view,p()}),l.querySelectorAll("[data-nav]").forEach(a=>a.onclick=()=>{const n=Number(a.dataset.nav);n===0?o=new Date:t==="month"?o.setMonth(o.getMonth()+n):t==="week"?o.setDate(o.getDate()+7*n):o.setDate(o.getDate()+n),p()}),p()}function A(e){return String(e).replace(/[&<>"']/g,l=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[l])}function H(){if(document.getElementById("kiln-features-css"))return;const e=document.createElement("style");e.id="kiln-features-css",e.textContent=`
.kiln-filterbar{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.kiln-pill{border:1.5px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:999px;
  padding:5px 14px;font:inherit;font-size:.85em;cursor:pointer;transition:all .15s;line-height:1.3}
.kiln-pill:hover{border-color:currentColor}
.kiln-pill.kiln-pill-on{background:rgba(127,127,127,.18);border-color:currentColor;font-weight:600}
.kiln-doc{text-decoration:none}
.kiln-doc-chip{display:inline-flex;align-items:center;gap:7px;border:1.5px solid rgba(127,127,127,.35);
  border-radius:9px;padding:6px 12px;font-size:.92em;line-height:1.3}
.kiln-doc-chip:hover{border-color:currentColor}
.kiln-doc-card{display:block;max-width:340px;border:1.5px solid rgba(127,127,127,.3);border-radius:12px;
  padding:14px 16px;margin:10px 0;line-height:1.45}
.kiln-doc-card:hover{border-color:currentColor}
.kiln-doc-card small{opacity:.65}
.kiln-gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
.kiln-gallery-grid figure{margin:0}
.kiln-gallery-grid img{width:100%;height:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;cursor:zoom-in;display:block}
.kiln-gallery-grid figcaption{font-size:.8em;opacity:.75;padding:4px 2px}
.kiln-lightbox{position:fixed;inset:0;z-index:2147483000;background:rgba(8,8,14,.93);display:flex;
  align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.kiln-lb-stage{margin:0;max-width:88vw;max-height:88vh;text-align:center}
.kiln-lb-stage img{max-width:88vw;max-height:82vh;object-fit:contain;border-radius:6px}
.kiln-lb-stage figcaption{color:#cfcfd8;font-size:13px;padding-top:10px}
.kiln-lightbox button{background:rgba(255,255,255,.08);border:none;color:#fff;cursor:pointer;border-radius:50%;
  width:44px;height:44px;font-size:22px;display:flex;align-items:center;justify-content:center;transition:background .15s}
.kiln-lightbox button:hover{background:rgba(255,255,255,.2)}
.kiln-lb-close{position:absolute;top:16px;right:16px;font-size:17px!important}
.kiln-lb-prev{position:absolute;left:14px;top:50%;transform:translateY(-50%)}
.kiln-lb-next{position:absolute;right:14px;top:50%;transform:translateY(-50%)}
.kiln-lb-count{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);color:#b9b9c4;font-size:12.5px}
@media (max-width:600px){.kiln-lb-prev{left:4px}.kiln-lb-next{right:4px}}
.kiln-evbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin:0 0 14px}
.kiln-evbar-views,.kiln-evbar-nav{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.kiln-evbar-label{font-weight:600;min-width:12ch;text-align:center}
.kiln-cal-month{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.kiln-cal-dow{font-size:.75em;text-transform:uppercase;letter-spacing:.05em;opacity:.6;padding:4px 6px}
.kiln-cal-cell{min-height:86px;border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:4px;overflow:hidden}
.kiln-cal-pad{border:none}
.kiln-cal-n{font-size:.8em;opacity:.65;padding:1px 3px}
.kiln-cal-today{outline:2px solid rgba(127,127,127,.55)}
.kiln-ev-chip{display:block;width:100%;text-align:left;border:none;background:rgba(127,127,127,.14);
  color:inherit;border-radius:6px;padding:3px 6px;font:inherit;font-size:.74em;line-height:1.35;cursor:pointer;
  margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kiln-ev-chip:hover{background:rgba(127,127,127,.28)}
.kiln-ev-chip-t{font-weight:600;opacity:.8}
.kiln-cal-week{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.kiln-cal-wcol{border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:6px;min-height:120px}
.kiln-cal-day .kiln-cal-dayitem{border:1px solid rgba(127,127,127,.22);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.kiln-cal-empty{opacity:.65}
.kiln-ev-pop{position:fixed;inset:0;z-index:2147483000;background:rgba(8,8,14,.5);display:flex;
  align-items:center;justify-content:center;padding:20px}
.kiln-ev-pop-card{position:relative;background:#fff;color:#1c1c28;border-radius:14px;padding:22px 26px;
  max-width:480px;width:100%;max-height:80vh;overflow:auto;box-shadow:0 24px 80px rgba(0,0,0,.3)}
.kiln-ev-pop-card .kiln-lb-close{position:absolute;top:10px;right:10px;background:rgba(0,0,0,.06);color:#333}
@media (max-width:640px){.kiln-cal-cell{min-height:56px}.kiln-cal-month{gap:2px}
  .kiln-cal-week{grid-template-columns:1fr 1fr}.kiln-evbar{justify-content:flex-start}}`,document.head.appendChild(e)}})();
