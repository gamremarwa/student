// Study platform (grades 1–12). One family account (parent's email) holds several child profiles;
// editing, reports and grades unlock with a parent PIN. Catalog in config.js, tests in grades/g<N>/tests-<subject>.js.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js';
import { getFirestore, doc, getDoc, getDocs, deleteDoc, onSnapshot, setDoc, collection, query, where, serverTimestamp, arrayUnion, increment } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js';

const P = window.PLATFORM;
// current context: the selected child (or a visitor browsing a grade)
const S = { sid: null, name: '', grade: null, gradeName: '', subjects: [], firebase: P.firebase, mamaEmail: P.mamaEmail };
const BANKS = {};           // grade -> {subject -> bank}
let TESTS = {};             // banks of the grade being shown
const bankLoads = {};
function loadBank(id) { // grades/g<N>/tests-<subject>.js is fetched on first visit; a missing file just means no tests yet
  const g = S.grade, key = g + ':' + id;
  return bankLoads[key] ||= new Promise((ok) => {
    window.TESTS = {};
    const sc = document.createElement('script');
    sc.src = `grades/g${g}/tests-${id}.js?h=${Math.floor(Date.now() / 36e5)}`; // hourly cache-bust so new questions show up
    sc.onload = sc.onerror = () => { (BANKS[g] ||= {})[id] = window.TESTS[id]; ok(BANKS[g][id]); };
    document.head.appendChild(sc);
  });
}
const QUIZ_LEN = 30;
const DAYS = ['السبت', 'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
const $ = (id) => document.getElementById(id);
const app = $('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const subj = (id) => S.subjects.find((s) => s.id === id);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// ---- state synced from Firestore ----
let info = null;          // students/{sid}: {name, grade, note, noteAt, order, start, grades[]}
let results = {};         // current grade: `${subject}_${lesson}` -> result
let allResults = [];      // every result of the child, all grades (history is never deleted)
let isMama = false;       // this account is a parent of the child (account level)
let parentMode = false;   // parent PIN entered in this session -> may edit and see reports
let isStudentAcct = false;// child logged in with an own email
let canView = false;      // may see the child's private data
let user = null;
let access = { parents: [], students: [] };
let kids = [];            // [{sid, name, grade}] profiles this account can open
let pinHash = null;       // owners/{email}.pin
let role = null;          // owners/{email}.role: 'parent' | 'student' (asked once after sign-up)
let isParentAcct = false; // a parent account (may add children) even before any child exists
let requests = [];        // link requests children sent to this parent
let myRequest = null;     // this student's pending request to a parent
const myEmail = () => ((user && user.email) || '').toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const newSid = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let infoLoaded = false;
let unsubs = [];

const fb = initializeApp(S.firebase);
const auth = getAuth(fb);
const db = getFirestore(fb);
let infoRef = null, accessRef = null;
const canEdit = () => isMama && parentMode;
const famEdit = () => isParentAcct && parentMode; // family-level actions: add children, accept requests
const canSeeReport = () => canEdit() || isStudentAcct;
const gradeOf = (r) => r.grade || (P.legacy[r.sid] && P.legacy[r.sid].grade);

function setGrade(g) {
  S.grade = +g || 1; const G = P.grades[S.grade];
  S.gradeName = G.name; S.subjects = G.subjects; TESTS = BANKS[S.grade] ||= {};
  results = {}; allResults.filter((r) => gradeOf(r) === S.grade).forEach((r) => { results[`${r.subject}_${r.lesson}`] = r; });
  $('sgrade').textContent = S.gradeName;
  if (!S.sid) store.set('grade', S.grade);
}
function setChild(k) {
  S.sid = k ? k.sid : null; S.name = k ? k.name : '';
  infoRef = k ? doc(db, 'students', k.sid) : null; accessRef = k ? doc(db, 'access', k.sid) : null;
  if (k) store.set('kid', k.sid);
  $('sname').textContent = k ? k.name : 'منصة الطالب';
  setGrade(k ? k.grade : (+store.get('grade') || 1));
}

// private data is only fetched after login; visitors browse books and tests only
function subscribe() {
  unsubs.forEach((f) => f()); unsubs = [];
  info = {}; allResults = []; results = {}; infoLoaded = !canView;
  if (!canView || !S.sid) return;
  unsubs.push(onSnapshot(infoRef, (snap) => {
    info = snap.exists() ? snap.data() : {}; infoLoaded = true;
    if (info.grade && +info.grade !== S.grade) { const k = kids.find((x) => x.sid === S.sid); if (k) k.grade = +info.grade; setGrade(info.grade); }
    if (info.name && info.name !== S.name) { S.name = info.name; $('sname').textContent = S.name; }
    rerender();
  }, () => { infoLoaded = true; rerender(); }));
  unsubs.push(onSnapshot(query(collection(db, 'results'), where('sid', '==', S.sid)), (qs) => {
    allResults = []; qs.forEach((d) => allResults.push(d.data()));
    setGrade(S.grade); rerender();
  }, () => {}));
}
async function roleFor(sid) {
  const em = (user.email || '').toLowerCase();
  const acc = await getDoc(doc(db, 'access', sid)).then((d) => d.exists() ? d.data() : {}, () => ({}));
  access = { parents: acc.parents || [], students: acc.students || [] };
  const admin = em === S.mamaEmail || await getDoc(doc(db, 'editors', em)).then((d) => d.exists(), () => false);
  isMama = admin || access.parents.includes(em);
  isStudentAcct = !isMama && access.students.includes(em);
  canView = isMama || isStudentAcct;
}
async function openChild(sid) {
  const k = kids.find((x) => x.sid === sid); if (!k) return;
  parentMode = false; setChild(k); await roleFor(sid); updateLock(); subscribe(); go('#/'); rerender();
}
async function loadKids() {
  const em = myEmail();
  const ids = new Set(), par = new Set();
  for (const f of ['parents', 'students']) {
    const qs = await getDocs(query(collection(db, 'access'), where(f, 'array-contains', em))).catch(() => null);
    qs && qs.forEach((d) => { ids.add(d.id); if (f === 'parents') par.add(d.id); });
  }
  if (em === S.mamaEmail) Object.keys(P.legacy).forEach((sid) => { ids.add(sid); par.add(sid); }); // the original account owns the first two children
  kids = [];
  for (const sid of ids) {
    const d = await getDoc(doc(db, 'students', sid)).then((x) => x.exists() ? x.data() : {}, () => ({}));
    const L = P.legacy[sid] || {};
    kids.push({ sid, name: d.name || L.name || 'طالب', grade: +(d.grade || L.grade || 1), parent: par.has(sid) });
  }
  const o = await getDoc(doc(db, 'owners', em)).then((d) => d.exists() ? d.data() : {}, () => ({}));
  pinHash = o.pin || null; role = o.role || null;
  isParentAcct = em === S.mamaEmail || role === 'parent' || kids.some((k) => k.parent);
  requests = isParentAcct ? await getDocs(query(collection(db, 'requests'), where('to', '==', em)))
    .then((qs) => qs.docs.map((d) => ({ id: d.id, ...d.data() })), () => []) : [];
  myRequest = !isParentAcct && !kids.length ? await getDoc(doc(db, 'requests', em)).then((d) => d.exists() ? d.data() : null, () => null) : null;
}
onAuthStateChanged(auth, async (u) => {
  user = u; isMama = canView = isStudentAcct = parentMode = isParentAcct = false; kids = []; requests = []; role = myRequest = null; access = { parents: [], students: [] };
  if (u) {
    await loadKids();
    const last = store.get('kid'), k = kids.find((x) => x.sid === last) || kids[0];
    setChild(k || null);
    if (k) await roleFor(k.sid);
  } else setChild(null);
  $('mamaBtn').textContent = u ? `👤 ${(u.email || '').split('@')[0]} · خروج` : '👤 تسجيل الدخول';
  $('mamaBtn').classList.toggle('on', !!u);
  updateLock();
  subscribe();
  rerender();
  if (u && !role && !kids.length && !isParentAcct) askRole(); // new account: parent or student?
});

// ---- parent PIN (a family lock on top of the account password) ----
async function sha(t) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pin:' + t)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function updateLock() { const l = $('lockBtn'); if (!l) return; l.hidden = !(isMama || isParentAcct); l.textContent = parentMode ? '🔓 الأهل' : '🔒 الأهل'; l.classList.toggle('on', parentMode); }
let lockTimer;
function askPin(then) {
  if (!isMama && !isParentAcct) return toast('هذا للأهل فقط');
  if (parentMode) { parentMode = false; updateLock(); rerender(); return toast('تم قفل وضع الأهل 🔒'); }
  const m = $('modal'), first = !pinHash;
  $('modalBox').innerHTML = `<h3>🔒 رمز الأهل</h3><div class="muted">${first ? 'اختاري رمزاً سرياً (4 أرقام أو أكثر) لفتح التعديل والتقارير. لا تعطيه للأولاد.' : 'اكتبي الرمز السري لفتح وضع الأهل'}</div>
    <input type="password" id="pin" inputmode="numeric" placeholder="الرمز السري" dir="ltr">
    ${first ? '<input type="password" id="pin2" inputmode="numeric" placeholder="أعيدي الرمز" dir="ltr">' : ''}
    <div class="err" id="pinErr"></div>
    <div style="display:flex;gap:8px"><button class="btn" id="pinGo">فتح</button><button class="btn ghost" id="pinX">إلغاء</button></div>`;
  m.classList.add('show');
  $('pinGo').onclick = async () => {
    const v = $('pin').value.trim();
    if (v.length < 4) return $('pinErr').textContent = 'الرمز لازم يكون 4 خانات أو أكثر';
    if (first) {
      if (v !== $('pin2').value.trim()) return $('pinErr').textContent = 'الرمزين مش متطابقين';
      const h = await sha(v);
      try { await setDoc(doc(db, 'owners', (user.email || '').toLowerCase()), { pin: h }, { merge: true }); pinHash = h; }
      catch { return $('pinErr').textContent = 'ما زبط الحفظ — تأكدي إن قواعد Firebase محدّثة'; }
    } else if (await sha(v) !== pinHash) return $('pinErr').textContent = 'الرمز غير صحيح';
    parentMode = true; m.classList.remove('show'); updateLock(); toast('تم فتح وضع الأهل 🔓');
    clearTimeout(lockTimer); lockTimer = setTimeout(() => { parentMode = false; updateLock(); rerender(); }, 20 * 60e3); // auto-lock after 20 min
    then ? then() : rerender();
  };
  $('pin').onkeydown = (e) => { if (e.key === 'Enter') $('pinGo').click(); };
  $('pinX').onclick = () => m.classList.remove('show');
  setTimeout(() => $('pin').focus(), 50);
}
const loginCard = (what) => !user ? `<div class="card center"><div style="font-size:40px">🔒</div><h3>${what}</h3>
  <div class="muted" style="margin-bottom:10px">هذه المعلومات خاصة. سجّل الدخول بحساب العائلة لرؤيتها.</div>
  <button class="btn" onclick="document.getElementById('mamaBtn').click()">👤 تسجيل الدخول</button></div>`
  : isMama ? `<div class="card center"><div style="font-size:40px">🔒</div><h3>${what}</h3>
  <div class="muted" style="margin-bottom:10px">افتحي وضع الأهل بالرمز السري.</div>
  <button class="btn" onclick="document.getElementById('lockBtn').click()">🔓 فتح وضع الأهل</button></div>`
  : !S.sid ? `<div class="card center muted">ما في طالب مربوط بحسابك بعد. <a href="#/kids">أضيفي طالب</a></div>`
  : `<div class="card center muted">ما عندك صلاحية على هذا القسم.</div>`;

// ---- helpers ----
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2400);
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('ar-u-nu-latn', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function shuffle(a, rnd = Math.random) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function seeded(str) { // small deterministic PRNG so each student gets a stable default order
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
function badge(r) {
  if (!r) return '<span class="badge">لم يُختبر</span>';
  const cls = r.score >= 24 ? 'g' : r.score >= 15 ? 'a' : 'r';
  return `<span class="badge ${cls}">${r.score}/${QUIZ_LEN}</span>`;
}

// ---- schedule ----
function scheduleOrder() {
  const ids = S.subjects.map((s) => s.id);
  const saved = (info && info.order || []).filter((id) => ids.includes(id));
  if (saved.length === ids.length) return saved;
  return shuffle(ids, seeded(String(S.sid || S.grade)));
}
function lastSaturday(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); return x; }
function todaySlot(weeks) {
  const now = new Date();
  if (now.getDay() === 5) return null; // Friday
  const start = lastSaturday(info && info.start ? info.start.toDate() : new Date(2026, 9, 24));
  const w = Math.floor((lastSaturday(now) - start) / (7 * 864e5));
  return { week: ((w % weeks) + weeks) % weeks, day: (now.getDay() + 1) % 7 };
}

// ---- pages ----
const routes = {
  home() {
    const n = info && info.note;
    app.innerHTML = `
      <section class="note">
        <div class="head">🔔 تنبيه من ماما</div>
        ${canEdit() ? `
          <textarea id="noteTxt" placeholder="اكتبي ملاحظة لـ ${esc(S.name)}…">${esc(n || '')}</textarea>
          <div class="acts"><button class="btn red" id="saveNote">حفظ التنبيه</button>
          <button class="btn ghost" id="clearNote">مسح</button></div>`
        : `<div class="txt ${n ? '' : 'empty'}">${!canView ? '' : infoLoaded ? esc(n || 'لا يوجد تنبيه حالياً') : 'جاري التحميل…'}</div>`}
        ${info && info.noteAt ? `<div class="when">🕒 آخر تعديل: ${fmtDate(info.noteAt)}</div>` : ''}
      </section>
      ${user && !S.sid ? `<a class="card banner" href="${isParentAcct ? '#/kids' : '#/link'}">${isParentAcct ? '👧👦 أضيفي أولادك عشان تتابعي تقدّمهم' : '🔗 اربط حسابك مع ماما أو بابا عشان تنحفظ نتائجك'}</a>` : ''}
      <div class="big">
        <a class="bigbtn" href="#/schedule"><span class="ic">🗓️</span><b>جدول الدراسة</b><small>مادة لكل يوم</small></a>
        <a class="bigbtn" href="#/subjects"><span class="ic">📚</span><b>المواد</b><small>الكتب والاختبارات</small></a>
        <a class="bigbtn" href="#/report"><span class="ic">📊</span><b>التقرير</b><small>نقاط القوة والضعف</small></a>
        <a class="bigbtn" href="#/grades"><span class="ic">📝</span><b>علامات المدرسة</b><small>${canEdit() ? 'أضيفي علامة' : 'العلامات'}</small></a>
        <a class="bigbtn wide sw2" href="${isParentAcct && kids.length ? '#/kids' : '#/pick'}"><span class="ic">${isParentAcct && kids.length ? '👧👦' : '🎓'}</span><b>${isParentAcct && kids.length ? 'تبديل الطالب' : 'الصف'}</b><small>${esc(S.name ? S.name + ' — ' : '')}${esc(S.gradeName)}</small></a>
        <a class="bigbtn wide" href="#/ai"><span class="ic">🤖</span><b>المساعد الذكي</b><small>اسأله عن أي شيء في دروسك</small></a>
        ${canEdit() ? '<a class="bigbtn wide" href="#/accounts"><span class="ic">👥</span><b>الحسابات</b><small>الأهل والطالب المرتبطين بالحساب</small></a>' : ''}
      </div>`;
    if (canEdit()) {
      $('saveNote').onclick = () => saveNote($('noteTxt').value.trim());
      $('clearNote').onclick = () => { $('noteTxt').value = ''; saveNote(''); };
    }
  },

  schedule() {
    const order = scheduleOrder();
    const weeks = Math.max(1, Math.ceil(order.length / DAYS.length));
    const slot = todaySlot(weeks);
    const todaySubj = slot && slot.day < 6 ? subj(order[slot.week * 6 + slot.day]) : null;
    let html = `<h2 class="page">🗓️ جدول الدراسة</h2>`;
    html += slot === null
      ? `<div class="today"><span class="ic">🌴</span><div><b>اليوم الجمعة — عطلة</b><div class="muted">استمتع بيومك!</div></div></div>`
      : `<div class="today"><span class="ic">${todaySubj ? todaySubj.icon : '🔁'}</span><div><div class="muted">مادة اليوم</div><b>${todaySubj ? esc(todaySubj.name) : 'مراجعة عامة'}</b></div></div>`;
    for (let w = 0; w < weeks; w++) {
      html += `<div class="week">${weeks > 1 ? `<h3>الأسبوع ${w === 0 ? 'الأول' : w === 1 ? 'الثاني' : w + 1}</h3>` : ''}<table class="sched">`;
      DAYS.forEach((d, i) => {
        const s = subj(order[w * 6 + i]);
        const now = slot && slot.week === w && slot.day === i;
        html += `<tr class="${now ? 'now' : ''}"><td>${d}</td><td>${s ? `<span class="dot" style="--c:${s.color}"></span>${s.icon} ${esc(s.name)}` : '🔁 مراجعة عامة'}</td></tr>`;
      });
      html += `<tr class="fri"><td>الجمعة</td><td>🌴 عطلة</td></tr></table></div>`;
    }
    if (canEdit()) html += `<div class="center"><button class="btn" id="reshuffle">🔀 ترتيب عشوائي جديد</button></div>`;
    app.innerHTML = html;
    if (canEdit()) $('reshuffle').onclick = async () => {
      try { await setDoc(infoRef, { order: shuffle(S.subjects.map((s) => s.id)), start: serverTimestamp() }, { merge: true }); toast('تم ترتيب الجدول من جديد'); }
      catch { toast('ما زبط الحفظ، جربي مرة ثانية'); }
    };
  },

  subjects() {
    app.innerHTML = `<h2 class="page">📚 المواد</h2><div class="grid">${S.subjects.map((s) =>
      `<a class="subj" style="--c:${s.color}" href="#/subject/${s.id}"><span class="ic">${s.icon}</span><b>${esc(s.name)}</b></a>`).join('')}</div>`;
  },

  subject(id) {
    const s = subj(id); if (!s) return go('#/subjects');
    app.innerHTML = `<div class="crumb"><a href="#/subjects">المواد</a> ‹ ${esc(s.name)}</div>
      <h2 class="page">${s.icon} ${esc(s.name)}</h2>
      <div class="big">
        <a class="bigbtn" href="#/books/${s.id}"><span class="ic">📕</span><b>الكتاب</b><small>PDF</small></a>
        <a class="bigbtn" href="#/tests/${s.id}"><span class="ic">📝</span><b>اختبارات</b><small>${QUIZ_LEN} سؤال لكل درس</small></a>
      </div>`;
  },

  books(id) {
    const s = subj(id); if (!s) return go('#/subjects');
    const books = s.books || [];
    app.innerHTML = `<div class="crumb"><a href="#/subjects">المواد</a> ‹ <a href="#/subject/${s.id}">${esc(s.name)}</a> ‹ الكتاب</div>
      <h2 class="page">📕 كتاب ${esc(s.name)}</h2>
      ${books.length ? books.map((b, i) => `<a class="lesson" href="#/read/${s.id}/${i}"><span class="t">📄 ${esc(b.title)}</span><span class="badge">فتح</span></a>`).join('')
        : '<div class="card center muted">الكتاب رح ينضاف قريباً</div>'}`;
  },

  read(id, idx) {
    const s = subj(id), b = s && (s.books || [])[+idx];
    if (!b) return go('#/subjects');
    app.innerHTML = `<div class="crumb"><a href="#/subjects">المواد</a> ‹ <a href="#/books/${s.id}">كتاب ${esc(s.name)}</a> ‹ ${esc(b.title)}</div>
      <div class="readbar"><b>📕 ${esc(s.name)} — ${esc(b.title)}</b><span id="pgInfo" class="muted">جاري تحميل الكتاب…</span>
        <a class="btn ghost" href="${esc(b.file)}" target="_blank" rel="noopener">⬇️ تنزيل</a></div>
      <div id="pages" class="pages"></div>`;
    openBook(b.file);
  },

  tests(id) {
    const s = subj(id); if (!s) return go('#/subjects');
    if (!(id in TESTS)) { app.innerHTML = '<div class="card center muted">جاري التحميل…</div>'; loadBank(id).then(() => { TESTS[id] ||= null; rerender(); }); return; }
    const bank = TESTS[id];
    let html = `<div class="crumb"><a href="#/subjects">المواد</a> ‹ <a href="#/subject/${s.id}">${esc(s.name)}</a> ‹ اختبارات</div>
      <h2 class="page">📝 اختبارات ${esc(s.name)}</h2>`;
    if (!bank || !bank.units.length) html += '<div class="card center muted">الاختبارات رح تنضاف قريباً</div>';
    else bank.units.forEach((u) => {
      html += `<section class="unit"><h3>${esc(u.title)}</h3>${u.lessons.map((l) =>
        `<a class="lesson" href="#/quiz/${s.id}/${l.id}"><span class="t">اختبار ${esc(l.title)}</span>${badge(results[`${s.id}_${l.id}`])}</a>`).join('')}</section>`;
    });
    app.innerHTML = html;
  },

  quiz(id, lid) {
    if (!(id in TESTS)) { loadBank(id).then(() => { TESTS[id] ||= null; render(); }); return; }
    const s = subj(id), bank = TESTS[id];
    const lesson = bank && bank.units.flatMap((u) => u.lessons).find((l) => l.id === lid);
    if (!s || !lesson) return go('#/subjects');
    runQuiz(s, lesson);
  },

  report(id) {
    const past = [...new Set(allResults.map(gradeOf).concat(((info && info.grades) || []).map((g) => g.grade)).filter(Boolean))].sort((a, b) => a - b);
    if (!canSeeReport()) { app.innerHTML = `<h2 class="page">📊 التقرير</h2>${loginCard('التقرير خاص بالأهل')}`; return; }
    if (id) return subjectReport(id);
    const st = S.subjects.map((s) => ({ s, ...subjectStats(s.id) }));
    const tested = st.filter((x) => x.n);
    const ranked = tested.slice().sort((a, b) => b.avg - a.avg);
    let html = `<h2 class="page">📊 تقرير ${esc(S.name)}</h2>`;
    if (past.length > 1 || (past.length && past[0] !== S.grade)) html += `<div class="chips">${[...new Set(past.concat(S.grade))].sort((a, b) => a - b).map((g) =>
      `<button class="chip ${g === S.grade ? 'on' : ''}" data-g="${g}">${esc(P.grades[g].name)}</button>`).join('')}</div>`;
    if (!tested.length && !grades().length) html += '<div class="card center muted">لسا ما في اختبارات. لما يحل الاختبارات بيظهر التقرير هون.</div>';
    else {
      html += `<div class="statrow">
        <div class="stat"><b>${tested.reduce((a, x) => a + x.attempts, 0)}</b><small>محاولة اختبار</small></div>
        <div class="stat"><b>${tested.reduce((a, x) => a + x.n, 0)}</b><small>درس مختبَر</small></div>
        <div class="stat"><b>${tested.length ? Math.round(tested.reduce((a, x) => a + x.avg, 0) / tested.length) : 0}%</b><small>المعدل العام</small></div></div>`;
      if (ranked.length) html += `<div class="sw">
        <div class="card"><h3>💪 نقاط القوة</h3>${ranked.filter((x) => x.avg >= 75).slice(0, 3).map((x) => `<div>${x.s.icon} ${esc(x.s.name)} <b>${x.avg}%</b></div>`).join('') || '<div class="muted">بعد شوية اختبارات بتبين</div>'}</div>
        <div class="card"><h3>📌 بحاجة لتقوية</h3>${ranked.slice().reverse().filter((x) => x.avg < 75).slice(0, 3).map((x) => `<div>${x.s.icon} ${esc(x.s.name)} <b>${x.avg}%</b></div>`).join('') || '<div class="muted">ممتاز، ما في مواد ضعيفة 👏</div>'}</div></div>`;
    }
    html += `<h3 style="margin-top:18px">حسب المادة</h3><div class="grid">${st.map((x) => `
      <a class="subj rep" style="--c:${x.s.color}" href="#/report/${x.s.id}"><span class="ic">${x.s.icon}</span><b>${esc(x.s.name)}</b>
        ${x.n ? `<div class="meter"><i style="width:${x.avg}%;background:${lvl(x.avg).c}"></i></div><small>${x.avg}% • ${x.n} درس • ${x.attempts} محاولة</small>` : '<small class="muted">لم يُختبر</small>'}
        ${x.g.length ? `<small>📝 علامات المدرسة: ${x.gAvg}%</small>` : ''}</a>`).join('')}</div>`;
    app.innerHTML = html;
    app.querySelectorAll('.chip[data-g]').forEach((c) => c.onclick = () => { viewGrade(+c.dataset.g); });
  },

  grades() {
    if (!canView) { app.innerHTML = `<h2 class="page">📝 علامات المدرسة</h2>${loginCard('العلامات خاصة بالطالب وأهله')}`; return; }
    const gs = grades().slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    let html = `<h2 class="page">📝 علامات المدرسة</h2>`;
    if (canEdit()) html += `<div class="card gform"><h3>➕ إضافة علامة</h3>
      <label>المادة<select id="gSub">${S.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label>اسم الامتحان<input id="gTitle" placeholder="مثلاً: امتحان شهر أول"></label>
      <div class="two"><label>العلامة<input id="gScore" type="number" min="0" step="0.5"></label>
      <label>من<input id="gOut" type="number" min="1" value="20"></label></div>
      <label>التاريخ<input id="gDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <button class="btn green" id="gAdd">حفظ العلامة</button></div>`;
    else html += `<div class="muted" style="margin-bottom:10px">${isMama ? 'لإضافة علامة افتحي وضع الأهل 🔒' : 'الأهل بيضيفوا علامات امتحانات المدرسة.'}</div>`;
    html += gs.length ? `<table class="gt"><tr><th>المادة</th><th>الامتحان</th><th>العلامة</th><th>التاريخ</th>${canEdit() ? '<th></th>' : ''}</tr>${gs.map((g) => {
      const s = subj(g.subject), p = Math.round(g.score / g.outOf * 100);
      return `<tr><td>${s ? s.icon + ' ' + esc(s.name) : ''}</td><td>${esc(g.title)}</td><td><span class="badge" style="background:${lvl(p).bg};color:${lvl(p).c}">${g.score}/${g.outOf}</span></td><td>${esc(g.date || '')}</td>${canEdit() ? `<td><button class="x" data-id="${g.id}">🗑</button></td>` : ''}</tr>`; }).join('')}</table>`
      : '<div class="card center muted">لا توجد علامات بعد</div>';
    app.innerHTML = html;
    if (!canEdit()) return;
    $('gAdd').onclick = async () => {
      const g = { id: Date.now().toString(36), grade: S.grade, subject: $('gSub').value, title: $('gTitle').value.trim() || 'امتحان', score: +$('gScore').value, outOf: +$('gOut').value, date: $('gDate').value };
      if (!(g.outOf > 0) || $('gScore').value === '' || g.score < 0 || g.score > g.outOf) return toast('تأكدي من العلامة');
      try { await setDoc(infoRef, { grades: arrayUnion(g) }, { merge: true }); toast('تم حفظ العلامة ✅'); } catch { toast('ما زبط الحفظ'); }
    };
    app.querySelectorAll('.x').forEach((b) => b.onclick = async () => {
      if (!confirm('حذف هذه العلامة؟')) return;
      try { await setDoc(infoRef, { grades: grades().filter((g) => g.id !== b.dataset.id) }, { merge: true }); toast('تم الحذف'); } catch { toast('ما زبط الحذف'); }
    });
  },

  pick() {
    if (S.sid && !canEdit()) { app.innerHTML = `<h2 class="page">🎓 الصف</h2>${loginCard('تغيير صف الطالب للأهل فقط')}`; return; }
    app.innerHTML = `<h2 class="page">🎓 ${S.sid ? 'صف ' + esc(S.name) : 'اختر الصف'}</h2>
      ${S.sid ? '<div class="muted" style="margin-bottom:10px">لما ينتقل لصف جديد اختاريه هون. نتائج وعلامات الصفوف السابقة بتضل محفوظة وبتقدري ترجعي تشوفيها.</div>' : ''}
      <div class="grid">${Object.keys(P.grades).map((g) => `<button class="subj gpick ${+g === S.grade ? 'cur' : ''}" data-g="${g}"><span class="ic">${g}</span><b>${esc(P.grades[g].name)}</b>
        <small class="muted">${P.grades[g].subjects.some((x) => (x.books || []).length) ? '📚 فيه كتب' : 'قريباً'}</small></button>`).join('')}</div>`;
    app.querySelectorAll('.gpick').forEach((b) => b.onclick = async () => {
      const g = +b.dataset.g;
      if (S.sid) {
        if (g === S.grade) return go('#/');
        if (!confirm(`نقل ${S.name} إلى ${P.grades[g].name}؟ بياناته القديمة بتضل محفوظة.`)) return;
        try { await setDoc(infoRef, { name: S.name, grade: g, history: arrayUnion({ grade: g, t: Date.now() }) }, { merge: true }); }
        catch { return toast('ما زبط الحفظ'); }
        const k = kids.find((x) => x.sid === S.sid); if (k) k.grade = g;
      }
      setGrade(g); toast(`صرت على ${P.grades[g].name} ✅`); go('#/');
    });
  },

  kids() {
    if (!user) { app.innerHTML = `<h2 class="page">👧👦 الأولاد</h2>${loginCard('سجّلي الدخول بحساب العائلة')}`; return; }
    if (!isParentAcct) return go('#/link');
    const mine = kids.filter((k) => k.parent);
    const unlock = (t) => `<div class="card center" style="margin-top:14px"><button class="btn" onclick="document.getElementById('lockBtn').click()">🔓 ${t}</button></div>`;
    app.innerHTML = `<h2 class="page">👧👦 أولاد العائلة</h2>
      ${requests.length ? `<div class="card" style="margin-bottom:14px"><h3>📩 طلبات ربط من الأولاد</h3>
        ${famEdit() ? '' : '<div class="muted">افتحي وضع الأهل 🔒 للموافقة</div>'}
        ${requests.map((r) => `<div class="edrow"><span>🧒 <b>${esc(r.name)}</b> — ${esc((P.grades[r.grade] || {}).name || '')}<br><small class="muted" dir="ltr">${esc(r.from)}</small></span>
          ${famEdit() ? `<span class="rq"><select data-id="${esc(r.id)}"><option value="">➕ ولد جديد</option>${mine.map((k) => `<option value="${k.sid}">${esc(k.name)}</option>`).join('')}</select>
          <button class="btn green rq-ok" data-id="${esc(r.id)}">قبول</button><button class="x rq-no" data-id="${esc(r.id)}">✕</button></span>` : ''}</div>`).join('')}</div>` : ''}
      ${kids.length ? `<div class="grid">${kids.map((k) => `<button class="subj kpick ${k.sid === S.sid ? 'cur' : ''}" data-s="${k.sid}"><span class="ic">${k.grade <= 4 ? '🧒' : '🧑‍🎓'}</span><b>${esc(k.name)}</b><small class="muted">${esc(P.grades[k.grade].name)}</small></button>`).join('')}</div>`
        : '<div class="card center muted">لسا ما ضفتي أولاد. أضيفي أول ولد من تحت 👇</div>'}
      ${famEdit() ? `<div class="card" style="margin-top:14px"><h3>➕ إضافة ولد للعائلة</h3>
        <div class="gform"><label>الاسم<input id="kName" placeholder="اسم الطالب"></label>
        <label>الصف<select id="kGrade">${Object.keys(P.grades).map((g) => `<option value="${g}">${P.grades[g].name}</option>`).join('')}</select></label>
        <div class="muted">حساب خاص للطالب (اختياري): إذا كتبتي إيميل وكلمة مرور منعمله حساب يدخل فيه لحاله ويحل الاختبارات.</div>
        <div class="two"><input id="kEm" type="email" dir="ltr" placeholder="إيميل الطالب"><input id="kPw" type="text" dir="ltr" placeholder="كلمة مرور (6+)"></div>
        <button class="btn green" id="kAdd">إضافة</button></div></div>` : unlock('افتحي وضع الأهل لإضافة ولد')}`;
    app.querySelectorAll('.kpick').forEach((b) => b.onclick = () => openChild(b.dataset.s));
    app.querySelectorAll('.rq-ok').forEach((b) => b.onclick = () => {
      const r = requests.find((x) => x.id === b.dataset.id);
      approve(r, app.querySelector(`.rq select[data-id="${CSS.escape(r.id)}"]`).value);
    });
    app.querySelectorAll('.rq-no').forEach((b) => b.onclick = async () => {
      if (!confirm('رفض الطلب؟')) return;
      try { await deleteDoc(doc(db, 'requests', b.dataset.id)); } catch { return toast('ما زبط'); }
      requests = requests.filter((x) => x.id !== b.dataset.id); routes.kids();
    });
    if (!famEdit()) return;
    $('kAdd').onclick = async () => {
      const name = $('kName').value.trim(), grade = +$('kGrade').value, em = myEmail();
      const sEm = $('kEm').value.trim().toLowerCase(), sPw = $('kPw').value;
      if (!name) return toast('اكتبي الاسم');
      if (sEm && !EMAIL_RE.test(sEm)) return toast('إيميل الطالب غير صحيح');
      if (sEm && sPw) { const e = await createChildAccount(sEm, sPw); if (e) return toast(e); }
      const sid = newSid();
      try {
        await setDoc(doc(db, 'access', sid), { parents: [em], students: sEm ? [sEm] : [] });
        await setDoc(doc(db, 'students', sid), { name, grade, created: serverTimestamp() });
      } catch { return toast('ما زبط — تأكدي إن قواعد Firebase محدّثة'); }
      kids.push({ sid, name, grade, parent: true }); toast(`تمت إضافة ${name} ✅`); openChild(sid);
    };
  },

  link() { // student account: send a link request to a parent, or see who it is linked with
    if (!user) { app.innerHTML = `<h2 class="page">🔗 ربط الحساب</h2>${loginCard('سجّل الدخول أولاً')}`; return; }
    if (isParentAcct) return go('#/kids');
    if (kids.length) {
      app.innerHTML = `<h2 class="page">🔗 حسابي</h2><div class="card center">✅ حسابك مربوط مع أهلك<div style="margin-top:8px">${kids.map((k) => `<b>${esc(k.name)}</b> — ${esc(P.grades[k.grade].name)}`).join('<br>')}</div></div>`;
      return;
    }
    app.innerHTML = `<h2 class="page">🔗 ربط حسابي مع أهلي</h2>${myRequest
      ? `<div class="card center">📨 بعتت طلب لـ <b dir="ltr">${esc(myRequest.to)}</b><div class="muted" style="margin-top:6px">استنى لحتى ماما أو بابا يوافقوا من حسابهم.</div>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:center"><button class="btn" id="rqRe">🔄 تحقق</button><button class="btn ghost" id="rqDel">إلغاء الطلب</button></div></div>`
      : `<div class="card gform"><div class="muted">اكتب إيميل ماما أو بابا (لازم يكون عندهم حساب على المنصة)، وهم بيوافقوا على طلبك من حسابهم.</div>
        <label>اسمك<input id="lName" placeholder="اسمك"></label>
        <label>صفك<select id="lGrade">${Object.keys(P.grades).map((g) => `<option value="${g}" ${+g === S.grade ? 'selected' : ''}>${P.grades[g].name}</option>`).join('')}</select></label>
        <label>إيميل ماما أو بابا<input id="lTo" type="email" dir="ltr" placeholder="mama@example.com"></label>
        <button class="btn green" id="lSend">إرسال الطلب</button></div>`}`;
    if (myRequest) {
      $('rqRe').onclick = () => location.reload();
      $('rqDel').onclick = async () => { try { await deleteDoc(doc(db, 'requests', myEmail())); myRequest = null; routes.link(); } catch { toast('ما زبط'); } };
      return;
    }
    $('lSend').onclick = async () => {
      const name = $('lName').value.trim(), grade = +$('lGrade').value, to = $('lTo').value.trim().toLowerCase();
      if (!name) return toast('اكتب اسمك');
      if (!EMAIL_RE.test(to)) return toast('الإيميل غير صحيح');
      if (to === myEmail()) return toast('اكتب إيميل ماما أو بابا مش إيميلك');
      const r = { from: myEmail(), to, name, grade, at: serverTimestamp() };
      try { await setDoc(doc(db, 'requests', myEmail()), r); } catch { return toast('ما زبط — جرّب بعد شوي'); }
      myRequest = r; toast('تم إرسال الطلب 📨'); routes.link();
    };
  },

  accounts() {
    if (!canEdit()) { app.innerHTML = `<h2 class="page">👥 الحسابات</h2>${loginCard('هذه الصفحة للأهل فقط')}`; return; }
    const me = (user.email || '').toLowerCase();
    const list = (k) => (access[k] || []).map((e) => `<div class="edrow"><span dir="ltr">${esc(e)}</span>${e === me ? '<small class="muted">أنتِ</small>' : `<button class="x" data-k="${k}" data-e="${esc(e)}">🗑</button>`}</div>`).join('') || '<div class="muted">لا يوجد</div>';
    app.innerHTML = `<h2 class="page">👥 حسابات ${esc(S.name)}</h2>
      <div class="muted" style="margin-bottom:12px">كل شخص بيعمل حساب بإيميله وكلمة مروره من زر «تسجيل الدخول»، وبعدين بتضيفي إيميله هون.</div>
      <div class="card"><h3>👩‍👦 الأهل (يشوفوا ويعدّلوا: التنبيه، العلامات، الجدول)</h3>${list('parents')}
        <form class="ask" data-k="parents" style="margin-top:10px"><input type="email" dir="ltr" placeholder="إيميل الأم أو الأب"><button class="btn green">إضافة</button></form></div>
      <div class="card" style="margin-top:12px"><h3>🧒 ${esc(S.name)} (يشوف ويحل الاختبارات بس)</h3>${list('students')}
        <form class="ask" data-k="students" style="margin-top:10px;flex-wrap:wrap"><input type="email" dir="ltr" placeholder="إيميل الطالب"><input class="pw" type="text" dir="ltr" placeholder="كلمة مرور جديدة (اختياري)"><button class="btn green">إضافة</button></form>
        <div class="muted" style="font-size:13px;margin-top:6px">إذا كتبتي كلمة مرور منعمل للطالب حساب جديد بهالإيميل.</div></div>`;
    const save = async (k, arr) => {
      try { await setDoc(accessRef, { [k]: arr }, { merge: true }); access[k] = arr; toast('تم الحفظ ✅'); routes.accounts(); }
      catch { toast('ما زبط — تأكدي إن قواعد Firebase محدّثة'); }
    };
    app.querySelectorAll('form.ask').forEach((f) => f.onsubmit = async (e) => { e.preventDefault();
      const k = f.dataset.k, em = f.querySelector('input').value.trim().toLowerCase(), pw = f.querySelector('.pw');
      if (!EMAIL_RE.test(em)) return toast('الإيميل غير صحيح');
      if ((access[k] || []).includes(em)) return toast('موجود من قبل');
      if (pw && pw.value) { const err = await createChildAccount(em, pw.value); if (err) return toast(err); }
      save(k, [...(access[k] || []), em]); });
    app.querySelectorAll('.x').forEach((b) => b.onclick = () => {
      if (confirm('إزالة ' + b.dataset.e + '؟')) save(b.dataset.k, access[b.dataset.k].filter((e) => e !== b.dataset.e)); });
  },

  ai() {
    app.innerHTML = `<h2 class="page">🤖 المساعد الذكي</h2>
      <div class="muted" style="margin-bottom:8px">اسأل عن أي درس أو سؤال، أو اطلب خطة مراجعة لنقاط ضعفك.</div>
      <div class="chat" id="chat">${chatLog.map((m, i) => bubble(m, i)).join('') || `<div class="msg bot">أهلاً ${esc(S.name)} 👋 أنا مساعدك في الدراسة. شو بتحب نتعلم اليوم؟</div>`}</div>
      <div class="chips">${['اعملّي خطة مراجعة لنقاط ضعفي', 'اشرحلي درساً من كتاب العربي بطريقة سهلة', 'اسألني 5 أسئلة في الرياضيات', 'كيف أنظّم وقت دراستي؟'].map((t) => `<button class="chip">${t}</button>`).join('')}</div>
      ${pendingImg ? `<div class="pimg"><img src="${pendingImg.url}" alt=""><span>${esc(pendingImg.label || 'صورة مرفقة')}</span><button class="x" id="pimgX">✕</button></div>` : ''}
      <form class="ask" id="askF"><label class="cam" title="صوّر السؤال أو اختر صورة">📷<input type="file" accept="image/*" capture="environment" id="askImg" hidden></label>
        ${Rec ? '<button type="button" class="cam" id="micBtn" title="اسأل بصوتك">🎤</button>' : ''}
        <input id="askQ" placeholder="${pendingImg ? 'اكتب شو بدك تعرف عن الصورة (اختياري)…' : 'اكتب سؤالك أو صوّر السؤال من الكتاب 📷'}" autocomplete="off"><button class="btn">إرسال</button></form>`;
    const box = $('chat'); box.scrollTop = box.scrollHeight;
    app.querySelectorAll('.chip').forEach((c) => c.onclick = () => askAI(c.textContent));
    if (Rec) $('micBtn').onclick = (e) => listen(e.currentTarget);
    app.querySelectorAll('.say').forEach((b) => b.onclick = () => speak(chatLog[+b.dataset.i].text));
    $('askImg').onchange = async (e) => { const f = e.target.files[0]; if (f) { pendingImg = await shrinkImage(f); routes.ai(); } };
    if (pendingImg) $('pimgX').onclick = () => { pendingImg = null; routes.ai(); };
    $('askF').onsubmit = (e) => {
      e.preventDefault(); const q = $('askQ').value.trim();
      if (q || pendingImg) { const im = pendingImg; pendingImg = null; $('askQ').value = ''; askAI(q || 'اقرأ السؤال في الصورة واشرحلي كيف أحله خطوة خطوة', im); }
    };
  },
};
routes.subject.keep = routes.books.keep = routes.read.keep = routes.ai.keep = true;

// ---- report helpers ----
let realGrade = null; // when looking at an older grade's report
function viewGrade(g) { realGrade ??= S.grade; setGrade(g); routes.report(); if (g === realGrade) realGrade = null; }
const grades = () => ((info && info.grades) || []).filter((g) => (g.grade || (P.legacy[S.sid] || {}).grade) === S.grade);
const lvl = (p) => p >= 85 ? { c: '#15803d', bg: '#dcfce7', t: 'ممتاز' } : p >= 70 ? { c: '#2563eb', bg: '#dbeafe', t: 'جيد جداً' } : p >= 50 ? { c: '#b45309', bg: '#fef3c7', t: 'بحاجة لتحسين' } : { c: '#b91c1c', bg: '#fee2e2', t: 'ضعيف' };
const pct = (r) => Math.round(r.score / (r.total || QUIZ_LEN) * 100);
function lessonAvg(r) { const h = r.history && r.history.length ? r.history : [r]; return Math.round(h.reduce((a, x) => a + x.score / (x.total || QUIZ_LEN), 0) / h.length * 100); }
function subjectStats(id) {
  const rs = Object.values(results).filter((r) => r.subject === id);
  const g = grades().filter((x) => x.subject === id);
  return {
    rs, n: rs.length, attempts: rs.reduce((a, r) => a + (r.attempts || (r.history || [1]).length), 0),
    avg: rs.length ? Math.round(rs.reduce((a, r) => a + lessonAvg(r), 0) / rs.length) : 0,
    g, gAvg: g.length ? Math.round(g.reduce((a, x) => a + x.score / x.outOf, 0) / g.length * 100) : 0,
  };
}
function subjectReport(id) {
  const s = subj(id); if (!s) return go('#/report');
  const x = subjectStats(id);
  const rows = x.rs.map((r) => ({ r, avg: lessonAvg(r), last: pct(r) })).sort((a, b) => a.avg - b.avg);
  let html = `<div class="crumb"><a href="#/report">التقرير</a> ‹ ${esc(s.name)}</div><h2 class="page">${s.icon} تقرير ${esc(s.name)}</h2>`;
  html += `<div class="statrow"><div class="stat"><b>${x.avg}%</b><small>معدل الاختبارات</small></div>
    <div class="stat"><b>${x.n}</b><small>درس مختبَر</small></div><div class="stat"><b>${x.attempts}</b><small>محاولة</small></div>
    ${x.g.length ? `<div class="stat"><b>${x.gAvg}%</b><small>علامات المدرسة</small></div>` : ''}</div>`;
  if (!rows.length) html += '<div class="card center muted">لم يُختبر في هذه المادة بعد</div>';
  else {
    const weak = rows.filter((w) => w.avg < 70).slice(0, 3), strong = rows.slice().reverse().filter((w) => w.avg >= 85).slice(0, 3);
    html += `<div class="sw"><div class="card"><h3>💪 دروس قوي فيها</h3>${strong.map((w) => `<div>${esc(w.r.title || w.r.lesson)} <b>${w.avg}%</b></div>`).join('') || '<div class="muted">—</div>'}</div>
      <div class="card"><h3>📌 دروس بحاجة لمراجعة</h3>${weak.map((w) => `<div><a href="#/quiz/${id}/${w.r.lesson}">${esc(w.r.title || w.r.lesson)}</a> <b>${w.avg}%</b></div>`).join('') || '<div class="muted">لا يوجد 👏</div>'}</div></div>
      <h3 style="margin-top:16px">كل الدروس (الأضعف أولاً)</h3>
      <table class="gt"><tr><th>الدرس</th><th>المعدل</th><th>آخر محاولة</th><th>أفضل</th><th>المحاولات</th></tr>${rows.map((w) => `
        <tr><td>${esc(w.r.title || w.r.lesson)}</td><td><span class="badge" style="background:${lvl(w.avg).bg};color:${lvl(w.avg).c}">${w.avg}%</span></td>
        <td>${w.r.score}/${w.r.total || QUIZ_LEN}</td><td>${w.r.best ?? w.r.score}</td><td>${w.r.attempts || (w.r.history || [1]).length}</td></tr>`).join('')}</table>`;
    const missed = rows.slice(0, 3).flatMap((w) => (w.r.missed || []).slice(0, 4));
    if (missed.length) html += `<div class="card" style="margin-top:14px"><h3>❓ أسئلة أخطأ فيها مؤخراً</h3>${missed.map((q) => `<div class="mq">• ${esc(q)}</div>`).join('')}</div>`;
  }
  if (x.g.length) html += `<h3 style="margin-top:16px">📝 علامات المدرسة</h3><table class="gt">${x.g.map((g) => `<tr><td>${esc(g.title)}</td><td>${g.score}/${g.outOf}</td><td>${esc(g.date || '')}</td></tr>`).join('')}</table>`;
  app.innerHTML = html;
}

// ---- smart assistant (Gemini via Firebase AI Logic) ----
const chatLog = [];
let aiChat = null;
const AI_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest']; // older pinned names were retired by Google
const bubble = (m, i) => `<div class="msg ${m.who}">${m.img ? `<img class="mimg" src="${m.img}" alt="">` : ''}${m.who === 'bot' ? fmtAI(m.text) : esc(m.text)}${m.ok && m.who === 'bot' && window.speechSynthesis ? `<button class="say" data-i="${i}" title="اسمع الجواب">🔊</button>` : ''}</div>`;
// ---- voice: speak a question (browser speech recognition), hear the answer (speech synthesis) ----
const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
let speakNext = false;
function speak(t) {
  const ss = window.speechSynthesis; if (!ss) return;
  ss.cancel();
  const u = new SpeechSynthesisUtterance(t.replace(/[#*_`]/g, '').replace(/\p{Extended_Pictographic}/gu, ''));
  u.lang = 'ar'; const v = ss.getVoices().find((x) => /^ar/i.test(x.lang)); if (v) u.voice = v;
  u.rate = S.grade <= 4 ? 0.9 : 1; ss.speak(u);
}
function listen(btn) {
  const r = new Rec(); r.lang = 'ar-PS'; r.interimResults = false; r.maxAlternatives = 1;
  btn.classList.add('rec'); toast('🎤 احكي سؤالك…');
  r.onresult = (e) => { const t = e.results[0][0].transcript.trim(); if (t) { speakNext = true; askAI(t); } };
  r.onerror = (e) => toast(e.error === 'not-allowed' ? 'لازم تسمح للموقع يستعمل المايك' : 'ما سمعت منيح، جرّب مرة ثانية');
  r.onend = () => btn.classList.remove('rec');
  r.start();
}
let pendingImg = null; // {url, data, label} — image waiting to be sent with the next question
function shrinkImage(src, label) { // File or canvas -> small JPEG so uploads stay fast on phones
  return new Promise((ok) => {
    const done = (img) => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.8);
      ok({ url, data: url.split(',')[1], label });
    };
    if (src instanceof HTMLCanvasElement) return done(src);
    const im = new Image(); im.onload = () => done(im); im.src = URL.createObjectURL(src);
  });
}
function fmtAI(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^[*-] /gm, '• ').replace(/\n/g, '<br>'); }
function studentSummary() {
  const st = S.subjects.map((s) => ({ s, ...subjectStats(s.id) })).filter((x) => x.n || x.g.length);
  if (!st.length) return 'لم يحل الطالب أي اختبار بعد.';
  return st.map((x) => {
    const weak = x.rs.map((r) => ({ t: r.title || r.lesson, a: lessonAvg(r) })).sort((a, b) => a.a - b.a).slice(0, 3).filter((w) => w.a < 70);
    return `- ${x.s.name}: معدل الاختبارات ${x.avg}%${x.g.length ? `، علامات المدرسة ${x.gAvg}%` : ''}${weak.length ? `، دروس ضعيفة: ${weak.map((w) => `${w.t} (${w.a}%)`).join('، ')}` : ''}`;
  }).join('\n');
}
let aiLib;
async function newChat() { // returns a factory: model name -> chat session
  // the AI SDK is only downloaded when the assistant is actually used, so other pages stay light
  aiLib ||= await import('https://www.gstatic.com/firebasejs/12.3.0/firebase-ai.js');
  const { getAI, getGenerativeModel, GoogleAIBackend } = aiLib;
  const ai = getAI(fb, { backend: new GoogleAIBackend() });
  const sys = `أنت «المساعد الذكي»، معلّم خصوصي لطيف وصبور للطالب ${S.name} في ${S.gradeName} (المنهاج الفلسطيني).
المواد: ${S.subjects.map((s) => s.name).join('، ')}.
أداء الطالب الحالي من موقعه:
${studentSummary()}
تعليمات:
- تكلّم بالعربية الفصحى المبسطة (ويمكن لمسة من اللهجة الفلسطينية)، بأسلوب يناسب عمر الطالب${S.grade <= 4 ? ' (طفل عمره نحو 8 سنوات: جمل قصيرة جداً وأمثلة من حياته)' : ''}.
- اشرح خطوة بخطوة واسأل الطالب ليفكّر، ولا تعطِ حلّ الواجب كاملاً دون شرح.
- عند طلب خطة مراجعة ركّز على الدروس الضعيفة أعلاه.
- في الإنجليزي اشرح بالعربية مع أمثلة إنجليزية.
- إذا أرسل الطالب صورة سؤال أو صفحة من الكتاب: اقرأها بدقة، واشرح طريقة الحل خطوة بخطوة، ثم اذكر الجواب في النهاية ليتأكد منه.
- التزم بمحتوى كتب المنهاج: لما يسأل عن معلومة من الكتاب جاوب منها مباشرة بجواب بسيط، ولا تخرج عن مواضيع الدراسة.
- إجاباتك قصيرة وواضحة، وابتعد عن أي موضوع غير مناسب للأطفال، وأعد الطالب بلطف إلى الدراسة.`;
  return (m) => getGenerativeModel(ai, { model: m, systemInstruction: sys }).startChat({
    history: chatLog.filter((x) => x.ok).map((x) => ({ role: x.who === 'me' ? 'user' : 'model', parts: [{ text: x.text }] })),
  });
}
let aiModel = 0; // index into AI_MODELS; advances if a model name is unavailable
async function askAI(q, img) {
  chatLog.push({ who: 'me', text: q, img: img && img.url });
  const pending = { who: 'bot', text: '…' }; chatLog.push(pending);
  if (parse().name === 'ai') routes.ai();
  try {
    let r, tries = 0;
    const msg = img ? [{ text: q }, { inlineData: { mimeType: 'image/jpeg', data: img.data } }] : q;
    for (;;) {
      try {
        aiChat ||= (await newChat())(AI_MODELS[aiModel]);
        r = await aiChat.sendMessage(msg); break;
      } catch (e) {
        aiChat = null;
        const m = String(e && e.message);
        if (/not found|404|not supported|no longer available/i.test(m) && aiModel < AI_MODELS.length - 1) { aiModel++; continue; }
        // transient: overloaded model, timeouts, or a Google server that hasn't picked up settings yet
        if (/503|500|429|401|deadline|overloaded|fetch|network/i.test(m) && tries++ < 3) { await new Promise((ok) => setTimeout(ok, 1500 * tries)); continue; }
        throw e;
      }
    }
    pending.text = r.response.text(); pending.ok = true; chatLog[chatLog.length - 2].ok = true;
    if (speakNext) speak(pending.text);
  } catch (e) {
    aiChat = null;
    pending.text = /not.?enabled|has not been used|PERMISSION|api-not-enabled|403/i.test(String(e && e.message))
      ? 'المساعد الذكي لسا مش مفعّل. ماما لازم تفعّل «AI Logic» من Firebase مرة وحدة.'
      : /429|quota|RESOURCE_EXHAUSTED/i.test(String(e && e.message)) ? 'المساعد وصل للحد اليومي المجاني، جرّب بعد شوي أو بكرا.'
      : 'صار خطأ بالاتصال، جرّب مرة ثانية بعد شوي.';
    console.warn('AI error', e);
  }
  speakNext = false;
  if (parse().name === 'ai') routes.ai();
}

