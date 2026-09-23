// Build otimizado da LP
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { PurgeCSS } from 'purgecss';
import { transform } from 'lightningcss';
import sharp from 'sharp';

const OUT = 'dist';
const ASSETS = path.join(OUT, 'assets');
const SOURCE_FALLBACK = 'https://raw.githubusercontent.com/raycialima/lote-especial-teste/main/index.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const OFFLINE = process.env.OFFLINE === '1';
const DELAY_TIMEOUT = Number(process.env.DELAY_TIMEOUT || 15000);
const VIDEO_TIMEOUT = Number(process.env.VIDEO_TIMEOUT || 5000);
// Configuração (lp.config.json é opcional)
let CFG = { vwo: 'sync', vwoTolerance: 500, vwoHideBody: true, criticalSections: 3, fontDisplay: 'swap', preloadFonts: 2 };
try { CFG = { ...CFG, ...JSON.parse(await fs.readFile('lp.config.json', 'utf8')) }; } catch {}
try { if (process.env.LP_CONFIG) CFG = { ...CFG, ...JSON.parse(process.env.LP_CONFIG) }; } catch {}
const VWO_TOLERANCE = CFG.vwoTolerance;
const log = (...a) => console.log('[build]', ...a);

const cache = new Map();
async function get(url, binary = false) {
  const key = (binary ? 'b:' : 't:') + url;
  if (cache.has(key)) return cache.get(key);
  if (OFFLINE) { const v = binary ? Buffer.alloc(0) : ''; cache.set(key, v); return v; }
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      const v = binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
      cache.set(key, v);
      return v;
    } catch (e) { lastErr = e; await new Promise((s) => setTimeout(s, 500 * (i + 1))); }
  }
  throw lastErr;
}
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 12);
async function writeAsset(buf, ext) {
  const name = sha(buf) + ext;
  await fs.writeFile(path.join(ASSETS, name), buf);
  return '/assets/' + name;
}
const extOf = (u) => (path.extname(new URL(u).pathname).toLowerCase() || '.bin');
const abs = (u, base) => { try { return new URL(u, base).href; } catch { return null; } };
const hosted = new Map();
async function host(url) {
  if (hosted.has(url)) return hosted.get(url);
  const p = (async () => {
    try {
      const buf = await get(url, true);
      if (!buf.length && !OFFLINE) throw new Error('vazio');
      return await writeAsset(buf, extOf(url));
    } catch (e) { log('AVISO: não consegui hospedar', url, e.message); return url; }
  })();
  hosted.set(url, p);
  return p;
}
// imagem raster -> webp redimensionado (max largura)
const resized = new Map();
async function hostImage(url, maxW) {
  const k = url + '|' + maxW;
  if (resized.has(k)) return resized.get(k);
  const p = (async () => {
    try {
      const buf = await get(url, true);
      if (OFFLINE || !buf.length) return url;
      if (extOf(url) === '.svg') return await writeAsset(buf, '.svg');
      const out = await sharp(buf).resize({ width: maxW, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
      return await writeAsset(out, '.webp');
    } catch (e) { log('AVISO imagem', url, e.message); return url; }
  })();
  resized.set(k, p);
  return p;
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(ASSETS, { recursive: true });

let html;
try { html = await fs.readFile('index.html', 'utf8'); log('fonte: index.html local'); }
catch { html = await get(SOURCE_FALLBACK); log('fonte:', SOURCE_FALLBACK); }
const BASE = cheerio.load(html)('link[rel="canonical"]').attr('href') || 'https://lp.stlflix.com.br/';
const $ = cheerio.load(html, { decodeEntities: false });

// 1. limpeza
$('link[rel="alternate"], link[rel="EditURI"], link[rel="https://api.w.org/"], link[rel="shortlink"], link[rel="pingback"]').remove();
$('script[type="text/template"], script#wp-emoji-settings').remove();
$('script[type="module"]').filter((_, el) => $(el).html().includes('wp-emoji-settings')).remove();
$('link[rel="dns-prefetch"], link[rel="preconnect"]').filter((_, el) => !/visualwebsiteoptimizer/.test($(el).attr('href') || '')).remove();
$('meta[name="generator"]').remove();
const JUNK_SCRIPT_ID = /^(wc-|woocommerce|underscore-js|wp-util-js|awdr|woo-|angie|cfw|stlflix-orbitflow)/;
const JUNK_SCRIPT_TXT = /(wc_add_to_cart|woocommerce_params|_wpUtilSettings|wc_order_attribution|awdr_params|angieCanvasTemplateData)/;
$('script').each((_, el) => {
  const id = $(el).attr('id') || '';
  if (JUNK_SCRIPT_ID.test(id) || (!$(el).attr('src') && JUNK_SCRIPT_TXT.test($(el).html()))) $(el).remove();
});
const JUNK_CSS_ID = /^(cfw-|woocommerce-|woo-asaas|wc-blocks|woo_discount|elementor-icons-ekiticons)/;
$('meta[name="robots"]').attr('content', 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');
$('.elementor-invisible').removeClass('elementor-invisible');
// VWO: mantém síncrono, anti-flicker menor
const vwoEl = $('#vwoCode');
if (vwoEl.length) {
  let v = vwoEl.html().replace(/settings_tolerance\s*=\s*\d+/, `settings_tolerance=${VWO_TOLERANCE}`);
  if (!CFG.vwoHideBody) v = v.replace(/hide_element\s*=\s*'body'/, "hide_element=''");
  vwoEl.html(v);
  if (CFG.vwo === 'remove') vwoEl.remove();
}
log('config:', JSON.stringify(CFG));

// 2. CSS
const cssParts = [];
const cssNames = [];
const googleFamilies = new Set();
for (const el of $('link[rel="stylesheet"], style').toArray()) {
  const $el = $(el);
  if (el.tagName === 'link') {
    const href = abs(($el.attr('href') || '').replace(/&#038;/g, '&'), BASE);
    const id = $el.attr('id') || '';
    $el.remove();
    if (!href || JUNK_CSS_ID.test(id)) continue;
    if (href.includes('fonts.googleapis.com')) {
      const fam = new URL(href).searchParams.get('family');
      if (fam) googleFamilies.add(fam.split(':')[0]);
      continue;
    }
    let css = await get(href);
    css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (u.startsWith('data:') ? m : `url("${abs(u, href)}")`));
    const media = $el.attr('media');
    cssParts.push(media && media !== 'all' ? `@media ${media}{${css}}` : css);
    cssNames.push(id || href);
  } else {
    if ($el.attr('type') && $el.attr('type') !== 'text/css') continue;
    let css = $el.html();
    css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (u.startsWith('data:') ? m : `url("${abs(u, BASE)}")`));
    cssParts.push(css);
    cssNames.push('inline:' + ($el.attr('id') || '?'));
    $el.remove();
  }
}
log('CSS bruto:', (cssParts.join('').length / 1024).toFixed(0), 'KB de', cssParts.length, 'partes');

// 3. JS
const DELAY_ID = /^(leadin|hs-|standard-page)/;
const appChunks = [];
const delayed = [];
const video = [];
for (const el of $('script').toArray()) {
  const $el = $(el);
  const type = ($el.attr('type') || 'text/javascript').toLowerCase();
  if (!['text/javascript', 'application/javascript', 'module'].includes(type)) continue;
  const id = $el.attr('id') || '';
  const cls = $el.attr('class') || '';
  const srcAttr = $el.attr('src');
  const src = srcAttr ? abs(srcAttr.replace(/&#038;/g, '&'), BASE) : null;
  const code = src ? null : $el.html();
  if (id === 'vwoCode') { if (CFG.vwo === 'delay') { delayed.unshift({ code }); $el.remove(); } continue; }
  if (code && /(lazyloadRunObserver|patchMissingImageAlt|_plt=i\._plt|className;\s*c\s*=\s*c\.replace)/.test(code)) continue;
  if (code && /(applyUtmsToLinks|trackPlanClick)/.test(code)) continue;
  if (code && /converteai\.net|vturb/.test(code)) {
    const m = code.match(/s\.src\s*=\s*"([^"]+)"/);
    if (m) { video.push(m[1]); $el.remove(); continue; }
  }
  const isTracking = (src && /(hs-scripts|googletagmanager|clarity\.ms|connect\.facebook)/.test(src)) ||
    (code && /(googletagmanager\.com\/gtm\.js|clarity\.ms\/tag|_hsq|leadin_wordpress)/.test(code)) ||
    DELAY_ID.test(id) || cls.includes('hsq-set-content-id');
  if (isTracking) { delayed.push(src ? { src } : { code }); $el.remove(); continue; }
  if (src) appChunks.push(`/* ${new URL(src).pathname} */\n${await get(src)}`);
  else appChunks.push(code);
  $el.remove();
}
log('scripts: app', appChunks.length, '| delay', delayed.length, '| vídeo', video.length);

// 4. imagens
const WIDTHS = [400, 800];
let imgCount = 0;
for (const el of $('img').toArray()) {
  const $img = $(el);
  const src = abs($img.attr('src') || '', BASE);
  if (!src || src.startsWith('data:')) continue;
  $img.removeAttr('srcset').attr('decoding', 'async');
  const ext = extOf(src);
  try {
    const buf = await get(src, true);
    if (OFFLINE || !buf.length) continue;
    if (ext === '.svg') { $img.attr('src', await writeAsset(buf, '.svg')); imgCount++; continue; }
    const meta = await sharp(buf).metadata();
    const variants = [];
    for (const w of WIDTHS.filter((w) => w < meta.width).concat([Math.min(meta.width, 1200)])) {
      const out = await sharp(buf).resize({ width: w, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      variants.push([await writeAsset(out, '.webp'), w]);
    }
    const uniq = [...new Map(variants.map((v) => [v[1], v])).values()].sort((a, b) => a[1] - b[1]);
    const best = uniq.find((v) => v[1] >= 800) || uniq[uniq.length - 1];
    $img.attr('src', best[0]);
    if (uniq.length > 1) {
      $img.attr('srcset', uniq.map(([p, w]) => `${p} ${w}w`).join(', '));
      const dw = Number($img.attr('width')) || meta.width;
      $img.attr('sizes', `(max-width: 767px) 92vw, ${Math.min(dw, 800)}px`);
    }
    imgCount++;
  } catch (e) { log('AVISO imagem', src, e.message); }
}
// imagens de fundo em style="" (carrosséis)
let bgCount = 0;
for (const el of $('[style*="url("]').toArray()) {
  const $e = $(el);
  let st = $e.attr('style').replace(/&#039;|&quot;/g, "'");
  for (const m of [...st.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]) {
    const u = abs(m[1], BASE);
    if (!u || !/stlflix\.com/.test(u)) continue;
    $e.attr('data-lazy-bg', await hostImage(u, 700));
    st = st.replace(/background-image\s*:\s*url\([^)]*\)\s*;?/, '');
    bgCount++;
  }
  $e.attr('style', st);
}
log('imagens hospedadas:', imgCount, '| fundos:', bgCount);
for (const el of $('link[rel="icon"], link[rel="apple-touch-icon"]').toArray()) {
  const u = abs($(el).attr('href'), BASE);
  if (u) $(el).attr('href', await host(u));
}
const tile = $('meta[name="msapplication-TileImage"]');
if (tile.length) tile.attr('content', await host(abs(tile.attr('content'), BASE)));

// 5. purge + fontes
const htmlForPurge = $.html();
const RUNTIME = [/^swiper/, /^elementor-sticky/, /^elementor-motion/, /^elementor-countdown/, /^e-lazyloaded$/, /^animated$/, /^bounce$/, /^elementor-animation/, /^is-/, /^elementor-lightbox/, /^elementor-slideshow/, /^e-n-/, /^elementor-invisible$/, /^elementor-section-stretched$/, /^elementor-active$/, /^e--ua-/, /^elementor-device-/, /^e-con-inner$/, /^elementor-sticky__spacer$/, /^gradient-text$/, /^js$/, /^no-js$/];
const purged = await new PurgeCSS().purge({
  content: [{ raw: htmlForPurge, extension: 'html' }],
  css: cssParts.map((raw) => ({ raw })),
  fontFace: false, keyframes: true, variables: false,
  safelist: { standard: RUNTIME, deep: [/swiper/, /elementor-sticky/, /elementor-countdown/], greedy: [/swiper/] },
});
let css = purged.map((p) => p.css).join('\n');
// CSS crítico: só o que as primeiras seções (topo da página) usam
const $c = cheerio.load(htmlForPurge, { decodeEntities: false });
const tops = $c('.e-parent, .elementor-top-section').toArray();
tops.slice(CFG.criticalSections).forEach((el) => $c(el).remove());
$c('script').remove();
log('seções no crítico:', CFG.criticalSections, 'de', tops.length, '| ids restantes:', $c('[data-id]').length);
const crit = await new PurgeCSS().purge({
  content: [{ raw: $c.html(), extension: 'html' }],
  css: [{ raw: css }],
  fontFace: false, keyframes: true, variables: false,
  safelist: { standard: [/^e--ua-/, /^elementor-device-/, /^js$/, /^gradient-text$/, /^e-lazyloaded$/] },
});
let critCss = crit[0].css;
log('CSS após purge:', (css.length / 1024).toFixed(0), 'KB');

const vars = {};
for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) vars[m[1]] = m[2].trim();
const resolve = (v) => { let x = (v || '').trim(); for (let i = 0; i < 5; i++) { const m = x.match(/^var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/); if (!m) break; x = (vars[m[1]] ?? m[2] ?? '').trim(); } return x; };
const famWeights = {};
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const body = m[2];
  const ff = body.match(/font-family\s*:\s*([^;}]+)/);
  if (!ff) continue;
  const fam = resolve(ff[1]).split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  const fw = body.match(/font-weight\s*:\s*([^;}]+)/);
  let w = fw ? resolve(fw[1]) : '400';
  w = w === 'bold' ? '700' : w === 'normal' || !/^\d{3}$/.test(w) ? '400' : w;
  (famWeights[fam] ||= new Set(['400'])).add(w);
}
for (const [k, v] of Object.entries(vars)) if (/font-family$/.test(k)) { const fam = v.split(',')[0].replace(/["']/g, '').trim().toLowerCase(); (famWeights[fam] ||= new Set(['400'])); const wv = vars[k.replace(/font-family$/, 'font-weight')]; if (wv && /^\d{3}$/.test(wv)) famWeights[fam].add(wv); }
let fontCss = '';
for (const fam of googleFamilies) {
  const fw = famWeights[fam.replace(/\+/g, ' ').toLowerCase()];
  if (!fw) { log('fonte não usada, removida:', fam); continue; }
  const w = [...fw].sort();
  const url = `https://fonts.googleapis.com/css2?family=${fam.replace(/ /g, '+')}:wght@${w.join(';')}&display=swap`;
  try {
    let fc = await get(url);
    fc = fc.split(/(?=\/\*\s*[\w-]+\s*\*\/)/).filter((b) => /\/\*\s*(latin|latin-ext)\s*\*\//.test(b)).join('\n');
    for (const m of [...fc.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)]) fc = fc.replace(m[1], await host(m[1]));
    fontCss += fc;
    log('fonte', fam, 'pesos', w.join(','));
  } catch (e) { log('AVISO fonte', fam, e.message); }
}
const finalize = async (css) => {
css = fontCss + css;
css = css.replace(/@font-face\s*\{([^}]*)\}/g, (m, body) => `@font-face{font-display:${CFG.fontDisplay};${body.replace(/font-display\s*:\s*[\w-]+\s*;?/, '')}}`);
for (const m of [...css.matchAll(/url\("?(https?:\/\/[^")]+)"?\)/g)]) {
  const u = m[1];
  if (/fonts\.gstatic|stlflix\.com/.test(u)) css = css.split(u).join(await host(u.split('#')[0]));
}
const { code: minCss } = transform({ filename: 'bundle.css', code: Buffer.from(css), minify: true, errorRecovery: true });
return minCss.toString();
};
const fullCss = await finalize(css);
critCss = await finalize(critCss);
log('CSS: crítico', (critCss.length / 1024).toFixed(0), 'KB (inline) | completo', (fullCss.length / 1024).toFixed(0), 'KB (async)');

// 6. HTML final
const fullPath = await writeAsset(Buffer.from(fullCss), '.css');
const styleTag = `<style id="lp-css">${critCss}</style><link rel="stylesheet" href="${fullPath}" media="print" onload="this.media='all'"><noscript><link rel="stylesheet" href="${fullPath}"></noscript>`;
if ($('#vwoCode').length) $('#vwoCode').before(styleTag); else $('head').append(styleTag);
// preload das fontes latin usadas no topo, logo no início do <head>
const latinFonts = [...fontCss.matchAll(/\/\*\s*latin\s*\*\/\s*@font-face\s*\{[^}]*font-family:\s*'([^']+)'[^}]*font-weight:\s*(\d+)[^}]*url\((\/assets\/[^)]+\.woff2)\)/g)];
const critFams = new Set([...critCss.matchAll(/font-family:\s*"?([^",;}]+)/g)].map((m) => m[1].trim().toLowerCase()));
const pre = [...new Set(latinFonts.filter(([, f]) => critFams.has(f.toLowerCase())).map((x) => x[3]))].slice(0, CFG.preloadFonts);
log('preload fontes:', pre.length, [...critFams].join('|'));
$('head').prepend(pre.map((u) => `<link rel="preload" href="${u}" as="font" type="font/woff2" crossorigin>`).join(''));
$('meta[charset]').remove(); $('head').prepend('<meta charset="UTF-8">');
// shim: listeners de DOMContentLoaded/load registrados depois desses eventos disparam mesmo assim
const SHIM = "(function(){var d=document,w=window,da=d.addEventListener.bind(d),wa=w.addEventListener.bind(w);d.addEventListener=function(t,f,o){if(t==='DOMContentLoaded'&&d.readyState!=='loading'){setTimeout(function(){typeof f==='function'?f.call(d,new Event(t)):f.handleEvent(new Event(t))});return}return da(t,f,o)};w.addEventListener=function(t,f,o){if(t==='load'&&d.readyState==='complete'){setTimeout(function(){typeof f==='function'?f.call(w,new Event(t)):f.handleEvent(new Event(t))});return}return wa(t,f,o)};})();";
const appJs = SHIM + '\n;\n' + appChunks.join('\n;\n').replace(/\/\/# sourceMappingURL=\S+/g, '');
const appPath = await writeAsset(Buffer.from(appJs), '.js');
// fundos dos carrosséis depois do load (o JS do Elementor entra junto com o tracking, na 1ª interação)
$('body').append(`<script>
addEventListener('load',function(){document.querySelectorAll('[data-lazy-bg]').forEach(function(e){e.style.backgroundImage='url('+e.getAttribute('data-lazy-bg')+')';});});
</script>`);
const delayedJson = JSON.stringify(delayed).replace(/<\//g, '<\\/');
const videoJson = JSON.stringify(video);
$('body').append(`<script>
(function(){
  var A='${appPath}',T=${delayedJson},V=${videoJson},done=false,vdone=false;
  function run(list,i){ if(i>=list.length) return; var it=list[i],s=document.createElement('script');
    if(it.src){ s.src=it.src; s.async=false; s.onload=s.onerror=function(){run(list,i+1)}; document.head.appendChild(s); }
    else { s.text=it.code; document.head.appendChild(s); run(list,i+1); } }
  function loadVideo(){ if(vdone) return; vdone=true; V.forEach(function(u){var s=document.createElement('script');s.src=u;s.async=true;document.head.appendChild(s);}); }
  function go(){ if(done) return; done=true; EV.forEach(function(e){removeEventListener(e,go,{passive:true})}); loadVideo(); var a=document.createElement('script'); a.src=A; a.onload=a.onerror=function(){run(T,0)}; document.body.appendChild(a); }
  var EV=['pointerdown','touchstart','keydown','scroll','mousemove','wheel'];
  EV.forEach(function(e){addEventListener(e,go,{passive:true})});
  addEventListener('load',function(){ setTimeout(loadVideo,${VIDEO_TIMEOUT}); setTimeout(go,${DELAY_TIMEOUT}); });
})();
</script>`);
const outHtml = $.html().replace(/>\s{2,}</g, '>\n<');
await fs.writeFile(path.join(OUT, 'index.html'), outHtml);
const files = await fs.readdir(ASSETS);
let total = 0;
for (const f of files) total += (await fs.stat(path.join(ASSETS, f))).size;
log('HTML:', (outHtml.length / 1024).toFixed(0), 'KB | assets:', files.length, 'arquivos,', (total / 1024).toFixed(0), 'KB | app.js', (appJs.length / 1024).toFixed(0), 'KB');
log('OK');
