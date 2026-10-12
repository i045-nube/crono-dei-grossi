'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const pad = n => String(n).padStart(2, '0');

  /* ================= impostazioni salvate sul telefono ================= */
  const KEY = 'crono-dei-grossi';
  const DEFAULTS = { emom: { round: 60, rounds: 10 }, tabata: { work: 20, rest: 10, rounds: 8 }, timer: { dur: 300 }, voices: true };
  const LIMITS = { round: [5, 5999], work: [5, 5999], rest: [0, 5999], dur: [5, 5999], rounds: [1, 99] };
  const STEP = { round: 5, work: 5, rest: 5, dur: 5, rounds: 1 };
  const clone = o => JSON.parse(JSON.stringify(o));

  function load() {
    const d = clone(DEFAULTS);
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s) {
        for (const m of ['emom', 'tabata', 'timer']) for (const k in d[m]) if (Number.isFinite(s[m]?.[k])) d[m][k] = clamp(k, s[m][k]);
        if (typeof s.voices === 'boolean') d.voices = s.voices;
      }
    } catch { /* memoria non disponibile: valori predefiniti */ }
    return d;
  }
  function store() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* memoria piena o bloccata */ } }
  function clamp(k, v) { const [lo, hi] = LIMITS[k]; return Math.min(hi, Math.max(lo, Math.round(v))); }
  let cfg = load();

  const fmtClock = s => s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  const fmtTotal = s => s >= 3600 ? fmtClock(s) : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  const totalOf = (m, c) => m === 'emom' ? c.round * c.rounds : m === 'tabata' ? (c.work + c.rest) * c.rounds : c.dur;

  /* ================= audio: bip generati, voci, esplosione ================= */
  const AUDIO_SESSION = 'playback';
  const BOOM_GAIN = 0.6; // boom.m4a è a -10.3 LUFS: con 0.6 (-4.4 dB) sta a circa -14.7, un po' sopra le voci (-18)
  const AC = window.AudioContext || window.webkitAudioContext;
  // raw: i file scaricati (copie intatte), per poter ricreare il contesto audio e ridecodificarli quando iPhone lo rompe
  const audio = { ctx: null, out: null, voices: { start: [], finish: [] }, boom: null, raw: { start: [], finish: [], boom: null },
    last: {}, pending: [], voiceSrc: null, stale: false, bg: null };

  function initAudio() {
    // iPhone (Safari 17+): 'playback' si sente anche col telefono in silenzioso ma ferma la musica di altre app;
    // 'transient' lascia suonare la musica ma col silenzioso i bip non si sentono. Va impostata prima del contesto.
    try { if (navigator.audioSession) navigator.audioSession.type = AUDIO_SESSION; } catch { /* non supportato */ }
    if (!AC) return;
    newContext();
    const get = url => fetch(url).then(r => r.arrayBuffer()).catch(() => null);
    fetch('audio/voci.json').then(r => r.json()).then(list => Promise.all(['start', 'finish'].map(kind =>
      Promise.all((list[kind] || []).map(get)).then(bufs => { audio.raw[kind] = bufs.filter(Boolean); })
    ))).catch(() => {}).then(() => decodeAll(audio.ctx, ['start', 'finish']));
    get('audio/boom.m4a').then(b => { audio.raw.boom = b; decodeAll(audio.ctx, ['boom']); });
  }

  // decodeAudioData consuma il buffer: si decodifica sempre una copia. I suoni vecchi restano in uso finché i nuovi non sono pronti.
  function decodeAll(ctx, kinds = ['start', 'finish', 'boom']) {
    const dec = b => ctx.decodeAudioData(b.slice(0)).catch(() => null);
    for (const kind of kinds.filter(k => k !== 'boom')) {
      if (!audio.raw[kind].length) continue;
      Promise.all(audio.raw[kind].map(dec)).then(bufs => { if (audio.ctx === ctx) audio.voices[kind] = bufs.filter(Boolean); });
    }
    if (kinds.includes('boom') && audio.raw.boom) dec(audio.raw.boom).then(buf => { if (audio.ctx === ctx && buf) audio.boom = buf; });
  }

  // contesto audio nuovo (al primo avvio e quando iPhone lascia quello vecchio muto o chiuso)
  function newContext() {
    const old = audio.ctx;
    if (old) { old.onstatechange = null; old.close().catch(() => {}); }
    const ctx = audio.ctx = new AC();
    audio.out = ctx.createDynamicsCompressor();
    audio.out.connect(ctx.destination);
    audio.pending = [];
    audio.voiceSrc = null;
    if (audio.bg) run.boomDone = false; // l'esplosione affidata al contesto vecchio è persa
    audio.bg = null;
    ctx.onstatechange = () => {
      if (ctx !== audio.ctx || run.status !== 'running') return;
      if (ctx.state === 'closed') { newContext(); unlockAudio(); } else if (ctx.state !== 'running') ctx.resume().catch(() => {});
    };
    if (old) {
      decodeAll(ctx);
      // i bip già programmati sul contesto vecchio sono persi: si riparte dal prossimo evento
      if (run.status === 'running') realign();
    }
  }

  // iPhone e Android fanno partire l'audio solo dopo un tocco: lo si sblocca premendo START o Riprendi,
  // non al primo tocco qualsiasi, per non disturbare la musica di altre app finché non si parte
  function unlockAudio() {
    if (!AC) return;
    // tornati da un'altra app il contesto può restare muto anche se dice 'running' (iPhone):
    // al primo tocco utile lo si ricrea, perché solo dentro un tocco iPhone lo lascia ripartire
    if (!audio.ctx || audio.stale || audio.ctx.state === 'closed') { newContext(); audio.stale = false; }
    const ctx = audio.ctx;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination);
    s.start(0);
  }

  function beep(type, delay) {
    const ctx = audio.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const len = type === 'short' ? 0.16 : type === 'long' ? 0.65 : 1.0;
    const freq = type === 'short' ? 880 : 1320;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.006);
    g.gain.setValueAtTime(0.32, t + len - 0.03);
    g.gain.linearRampToValueAtTime(0, t + len);
    o.connect(g).connect(audio.out);
    o.start(t);
    o.stop(t + len + 0.02);
    o.at = t;
    audio.pending.push(o);
    o.onended = () => { audio.pending = audio.pending.filter(x => x !== o); };
  }
  function cancelBeeps() { for (const o of audio.pending) try { o.stop(); } catch { /* già fermo */ } audio.pending = []; }

  function playVoice(kind, delay = 0) {
    const list = audio.voices[kind];
    if (!cfg.voices || !audio.ctx || !list.length) return null;
    let i;
    do i = Math.floor(Math.random() * list.length); while (list.length > 1 && i === audio.last[kind]);
    audio.last[kind] = i;
    const s = audio.ctx.createBufferSource();
    s.buffer = list[i];
    s.connect(audio.out);
    s.start(s.at = audio.ctx.currentTime + delay);
    audio.voiceSrc = s;
    return s;
  }
  function stopVoice() { try { audio.voiceSrc?.stop(); } catch { /* già finita */ } audio.voiceSrc = null; }

  function boomSound(delay) {
    const ctx = audio.ctx;
    if (!ctx || !audio.boom) return null;
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = audio.boom;
    g.gain.value = BOOM_GAIN;
    s.connect(g).connect(audio.out);
    s.start(s.at = ctx.currentTime + delay);
    return s;
  }

  /* ===== app in secondo piano (iPhone): il JavaScript si ferma, il motore audio forse no ===== */
  // Si affidano subito al motore audio tutti i bip rimasti, più esplosione e voce finale: se iPhone tiene vivo l'audio
  // (sessione 'playback' + il file muto qui sotto in riproduzione) suonano anche mentre si usa un'altra app. Non garantito.
  // solo su iPhone/iPad (gli iPad recenti si presentano come Mac con touch): su Android e altri non serve
  const IOS = !/Android/i.test(navigator.userAgent) &&
    (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const keepAlive = AC && IOS ? new Audio('audio/silenzio.m4a') : null;
  if (keepAlive) { keepAlive.loop = true; keepAlive.preload = 'auto'; }
  function keepAudioAlive(on) {
    if (!keepAlive) return;
    try { if (on) keepAlive.play().catch(() => {}); else keepAlive.pause(); } catch { /* non supportato */ }
  }

  function scheduleBackground() {
    if (!audio.ctx || run.status !== 'running' || audio.bg) return;
    const e = elapsed();
    for (; run.next < run.events.length; run.next++) {
      const ev = run.events[run.next];
      if (e - ev.t <= 0.3) beep(ev.type, Math.max(0, ev.t - e));
    }
    audio.bg = [];
    if (Number.isFinite(run.end) && run.end > e) {
      const d = run.end - e;
      audio.bg.push(boomSound(d + 1.1));
      if (run.mode === 'emom' || run.mode === 'tabata') audio.bg.push(playVoice('finish', d + 1.5));
      audio.bg = audio.bg.filter(Boolean);
      run.boomDone = audio.bg.length > 0; // l'esplosione è già affidata al motore audio: finish() non la ripete
    }
  }

  // di nuovo in primo piano: si fermano i suoni affidati e non ancora partiti e si torna alla programmazione normale
  // (quelli già partiti restano: niente bip doppi né mancanti)
  function leaveBackground() {
    if (!audio.bg || !audio.ctx) return;
    const now = audio.ctx.currentTime, waiting = n => n.at > now;
    for (const o of audio.pending.filter(waiting)) try { o.stop(); } catch { /* già fermo */ }
    audio.pending = audio.pending.filter(o => !waiting(o));
    if (audio.bg.some(waiting) && !audio.bg.some(n => n.at <= now && n.buffer === audio.boom)) {
      for (const n of audio.bg) try { n.stop(); } catch { /* già fermo */ }
      run.boomDone = false;
    }
    audio.bg = null;
    realign(true); // gli eventi fino a adesso sono già partiti (e tenuti)
  }

  // prossimo bip da programmare = primo evento non ancora passato
  function realign(after = false) {
    const e = elapsed();
    run.next = run.events.findIndex(ev => after ? ev.t > e : ev.t >= e);
    if (run.next < 0) run.next = run.events.length;
  }

  function onForeground() {
    if (run.status !== 'running') return;
    leaveBackground();
    const ctx = audio.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    setTimeout(() => {
      if (ctx === audio.ctx && run.status === 'running' && ctx.state !== 'running') { newContext(); audio.ctx.resume().catch(() => {}); }
    }, 300);
    // al primo tocco il contesto viene ricreato dentro il gesto (unlockAudio), l'unico modo sicuro su iPhone
    const onTouch = () => {
      document.removeEventListener('touchend', onTouch, true);
      document.removeEventListener('click', onTouch, true);
      if (run.status === 'running') unlockAudio();
    };
    document.addEventListener('touchend', onTouch, true);
    document.addEventListener('click', onTouch, true);
  }

  /* ================= schermo sempre acceso durante l'allenamento ================= */
  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && !wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      } else if (!on && wake) {
        await wake.release();
        wake = null;
      }
    } catch { /* non supportato o rifiutato */ }
  }

  /* ================= contatore ================= */
  const NAMES = { emom: 'EMOM', tabata: 'TABATA', timer: 'TIMER', crono: 'CRONO' };
  const PHASE = { ready: 'PRONTI', work: 'GO', rest: 'RIPOSO', up: 'GO' };
  const READY = 10;
  const C = 552.92; // circonferenza del cerchio (r = 88)
  const runEl = $('#run'), digitsEl = $('#digits'), phaseEl = $('#phase'), progEl = $('#prog'), segEl = $('#segments');
  const run = { mode: 'emom', segs: [], rounds: 0, end: 0, events: [], next: 0, status: 'idle', t0: 0, pausedAt: 0, boomDone: false };

  function build(mode) {
    // TIMER e CRONO partono subito, senza i 10 s di PRONTI
    const segs = mode === 'emom' || mode === 'tabata' ? [{ kind: 'ready', dur: READY, round: 1 }] : [];
    let rounds = 0;
    if (mode === 'emom') {
      rounds = cfg.emom.rounds;
      for (let r = 1; r <= rounds; r++) segs.push({ kind: 'work', dur: cfg.emom.round, round: r });
    } else if (mode === 'tabata') {
      rounds = cfg.tabata.rounds;
      for (let r = 1; r <= rounds; r++) {
        segs.push({ kind: 'work', dur: cfg.tabata.work, round: r });
        if (cfg.tabata.rest > 0) segs.push({ kind: 'rest', dur: cfg.tabata.rest, round: r });
      }
    } else if (mode === 'timer') {
      segs.push({ kind: 'work', dur: cfg.timer.dur, round: 1 });
    } else {
      segs.push({ kind: 'up', dur: Infinity, round: 1 });
    }
    let t = 0;
    const events = [];
    for (const s of segs) {
      s.start = t;
      if (s.kind !== 'ready') events.push({ t, type: 'long' });
      if (Number.isFinite(s.dur)) for (let k = 3; k >= 1; k--) if (s.dur > k) events.push({ t: t + s.dur - k, type: 'short' });
      t += s.dur;
    }
    // il bip lungo di partenza del segmento successivo sostituisce quello di fine; alla fine di tutto, bip finale
    if (Number.isFinite(t)) events.push({ t, type: 'end' });
    events.sort((a, b) => a.t - b.t);
    Object.assign(run, { mode, segs, rounds, end: t, events, next: 0, boomDone: false });
  }

  const elapsed = () => run.status === 'running' ? (Date.now() - run.t0) / 1000 : run.status === 'paused' ? (run.pausedAt - run.t0) / 1000 : 0;

  function segAt(e) {
    for (let i = run.segs.length - 1; i >= 0; i--) if (e >= run.segs[i].start) return run.segs[i];
    return run.segs[0];
  }

  let shown = '';
  function setDigits(str) {
    if (str === shown) return;
    shown = str;
    digitsEl.innerHTML = [...str].map(ch => ch === ':' ? '<span class="sep">:</span>' : `<span class="d">${ch}</span>`).join('');
    digitsEl.classList.toggle('long', str.length > 5);
  }

  function renderSegments(round, frac) {
    const n = run.rounds;
    if (!n) return;
    if (n <= 24) {
      if (segEl.children.length !== n || segEl.classList.contains('bar')) {
        segEl.classList.remove('bar');
        segEl.innerHTML = '<i></i>'.repeat(n);
      }
      [...segEl.children].forEach((el, i) => { el.className = i < round - 1 ? 'done' : i === round - 1 && run.status !== 'idle' ? 'on' : ''; });
    } else {
      if (!segEl.classList.contains('bar')) { segEl.classList.add('bar'); segEl.innerHTML = '<i></i>'; }
      segEl.firstChild.style.width = `${Math.min(100, ((round - 1 + frac) / n) * 100)}%`;
    }
  }

  function render() {
    const e = elapsed();
    let phase = '', text, fill, round = 1, kind = 'idle', frac = 0;
    if (run.status === 'idle') {
      const first = run.segs.find(s => s.kind !== 'ready');
      text = fmtClock(Number.isFinite(first.dur) ? first.dur : 0);
      fill = 1;
    } else if (run.status === 'done') {
      phase = 'FINE';
      text = fmtClock(0);
      fill = 0;
      round = run.rounds;
      frac = 1;
    } else {
      const s = segAt(e);
      kind = s.kind;
      round = s.round;
      phase = PHASE[kind];
      if (kind === 'up') {
        const up = Math.floor(e - s.start);
        text = fmtClock(up);
        fill = ((e - s.start) % 60) / 60;
      } else {
        const left = s.start + s.dur - e;
        text = fmtClock(Math.max(0, Math.ceil(left - 1e-6)));
        fill = left / s.dur;
        if (kind !== 'ready') frac = 1 - fill;
      }
      if (run.status === 'paused') phase = 'PAUSA';
    }
    runEl.dataset.phase = kind;
    runEl.classList.toggle('paused', run.status === 'paused');
    phaseEl.textContent = phase;
    setDigits(text);
    progEl.style.strokeDashoffset = (C * (1 - Math.max(0, Math.min(1, fill)))).toFixed(1);
    $('#round-n').textContent = round;
    $('#round-t').textContent = run.rounds;
    renderSegments(round, frac);
    renderControls();
  }

  function renderControls() {
    const st = run.status;
    $('#main-ico').setAttribute('href', st === 'running' ? '#i-pause' : '#i-play');
    $('#main-label').textContent = st === 'running' ? 'Pausa' : st === 'paused' ? 'Riprendi' : 'Start';
    $('#btn-reset').disabled = st === 'idle';
  }

  function scheduleBeeps(e) {
    while (run.next < run.events.length && run.events[run.next].t <= e + 0.3) {
      const ev = run.events[run.next++];
      if (e - ev.t > 0.3) continue; // perso mentre l'app era in secondo piano
      beep(ev.type, Math.max(0, ev.t - e));
    }
  }

  let raf = 0;
  function loop() {
    cancelAnimationFrame(raf);
    if (run.status !== 'running') return;
    tick();
    raf = requestAnimationFrame(loop);
  }
  function tick() {
    if (run.status !== 'running') return;
    const e = elapsed();
    scheduleBeeps(e);
    if (e >= run.end) finish(e - run.end);
    else render();
  }
  setInterval(tick, 250); // continua anche quando il browser rallenta le animazioni

  function start() {
    unlockAudio();
    build(run.mode);
    run.status = 'running';
    run.t0 = Date.now();
    if (run.mode === 'emom' || run.mode === 'tabata') playVoice('start');
    keepAwake(true);
    keepAudioAlive(true);
    loop();
  }
  function pause() {
    if (run.status !== 'running') return;
    run.status = 'paused';
    run.pausedAt = Date.now();
    cancelBeeps();
    keepAudioAlive(false);
    render();
  }
  function resume() {
    unlockAudio();
    run.t0 += Date.now() - run.pausedAt;
    run.status = 'running';
    realign();
    keepAwake(true);
    keepAudioAlive(true);
    loop();
  }
  function reset() {
    cancelBeeps();
    stopVoice();
    closeBoom();
    for (const n of audio.bg || []) try { n.stop(); } catch { /* già fermo */ }
    audio.bg = null;
    keepAudioAlive(false);
    run.status = 'idle';
    build(run.mode);
    keepAwake(false);
    render();
  }
  function finish(late) {
    run.status = 'done';
    keepAwake(false);
    // il file muto si ferma solo dopo l'esplosione: se la fine arriva in secondo piano serve ancora
    setTimeout(() => { if (run.status !== 'running') keepAudioAlive(false); }, 3000);
    render();
    explode(late < 2 && !run.boomDone);
  }

  function openRun(mode) {
    run.mode = mode;
    runEl.dataset.mode = mode;
    $('#run-name').textContent = NAMES[mode];
    reset();
  }

  $('#btn-main').addEventListener('click', () => {
    if (run.status === 'idle') start();
    else if (run.status === 'running') pause();
    else if (run.status === 'paused') resume();
  });
  $('#btn-reset').addEventListener('click', reset);
  $('#btn-set').addEventListener('click', () => {
    pause();
    openSettings(run.mode, 'run');
  });

  /* ================= fine esercizio: la bomba esplode ================= */
  const boomEl = $('#boom');
  let boomTimers = [], boomRaf = 0;

  function explode(withSound) {
    closeBoom();
    boomEl.hidden = false;
    boomEl.className = 'boom';
    if (withSound) {
      boomSound(1.1);
      if (run.mode === 'emom' || run.mode === 'tabata') playVoice('finish', 1.5);
    }
    boomTimers.push(setTimeout(() => {
      particles();
      boomEl.classList.add('blast');
      runEl.classList.add('shake');
    }, 1100));
    boomTimers.push(setTimeout(() => runEl.classList.remove('shake'), 1700));
    boomTimers.push(setTimeout(() => boomEl.classList.add('done'), 2300));
  }
  function closeBoom() {
    boomTimers.forEach(clearTimeout);
    boomTimers = [];
    cancelAnimationFrame(boomRaf);
    runEl.classList.remove('shake');
    boomEl.hidden = true;
  }

  function particles() {
    const cv = $('#boom-fx'), box = cv.getBoundingClientRect(), bomb = $('.bomb').getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = box.width * dpr;
    cv.height = box.height * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // centro della sfera della bomba (54,70 su 120 nel disegno)
    const cx = bomb.left - box.left + bomb.width * 0.45, cy = bomb.top - box.top + bomb.height * 0.58;
    const k = Math.min(box.width, box.height) / 400, rnd = (a, b) => a + Math.random() * (b - a);
    const COLORS = ['#ffffff', '#fff27a', '#ffd60a', '#ff9f00', '#ff5a00'];
    const sparks = Array.from({ length: 110 }, () => {
      const a = rnd(0, Math.PI * 2), v = rnd(4, 15) * k;
      return { x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(35, 70), age: 0, c: COLORS[Math.floor(Math.random() * COLORS.length)], w: rnd(1.5, 4) * k };
    });
    const debris = Array.from({ length: 22 }, () => {
      const a = rnd(0, Math.PI * 2), v = rnd(3, 10) * k;
      return { x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3 * k, r: rnd(0, 6), vr: rnd(-0.3, 0.3), s: rnd(4, 10) * k, age: 0, life: rnd(50, 80) };
    });
    const smoke = Array.from({ length: 16 }, () => {
      const a = rnd(0, Math.PI * 2), v = rnd(0.6, 2.4) * k;
      return { x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.4 * k, r: rnd(18, 34) * k, age: 0, life: rnd(50, 80) };
    });
    function frame() {
      g.clearRect(0, 0, box.width, box.height);
      let alive = false;
      for (const p of smoke) {
        if (p.age++ > p.life) continue;
        alive = true;
        p.x += p.vx; p.y += p.vy; p.r += 0.9 * k;
        g.fillStyle = `rgba(255,255,255,${0.55 * (1 - p.age / p.life)})`;
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
      }
      for (const p of debris) {
        if (p.age++ > p.life) continue;
        alive = true;
        p.x += p.vx; p.y += p.vy; p.vy += 0.35 * k; p.r += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.r);
        g.fillStyle = `rgba(30,31,35,${1 - p.age / p.life})`;
        g.fillRect(-p.s / 2, -p.s / 3, p.s, p.s / 1.5);
        g.restore();
      }
      g.globalCompositeOperation = 'lighter';
      for (const p of sparks) {
        if (p.age++ > p.life) continue;
        alive = true;
        const x0 = p.x, y0 = p.y;
        p.x += p.vx; p.y += p.vy; p.vx *= 0.96; p.vy = p.vy * 0.96 + 0.22 * k;
        g.strokeStyle = p.c;
        g.globalAlpha = 1 - p.age / p.life;
        g.lineWidth = p.w;
        g.lineCap = 'round';
        g.beginPath(); g.moveTo(x0 - p.vx * 1.5, y0 - p.vy * 1.5); g.lineTo(p.x, p.y); g.stroke();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      if (alive) boomRaf = requestAnimationFrame(frame);
      else g.clearRect(0, 0, box.width, box.height);
    }
    frame();
  }

  $('#boom-again').addEventListener('click', reset);
  $('#boom-home').addEventListener('click', () => { reset(); history.back(); });

  /* ================= impostazioni ================= */
  const FIELDS = {
    emom: [['round', 'DURATA ROUND'], ['rounds', 'NUMERO ROUND']],
    tabata: [['work', 'LAVORO'], ['rest', 'RIPOSO'], ['rounds', 'NUMERO ROUND']],
    timer: [['dur', 'DURATA']],
  };
  const setUI = { tab: 'emom', from: 'home', draft: null };
  const fieldsEl = $('#fields');

  const stepBtn = (d, label) => `<button class="step" data-d="${d}" aria-label="${label}"><svg viewBox="0 0 24 24"><use href="#i-${d > 0 ? 'plus' : 'minus'}"/></svg></button>`;
  const box = (part, unit, label) => `<label class="tbox"><input data-part="${part}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" autocomplete="off" aria-label="${label}"><small>${unit}</small></label>`;

  function renderFields() {
    const tab = setUI.tab;
    $$('.tab', $('#tabs')).forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    fieldsEl.innerHTML = FIELDS[tab].map(([k, label]) => `<div class="field" data-key="${k}"><span class="f-lab">${label}</span><div class="f-row">
      ${stepBtn(-1, 'Meno')}<div class="lcd">${k === 'rounds' ? box('n', 'ROUND', label) : box('m', 'MIN', `${label} minuti`) + '<span class="colon">:</span>' + box('s', 'SEC', `${label} secondi`)}</div>${stepBtn(1, 'Più')}
    </div></div>`).join('');
    fillFields();
  }
  function fillFields() {
    const c = setUI.draft[setUI.tab];
    for (const f of $$('.field', fieldsEl)) {
      const v = c[f.dataset.key];
      for (const inp of $$('input', f)) {
        if (inp === document.activeElement) continue;
        inp.value = inp.dataset.part === 'n' ? v : pad(inp.dataset.part === 'm' ? Math.floor(v / 60) : v % 60);
      }
    }
    $('#total').textContent = fmtTotal(totalOf(setUI.tab, c));
  }
  function readField(f) {
    const k = f.dataset.key, num = p => parseInt($(`input[data-part="${p}"]`, f).value, 10) || 0;
    return clamp(k, k === 'rounds' ? num('n') : num('m') * 60 + Math.min(59, num('s')));
  }
  function commitField(f) {
    setUI.draft[setUI.tab][f.dataset.key] = readField(f);
    fillFields();
  }

  function openSettings(tab, from) {
    setUI.tab = tab === 'crono' ? 'emom' : tab;
    setUI.from = from;
    setUI.draft = clone(cfg);
    renderFields();
    go('set', { tab: setUI.tab, from });
  }

  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (!b) return;
    document.activeElement?.blur();
    setUI.tab = b.dataset.tab;
    renderFields();
  });

  fieldsEl.addEventListener('focusin', e => {
    if (e.target.tagName !== 'INPUT') return;
    e.target.closest('.tbox').classList.add('editing');
    setTimeout(() => e.target.select(), 0);
  });
  fieldsEl.addEventListener('focusout', e => {
    if (e.target.tagName !== 'INPUT') return;
    e.target.closest('.tbox').classList.remove('editing');
    commitField(e.target.closest('.field'));
    window.scrollTo(0, 0);
  });
  fieldsEl.addEventListener('input', e => {
    const inp = e.target;
    inp.value = inp.value.replace(/\D/g, '').slice(0, 2);
    const f = inp.closest('.field'), c = { ...setUI.draft[setUI.tab], [f.dataset.key]: readField(f) };
    $('#total').textContent = fmtTotal(totalOf(setUI.tab, c));
    // dopo 2 cifre nei minuti si passa da soli ai secondi
    if (inp.dataset.part === 'm' && inp.value.length === 2) $('input[data-part="s"]', inp.closest('.field')).focus();
  });
  fieldsEl.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

  // − e +: un tocco = un passo; tenendo premuto il valore scorre
  let hold = 0;
  function stepOnce(btn) {
    const f = btn.closest('.field'), k = f.dataset.key, c = setUI.draft[setUI.tab];
    c[k] = clamp(k, c[k] + STEP[k] * Number(btn.dataset.d));
    fillFields();
  }
  function stopHold() { clearTimeout(hold); clearInterval(hold); hold = 0; }
  fieldsEl.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.step');
    if (!btn) return;
    e.preventDefault();
    document.activeElement?.blur();
    stepOnce(btn);
    stopHold();
    hold = setTimeout(() => { hold = setInterval(() => stepOnce(btn), 80); }, 420);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) fieldsEl.addEventListener(ev, stopHold);
  fieldsEl.addEventListener('click', e => { const btn = e.target.closest('.step'); if (btn && e.detail === 0) stepOnce(btn); }); // tastiera

  $('#btn-save').addEventListener('click', () => {
    document.activeElement?.blur();
    const changed = setUI.from === 'run' && JSON.stringify(cfg[run.mode]) !== JSON.stringify(setUI.draft[run.mode]);
    for (const m of ['emom', 'tabata', 'timer']) cfg[m] = setUI.draft[m];
    store();
    if (changed) reset();
    history.back();
  });

  /* ================= voci sì / no ================= */
  function renderVoice() {
    for (const b of $$('.voice-btn')) {
      b.setAttribute('aria-pressed', cfg.voices);
      b.setAttribute('aria-label', cfg.voices ? 'Voci attive' : 'Voci spente, solo bip');
      $('use', b).setAttribute('href', cfg.voices ? '#i-sound' : '#i-mute');
    }
  }
  $$('.voice-btn').forEach(b => b.addEventListener('click', () => {
    cfg.voices = !cfg.voices;
    if (!cfg.voices) stopVoice();
    store();
    renderVoice();
  }));

  /* ================= schermate e tasto "indietro" (anche quello di Android) ================= */
  const screens = { home: $('#home'), run: runEl, set: $('#set') };
  function show(name) { for (const [k, el] of Object.entries(screens)) el.hidden = k !== name; }
  function go(name, extra = {}) {
    history.pushState({ s: name, ...extra }, '');
    show(name);
  }
  window.addEventListener('popstate', e => {
    const st = e.state || { s: 'home' };
    document.activeElement?.blur();
    if (st.s !== 'run' && st.s !== 'set' && run.status !== 'idle') reset();
    if (st.s === 'set' && !setUI.draft) { history.back(); return; }
    show(st.s);
    if (st.s === 'run') render();
    reloadIfDue();
  });

  $$('.mode').forEach(b => b.addEventListener('click', () => {
    openRun(b.dataset.mode);
    go('run', { mode: b.dataset.mode });
  }));
  $$('[data-go="set"]').forEach(b => b.addEventListener('click', () => openSettings('emom', 'home')));
  $$('[data-back]').forEach(b => b.addEventListener('click', () => history.back()));

  /* ================= avvio ================= */
  $('#ticks').innerHTML = Array.from({ length: 60 }, (_, i) =>
    `<line x1="100" y1="3" x2="100" y2="${i % 5 === 0 ? -1 : 1}" transform="rotate(${i * 6} 100 100)"/>`).join('');
  history.replaceState({ s: 'home' }, '');
  show('home');
  renderVoice();
  openRun('emom');
  initAudio();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      if (audio.ctx) audio.stale = true; // al ritorno il contesto audio va ricreato al primo tocco
      scheduleBackground();
      return;
    }
    if (run.status === 'running' || run.status === 'paused') keepAwake(true);
    onForeground();
    if (run.status === 'running') tick();
    swReg?.update().catch(() => {}); // controllo versione anche se l'app resta aperta in secondo piano
    reloadIfDue();
  });
  window.addEventListener('pageshow', e => { if (e.persisted) { onForeground(); tick(); } });

  /* ================= aggiornamenti: la versione nuova si usa subito, ricaricando la pagina ================= */
  // mai durante un allenamento (anche in pausa), con la bomba aperta o nelle impostazioni: si aspetta il ritorno a riposo
  let swReg = null, reloadDue = false, reloading = false;
  function reloadIfDue() {
    if (!reloadDue || reloading || document.visibilityState !== 'visible') return;
    if (run.status !== 'idle' || !boomEl.hidden || !screens.set.hidden) return;
    reloading = true; // una volta sola
    location.reload();
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if ('serviceWorker' in navigator && (!local || location.search.includes('sw=1'))) {
    // senza controller è la prima installazione: la pagina ha già i file giusti, niente ricarica
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      reloadDue = true;
      reloadIfDue();
    });
    navigator.serviceWorker.register('sw.js').then(reg => { swReg = reg; reg.update().catch(() => {}); }).catch(() => {});
  }
})();