// ---- in-site book reader (pdf.js, pages rendered as they scroll into view) ----
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsReady;
function loadPdfjs() {
  return pdfjsReady ||= new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = PDFJS + 'pdf.min.js';
    sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
    sc.onerror = fail;
    document.head.appendChild(sc);
  });
}
async function openBook(file) {
  const box = $('pages'), info = $('pgInfo');
  try {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ url: file, cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/' }).promise;
    if (!box.isConnected) return;
    info.textContent = `${pdf.numPages} صفحة`;
    const first = await pdf.getPage(1), vp1 = first.getViewport({ scale: 1 });
    const io = new IntersectionObserver((ents) => ents.forEach((e) => {
      if (!e.isIntersecting || e.target.dataset.done) return;
      e.target.dataset.done = 1; io.unobserve(e.target); drawPage(pdf, +e.target.dataset.n, e.target);
    }), { rootMargin: '800px 0px' });
    for (let n = 1; n <= pdf.numPages; n++) {
      const d = document.createElement('div');
      d.className = 'page'; d.dataset.n = n;
      d.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
      d.innerHTML = `<span class="pn">${n}</span>`;
      box.appendChild(d); io.observe(d);
    }
  } catch (e) {
    info.textContent = 'ما قدرنا نعرض الكتاب هون — اضغط تنزيل لفتحه';
  }
}
async function drawPage(pdf, n, el) {
  const page = await pdf.getPage(n);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: (el.clientWidth / page.getViewport({ scale: 1 }).width) * dpr });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  el.style.aspectRatio = `${vp.width} / ${vp.height}`;
  el.prepend(c);
  const ask = document.createElement('button');
  ask.className = 'askpage'; ask.textContent = '🤖 اسأل المساعد عن هالصفحة';
  ask.onclick = async () => { const r = parse(); const s = subj(r.args[0]), b = s && s.books[+r.args[1]];
    pendingImg = await shrinkImage(c, `صفحة ${n} — ${s ? s.name : ''} ${b ? b.title : ''}`); go('#/ai'); };
  el.appendChild(ask);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
}

