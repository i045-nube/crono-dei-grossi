// Prova PiP: verifica se una finestrella (Picture-in-Picture) col cronometro tiene viva la pagina
// e lascia suonare bip e voci in sessione 'ambient' (mescolati con Spotify) mentre si usa un'altra app.
// Tutti i suoni sono programmati SUBITO sull'orologio audio: in secondo piano il JavaScript si ferma.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('canvas'), g2 = canvas.getContext('2d'), video = $('video'), logEl = $('log');
  const AC = window.AudioContext || window.webkitAudioContext;
  const DURATA = 180;              // secondi di prova
  const LS_KEY = 'provaPip.registro';
  const MAX_RIGHE = 600;

  /* ---------- registro ---------- */
  let righe = [];
  try { righe = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); if (!Array.isArray(righe)) righe = []; } catch { righe = []; }
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const ora = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
  function log(msg) {
    righe.push(`${ora()}  ${msg}`);
    if (righe.length > MAX_RIGHE) righe = righe.slice(-MAX_RIGHE);
    try { localStorage.setItem(LS_KEY, JSON.stringify(righe)); } catch { /* memoria piena o privata: resta solo a video */ }
    logEl.textContent = righe.slice().reverse().join('\n');
  }
  const errStr = e => (e && (e.name || e.message)) ? `${e.name || ''} ${e.message || ''}`.trim() : String(e);
  window.addEventListener('error', e => log(`ERRORE JS: ${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener('unhandledrejection', e => log(`ERRORE promessa: ${errStr(e.reason)}`));

  /* ---------- supporto API ---------- */
  log('=== pagina aperta === ' + navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  log(`aperta da Home (standalone): ${standalone}`);
  const sup = {
    audioSession: 'audioSession' in navigator,
    requestPictureInPicture: typeof video.requestPictureInPicture === 'function',
    pictureInPictureEnabled: document.pictureInPictureEnabled,
    webkitSetPresentationMode: typeof video.webkitSetPresentationMode === 'function',
    webkitSupportsPiP: typeof video.webkitSupportsPresentationMode === 'function' ? video.webkitSupportsPresentationMode('picture-in-picture') : 'n/d',
    captureStream: typeof canvas.captureStream === 'function',
    MediaRecorder: typeof window.MediaRecorder === 'function',
    AudioContext: !!AC,
  };
  for (const [k, v] of Object.entries(sup)) log(`supporto ${k}: ${v}`);
  if (sup.audioSession) log(`audioSession.type iniziale: ${navigator.audioSession.type}`);

  const scelta = name => (document.querySelector(`input[name=${name}]:checked`) || {}).value;

  /* ---------- cronometro su canvas (setInterval, non requestAnimationFrame) ---------- */
  let ctx = null, out = null, T0 = null, wallStart = null, sources = [], tick = 0, finitoLoggato = false;
  const mmss = s => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
  function disegna() {
    tick++;
    const w = canvas.width, h = canvas.height, d = new Date();
    g2.fillStyle = '#000'; g2.fillRect(0, 0, w, h);
    g2.textAlign = 'center'; g2.textBaseline = 'middle';
    let grande = 'PRONTO', riga2 = 'premi START', colore = '#888';
    if (T0 !== null && ctx) {
      const sa = Math.max(0, ctx.currentTime - T0);            // orologio audio
      const sw = (Date.now() - wallStart) / 1000;              // orologio vero
      grande = mmss(Math.min(sa, DURATA));
      riga2 = `audio ${sa.toFixed(1)} s · vero ${sw.toFixed(1)} s`;
      colore = sa >= DURATA ? '#e44' : '#3c3';
      if (sa >= DURATA + 1.5 && !finitoLoggato) { finitoLoggato = true; log('prova finita (3 minuti)'); }
    }
    g2.fillStyle = colore; g2.font = 'bold 170px -apple-system, system-ui, sans-serif';
    g2.fillText(grande, w / 2, h * 0.40);
    g2.fillStyle = '#fff'; g2.font = 'bold 34px -apple-system, system-ui, sans-serif';
    g2.fillText(riga2, w / 2, h * 0.76);
    // orario reale + contatore: se la finestrella si congela, questi smettono di cambiare
    g2.fillStyle = '#ff0'; g2.font = 'bold 30px ui-monospace, Menlo, monospace';
    g2.fillText(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}  #${tick}`, w / 2, h * 0.92);
  }
  disegna();
  setInterval(disegna, 200);

  /* ---------- video per la finestrella ---------- */
  let stream = null, clipUrl = null, clipInCorso = false;
  function videoDiretto() {
    if (!sup.captureStream) { log('metodo a) NON supportato: manca canvas.captureStream'); return; }
    try {
      if (!stream) stream = canvas.captureStream(10);
      video.removeAttribute('src'); video.srcObject = stream;
      video.play().then(() => log('video diretto in riproduzione')).catch(e => log(`video diretto play errore: ${errStr(e)}`));
    } catch (e) { log(`metodo a) errore: ${errStr(e)}`); }
  }
  function videoClip() {
    if (!sup.captureStream) { log('metodo b) NON supportato: manca canvas.captureStream'); return; }
    if (!sup.MediaRecorder) { log('metodo b) NON supportato: manca MediaRecorder'); return; }
    if (clipUrl) { usaClip(); return; }
    if (clipInCorso) return;
    const tipi = ['video/mp4', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = tipi.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    let rec;
    try {
      const s = canvas.captureStream(10);
      rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
    } catch (e) { log(`metodo b) MediaRecorder errore: ${errStr(e)}`); return; }
    const pezzi = [];
    clipInCorso = true;
    rec.ondataavailable = e => { if (e.data && e.data.size) pezzi.push(e.data); };
    rec.onerror = e => log(`MediaRecorder errore: ${errStr(e.error || e)}`);
    rec.onstop = () => {
      clipInCorso = false;
      const blob = new Blob(pezzi, { type: rec.mimeType || mime || 'video/mp4' });
      log(`clip registrato: ${blob.size} byte, tipo ${blob.type}`);
      if (!blob.size) { log('clip vuoto: metodo b) non utilizzabile'); return; }
      clipUrl = URL.createObjectURL(blob);
      if (scelta('pip') === 'clip') usaClip();
    };
    rec.start(500);
    log(`registro il clip (4 s, ${mime || 'tipo predefinito'})... aspetta prima di START`);
    setTimeout(() => { try { rec.stop(); } catch (e) { log(`stop registrazione errore: ${errStr(e)}`); } }, 4000);
  }
  function usaClip() {
    video.srcObject = null; video.src = clipUrl; video.loop = true;
    video.play().then(() => log('clip in riproduzione (loop)')).catch(e => log(`clip play errore: ${errStr(e)}`));
  }
  function preparaVideo() { const m = scelta('pip'); log(`metodo finestrella: ${m}`); if (m === 'clip') videoClip(); else videoDiretto(); }
  document.querySelectorAll('input[name=pip]').forEach(r => r.addEventListener('change', preparaVideo));
  document.querySelectorAll('input[name=sess]').forEach(r => r.addEventListener('change', () => log(`sessione scelta: ${scelta('sess')}`)));
  preparaVideo();   // pronto già prima del gesto: su iPhone il PiP va chiesto subito nel tocco

  function inPip() { return document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture'; }
  function webkitPip() {
    if (!sup.webkitSetPresentationMode) { log('webkitSetPresentationMode non disponibile'); return; }
    try { video.webkitSetPresentationMode('picture-in-picture'); log('webkitSetPresentationMode(picture-in-picture) chiamato'); }
    catch (e) { log(`webkitSetPresentationMode errore: ${errStr(e)}`); }
  }
  function apriPip() {
    if (clipInCorso) { log('clip ancora in registrazione: riprova tra poco con "Apri finestrella"'); return; }
    if (scelta('pip') === 'clip' && !clipUrl) log('ATTENZIONE: clip non disponibile, la finestrella userà il video diretto (metodo a)');
    if (video.paused) video.play().catch(e => log(`video play errore: ${errStr(e)}`));
    if (sup.requestPictureInPicture && document.pictureInPictureEnabled !== false) {
      try {
        video.requestPictureInPicture()
          .then(() => log('requestPictureInPicture OK'))
          .catch(e => { log(`requestPictureInPicture rifiutato: ${errStr(e)} -> provo webkitSetPresentationMode`); webkitPip(); });
      } catch (e) { log(`requestPictureInPicture errore: ${errStr(e)}`); webkitPip(); }
    } else { log('requestPictureInPicture non disponibile -> uso webkitSetPresentationMode'); webkitPip(); }
  }
  function chiudiPip() {
    try {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(e => log(`exitPictureInPicture errore: ${errStr(e)}`));
      else if (video.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode('inline');
    } catch (e) { log(`uscita finestrella errore: ${errStr(e)}`); }
  }
  video.addEventListener('enterpictureinpicture', () => log('EVENTO: entrato in finestrella (PiP)'));
  video.addEventListener('leavepictureinpicture', () => log('EVENTO: uscito dalla finestrella (PiP)'));
  video.addEventListener('webkitpresentationmodechanged', () => log(`EVENTO: presentationMode = ${video.webkitPresentationMode}`));
  video.addEventListener('pause', () => log(`EVENTO: video in pausa (finestrella: ${inPip()})`));
  video.addEventListener('play', () => log('EVENTO: video play'));
  video.addEventListener('error', () => log(`EVENTO: errore video ${video.error ? video.error.code + ' ' + video.error.message : ''}`));

  /* ---------- audio ---------- */
  const raw = {};
  const fileAudio = { start: '../audio/start/01start.m4a', finish: '../audio/finish/01finish.m4a' };
  for (const [k, url] of Object.entries(fileAudio)) {
    raw[k] = fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .catch(e => { log(`download ${url} fallito: ${errStr(e)}`); return null; });
  }

  function impostaSessione() {
    const m = scelta('sess');
    if (!sup.audioSession) { log(`sessione ${m}: navigator.audioSession non esiste, nessuna impostazione possibile`); return; }
    // 'auto' è il valore predefinito: impostarlo annulla una scelta precedente fatta in questa pagina
    try { navigator.audioSession.type = m; } catch (e) { log(`audioSession.type=${m} errore: ${errStr(e)}`); }
    log(`audioSession.type ora: ${navigator.audioSession.type} (scelta: ${m})`);
  }

  function bip(tipo, at) {
    const len = tipo === 'short' ? 0.16 : tipo === 'long' ? 0.65 : 1.0;
    const o = ctx.createOscillator(), gn = ctx.createGain();
    o.type = 'square';
    o.frequency.value = tipo === 'short' ? 880 : 1320;
    gn.gain.setValueAtTime(0, at);
    gn.gain.linearRampToValueAtTime(0.32, at + 0.006);
    gn.gain.setValueAtTime(0.32, at + len - 0.03);
    gn.gain.linearRampToValueAtTime(0, at + len);
    o.connect(gn).connect(out);
    o.start(at); o.stop(at + len + 0.02);
    sources.push(o);
  }
  function voce(buf, at, nome) {
    if (!buf) { log(`voce ${nome} mancante: non programmata`); return; }
    const s = ctx.createBufferSource();
    s.buffer = buf; s.connect(out); s.start(at);
    sources.push(s);
  }

  async function start() {
    if (ctx) ferma('nuovo START');
    log(`--- START: sessione=${scelta('sess')}, finestrella=${scelta('pip')} ---`);
    // 1) sessione PRIMA del contesto audio
    impostaSessione();
    if (!AC) { log('AudioContext non supportato'); return; }
    // 2) contesto audio e finestrella dentro il tocco (prima di ogni attesa)
    let c;
    try { c = new AC(); } catch (e) { log(`AudioContext errore: ${errStr(e)}`); return; }
    ctx = c;
    out = c.createGain(); out.connect(c.destination);
    c.onstatechange = () => log(`ctx.state = ${c.state} (t audio ${c.currentTime.toFixed(2)})`);
    log(`ctx creato, state=${c.state}, sampleRate=${c.sampleRate}`);
    c.resume().catch(e => log(`ctx.resume errore: ${errStr(e)}`));
    apriPip();
    // 3) decodifica voci, poi programma TUTTO sull'orologio audio
    const dec = async k => { const b = await raw[k]; if (!b) return null; try { return await c.decodeAudioData(b.slice(0)); } catch (e) { log(`decodifica ${k} fallita: ${errStr(e)}`); return null; } };
    const [vStart, vFinish] = await Promise.all([dec('start'), dec('finish')]);
    if (ctx !== c) return;   // STOP premuto nel frattempo
    log(`voci decodificate: start=${!!vStart} finish=${!!vFinish}`);
    const t0 = c.currentTime + 0.5;
    voce(vStart, t0, 'start');
    for (let s = 10; s < DURATA; s += 10) bip(s % 60 === 0 ? 'long' : 'short', t0 + s);
    for (const s of [30, 90, 150]) voce(vFinish, t0 + s + 0.2, 'finish');   // +0,2 s: non coprire il bip dello stesso secondo
    bip('final', t0 + DURATA);
    T0 = t0; wallStart = Date.now() + 500; finitoLoggato = false;
    log(`programmati ${sources.length} suoni da t audio ${t0.toFixed(2)} (bip ogni 10 s, lungo ogni minuto, voce finish a 0:30 1:30 2:30, finale a 3:00)`);
  }

  function ferma(perche = 'STOP') {
    log(`--- ${perche} ---`);
    for (const s of sources) try { s.stop(); } catch { /* già fermo */ }
    sources = [];
    const c = ctx; ctx = null; T0 = null; out = null;
    if (c) c.close().then(() => log('ctx chiuso')).catch(e => log(`ctx.close errore: ${errStr(e)}`));
    chiudiPip();
  }

  /* ---------- uscite e rientri ---------- */
  let nascostaDa = null, audioDa = null;
  document.addEventListener('visibilitychange', () => {
    const st = ctx ? ctx.state : 'nessun contesto';
    if (document.hidden) {
      nascostaDa = Date.now(); audioDa = ctx ? ctx.currentTime : null;
      log(`visibilitychange: NASCOSTA (ctx ${st}, finestrella ${inPip()}, video in pausa ${video.paused})`);
    } else {
      log(`visibilitychange: VISIBILE (ctx ${st}, finestrella ${inPip()}, video in pausa ${video.paused})`);
      if (nascostaDa !== null) {
        const fuori = (Date.now() - nascostaDa) / 1000;
        const avanti = ctx && audioDa !== null ? (ctx.currentTime - audioDa).toFixed(1) + ' s' : 'n/d';
        log(`RIEPILOGO RIENTRO: fuori ${fuori.toFixed(1)} s; orologio audio avanzato di ${avanti}; ctx.state ${st}` +
          (ctx && audioDa !== null && ctx.currentTime - audioDa < fuori - 2 ? ' -> AUDIO FERMO mentre eri fuori' : ''));
        nascostaDa = null;
      }
    }
  });
  window.addEventListener('pagehide', () => log('pagehide'));
  window.addEventListener('pageshow', e => log(`pageshow (dalla cache: ${e.persisted})`));
  document.addEventListener('freeze', () => log('freeze (pagina congelata)'));
  document.addEventListener('resume', () => log('resume (pagina scongelata)'));

  /* ---------- pulsanti ---------- */
  $('start').addEventListener('click', () => { start().catch(e => log(`START errore: ${errStr(e)}`)); });
  $('stop').addEventListener('click', () => ferma('STOP'));
  $('pipbtn').addEventListener('click', apriPip);
  $('copy').addEventListener('click', () => {
    const testo = righe.join('\n');
    const box = $('copybox');
    const mostra = () => { box.style.display = 'block'; box.value = testo; box.focus(); box.select(); log('copia automatica non riuscita: seleziona il testo nel riquadro e copia'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(testo).then(() => log('registro copiato negli appunti')).catch(mostra);
    else mostra();
  });
})();