// ---- quiz engine ----
const MATHY = /^[\d\s+−×÷=().,/^²³√-]+$/; // bare arithmetic reads left-to-right even on an RTL page
const LATIN = /^[\s"'(«]*[A-Za-z]/;
const dirAttr = (t) => LATIN.test(t) ? ' dir="ltr" style="text-align:left"' : MATHY.test(t) ? ' dir="ltr" style="text-align:right"' : '';
function runQuiz(s, lesson) {
  const qs = shuffle(lesson.q).slice(0, QUIZ_LEN).map(([text, opts]) => {
    const order = shuffle(opts.map((o, i) => i));
    return { text, opts: order.map((i) => opts[i]), correct: order.indexOf(0) };
  });
  let i = 0, score = 0;
  const wrong = [];
  const back = `<div class="crumb"><a href="#/tests/${s.id}">اختبارات ${esc(s.name)}</a> ‹ ${esc(lesson.title)}</div>`;

  function show() {
    const q = qs[i];
    app.innerHTML = `${back}<div class="card">
      <div class="qnum"><span>السؤال ${i + 1} من ${qs.length}</span><span>✅ ${score}</span></div>
      <div class="qbar"><i style="width:${(i / qs.length) * 100}%"></i></div>
      <div class="qtext"${dirAttr(q.text)}>${esc(q.text)}</div>
      <div class="opts">${q.opts.map((o, k) => `<button class="opt" data-k="${k}"${dirAttr(o)}>${esc(o)}</button>`).join('')}</div>
      <div class="qnext" id="qnext"></div></div>`;
    app.querySelectorAll('.opt').forEach((b) => b.onclick = () => pick(+b.dataset.k));
  }
  function pick(k) {
    const q = qs[i], btns = app.querySelectorAll('.opt');
    btns.forEach((b) => b.disabled = true);
    btns[q.correct].classList.add('ok');
    if (k === q.correct) score++;
    else { btns[k].classList.add('bad'); wrong.push({ q: q.text, a: q.opts[k], c: q.opts[q.correct] }); }
    const last = i === qs.length - 1;
    $('qnext').innerHTML = `<button class="btn" id="nx">${last ? 'النتيجة 🎉' : 'التالي ←'}</button>`;
    $('nx').onclick = () => { if (last) finish(); else { i++; show(); } };
  }
  async function finish() {
    const total = qs.length;
    const msg = score >= total * .9 ? 'ممتاز! 🌟' : score >= total * .75 ? 'أحسنت! 👏' : score >= total * .5 ? 'جيد، راجع الأخطاء 💪' : 'بحاجة لمراجعة الدرس 📖';
    app.innerHTML = `${back}<div class="card center">
      <div class="muted">نتيجتك في ${esc(lesson.title)}</div>
      <div class="score">${score}<small> / ${total}</small></div>
      <h3>${msg}</h3>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:10px">
        <a class="btn" href="#/quiz/${s.id}/${lesson.id}?r=${Date.now()}">🔁 أعد الاختبار</a>
        <a class="btn ghost" href="#/tests/${s.id}">رجوع للدروس</a></div>
      ${wrong.length ? `<div class="review"><h3>راجع الأخطاء (${wrong.length})</h3>${wrong.map((w) =>
        `<div class="it"><div>${esc(w.q)}</div><div class="w">إجابتك: ${esc(w.a)}</div><div class="c">الصحيح: ${esc(w.c)}</div></div>`).join('')}</div>` : ''}
    </div>`;
    const key = `${s.id}_${lesson.id}`, prev = results[key];
    if (!canView || !S.sid) { app.querySelector('.card').insertAdjacentHTML('beforeend', '<div class="note" style="margin-top:14px"><div class="txt">🔒 النتيجة ما انحفظت لأنك مش داخل على حسابك. سجّل الدخول عشان تنحفظ نتائجك بالتقرير.</div></div>'); return; }
    try {
      // history keeps every attempt for the report; missed keeps the last attempt's wrong questions
      const legacy = P.legacy[S.sid] && P.legacy[S.sid].grade === S.grade; // keep old doc ids for the first two children
      await setDoc(doc(db, 'results', legacy ? `${S.sid}_${key}` : `${S.sid}_g${S.grade}_${key}`), {
        sid: S.sid, grade: S.grade, subject: s.id, lesson: lesson.id, title: lesson.title, score, total,
        best: Math.max(score, prev && prev.best || 0), at: serverTimestamp(),
        attempts: increment(1), history: arrayUnion({ score, total, t: Date.now() }),
        missed: wrong.map((w) => w.q).slice(0, 30),
      }, { merge: true });
    } catch { toast('ما انحفظت النتيجة (مشكلة اتصال)'); }
  }
  show();
}

// ---- accounts: role, child accounts, link requests ----
function askRole() {
  const m = $('modal');
  $('modalBox').innerHTML = `<h3>أهلاً 👋 مين إنت؟</h3><div class="muted">عشان نجهّزلك الحساب صح</div>
    <div class="big" style="margin-top:12px"><button class="bigbtn" data-r="parent"><span class="ic">👩‍👧</span><b>أم / أب</b><small>بضيف أولادي وبتابعهم</small></button>
    <button class="bigbtn" data-r="student"><span class="ic">🧒</span><b>طالب</b><small>بربط حسابي مع أهلي</small></button></div>`;
  m.classList.add('show');
  $('modalBox').querySelectorAll('[data-r]').forEach((b) => b.onclick = async () => {
    const r = b.dataset.r;
    try { await setDoc(doc(db, 'owners', myEmail()), { role: r }, { merge: true }); } catch { return toast('ما زبط — تأكدي إن قواعد Firebase محدّثة'); }
    role = r; isParentAcct = r === 'parent'; m.classList.remove('show'); updateLock();
    if (r === 'parent' && !pinHash) askPin(() => go('#/kids')); else go(r === 'parent' ? '#/kids' : '#/link');
  });
}
let auth2;
async function createChildAccount(email, pw) { // a second Firebase app, so the parent stays signed in
  auth2 ||= getAuth(initializeApp(S.firebase, 'kids'));
  try { await createUserWithEmailAndPassword(auth2, email, pw); return null; }
  catch (x) { const c = String(x && x.code);
    return /email-already-in-use/.test(c) ? null /* already has an account: just link it */
      : /weak-password/.test(c) ? 'كلمة مرور الطالب لازم تكون 6 أحرف أو أكثر' : /invalid-email/.test(c) ? 'إيميل الطالب غير صحيح' : 'ما زبط إنشاء حساب الطالب'; }
  finally { signOut(auth2).catch(() => {}); }
}
async function approve(r, sid) {
  const em = myEmail();
  try {
    if (!sid) {
      sid = newSid();
      await setDoc(doc(db, 'access', sid), { parents: [em], students: [r.from] });
      await setDoc(doc(db, 'students', sid), { name: r.name, grade: +r.grade || 1, created: serverTimestamp() });
      kids.push({ sid, name: r.name, grade: +r.grade || 1, parent: true });
    } else await setDoc(doc(db, 'access', sid), { students: arrayUnion(r.from) }, { merge: true });
    await deleteDoc(doc(db, 'requests', r.id));
  } catch { return toast('ما زبط — تأكدي إن قواعد Firebase محدّثة'); }
  requests = requests.filter((x) => x.id !== r.id); toast(`تم ربط حساب ${r.name} ✅`); routes.kids();
}

// side menu: every page and grade in one place; private pages show a lock until allowed
function renderMenu() {
  const cur = location.hash || '#/';
  const it = (h, ic, t, lock) => `<a href="${h}" class="${cur === h ? 'on' : ''}"><span>${ic}</span>${t}${lock ? '<small>🔒</small>' : ''}</a>`;
  let h = `<div class="dhead"><b>${esc(S.name || 'منصة الطالب')}</b><small>${esc(S.gradeName)}</small></div>`;
  h += it('#/', '🏠', 'الرئيسية') + it('#/subjects', '📚', 'المواد والاختبارات') + it('#/schedule', '🗓️', 'جدول الدراسة')
    + it('#/report', '📊', 'التقرير', !canSeeReport()) + it('#/grades', '📝', 'علامات المدرسة', !canView) + it('#/ai', '🤖', 'المساعد الذكي');
  if (S.sid) h += `<div class="dsec">الصف</div>` + it('#/pick', '🎓', `صف ${esc(S.name)}: ${esc(S.gradeName)}`, !canEdit());
  else h += `<div class="dsec">الصفوف</div><div class="dgrades">${Object.keys(P.grades).map((g) =>
    `<button data-g="${g}" class="${+g === S.grade ? 'on' : ''}">${esc(P.grades[g].name.replace('الصف ', ''))}</button>`).join('')}</div>`;
  h += `<div class="dsec">الحساب</div>`;
  if (!user) h += `<a href="#" id="dLogin"><span>👤</span>تسجيل الدخول / حساب جديد</a>`;
  else {
    if (isParentAcct) h += it('#/kids', '👧👦', `أولادي${requests.length ? ` <b class="dot2">${requests.length}</b>` : ''}`)
      + (S.sid && isMama ? it('#/accounts', '👥', `حسابات ${esc(S.name)}`, !canEdit()) : '')
      + `<a href="#" id="dLock"><span>${parentMode ? '🔓' : '🔒'}</span>${parentMode ? 'قفل وضع الأهل' : 'فتح وضع الأهل'}</a>`;
    else h += it('#/link', '🔗', kids.length ? 'حسابي' : 'ربط حسابي مع أهلي');
    h += `<a href="#" id="dOut"><span>🚪</span>خروج<small dir="ltr">${esc(myEmail())}</small></a>`;
  }
  const box = $('dbox'); box.innerHTML = h;
  box.querySelectorAll('[data-g]').forEach((b) => b.onclick = () => { setGrade(+b.dataset.g); closeMenu(); location.hash === '#/' ? render() : go('#/'); });
  box.querySelectorAll('a[href^="#/"]').forEach((a) => a.onclick = closeMenu);
  const on = (id, f) => { const e = $(id); if (e) e.onclick = (ev) => { ev.preventDefault(); closeMenu(); f(); }; };
  on('dLogin', openLogin); on('dLock', () => askPin()); on('dOut', () => signOut(auth).then(() => toast('تم الخروج')));
}
function openMenu() { renderMenu(); $('drawer').classList.add('show'); }
function closeMenu() { $('drawer').classList.remove('show'); }
$('menuBtn').onclick = openMenu;
$('drawer').onclick = (e) => { if (e.target.id === 'drawer') closeMenu(); };

// ---- mama ----
async function saveNote(text) {
  try { await setDoc(infoRef, { note: text, noteAt: serverTimestamp() }, { merge: true }); toast('تم حفظ التنبيه ✅'); }
  catch { toast('ما زبط الحفظ، جربي مرة ثانية'); }
}
function openLogin() {
  const m = $('modal');
  $('modalBox').innerHTML = `<h3>👤 تسجيل الدخول</h3><div class="muted">ادخل بإيميلك وكلمة المرور، أو اكتبهم واضغط «حساب جديد» لو أول مرة</div>
    <input type="email" id="em" autocomplete="email" placeholder="البريد الإلكتروني" dir="ltr">
    <input type="password" id="pw" autocomplete="current-password" placeholder="كلمة المرور" dir="ltr">
    <div class="err" id="pwErr"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="pwGo">دخول</button><button class="btn ghost" id="pwNew">حساب جديد</button><button class="btn ghost" id="pwX">إلغاء</button></div>
    <a href="#" id="pwForgot" class="muted" style="display:block;margin-top:10px;font-size:14px">نسيت كلمة المرور؟</a>`;
  m.classList.add('show');
  const val = () => ({ e: $('em').value.trim().toLowerCase(), p: $('pw').value });
  const err = (t) => { $('pwErr').textContent = t; };
  const msgOf = (e) => { const c = String(e && e.code); return /invalid-email/.test(c) ? 'الإيميل غير صحيح'
    : /email-already-in-use/.test(c) ? 'هذا الإيميل عنده حساب، اضغطي «دخول»' : /weak-password/.test(c) ? 'كلمة المرور لازم تكون 6 أحرف أو أكثر'
    : /too-many-requests/.test(c) ? 'محاولات كثيرة، استني شوي' : 'الإيميل أو كلمة المرور غير صحيحة'; };
  $('pwGo').onclick = async () => { const { e, p } = val(); err('');
    try { await signInWithEmailAndPassword(auth, e, p); m.classList.remove('show'); toast('أهلاً وسهلاً 💙'); } catch (x) { err(msgOf(x)); } };
  $('pwNew').onclick = async () => { const { e, p } = val(); err('');
    try { await createUserWithEmailAndPassword(auth, e, p); m.classList.remove('show'); toast('تم إنشاء حسابك ✅'); } catch (x) { err(msgOf(x)); } };
  $('pwForgot').onclick = async (ev) => { ev.preventDefault(); const { e } = val(); if (!e) return err('اكتبي إيميلك أولاً');
    try { await sendPasswordResetEmail(auth, e); err(''); toast('بعتنالك رابط لتغيير كلمة المرور على الإيميل 📧'); } catch (x) { err(msgOf(x)); } };
  $('pw').onkeydown = (ev) => { if (ev.key === 'Enter') $('pwGo').click(); };
  $('pwX').onclick = () => m.classList.remove('show');
  setTimeout(() => $('em').focus(), 50);
}
$('mamaBtn').onclick = () => user ? signOut(auth).then(() => toast('تم الخروج')) : openLogin();
$('modal').onclick = (e) => { if (e.target.id === 'modal') e.target.classList.remove('show'); };

// ---- router ----
function go(h) { location.hash = h; }
function parse() {
  const [path] = (location.hash.slice(1) || '/').split('?');
  const [name, ...args] = path.split('/').filter(Boolean);
  return { name: routes[name] ? name : 'home', args };
}
function render() { const r = parse(); routes[r.name](...r.args); window.scrollTo(0, 0); }
function rerender() { // live data changed: refresh only pages that show it, never mid-quiz or while typing
  const r = parse();
  if (r.name === 'quiz' || routes[r.name].keep) return;
  if (r.name === 'home' && document.activeElement && document.activeElement.id === 'noteTxt') return;
  routes[r.name](...r.args);
}

document.title = 'منصة الطالب';
setChild(null);
$('lockBtn').onclick = () => askPin();
addEventListener('hashchange', render);
render();
