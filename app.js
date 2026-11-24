// Study platform v2 (grades 1–12). Everyone can browse every grade, read books and try tests.
// Parents sign up (phone + password, recovery e-mail), then generate student accounts
// (6-digit login code + 10-digit password). Students only sign in. Results are saved per grade forever.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, reauthenticateWithCredential, EmailAuthProvider, updatePassword } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js';
import { getFirestore, doc, getDoc, getDocs, deleteDoc, onSnapshot, setDoc, updateDoc, collection, query, where, serverTimestamp, arrayUnion, increment } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js';

const P = window.PLATFORM;
const KID_DOMAIN = '@kids.students-sites.app';
const QUIZ_LEN = 30;
const DAYS = ['السبت', 'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
const SCHOOL_TYPES = ['حكومية', 'خاصة', 'وكالة الغوث'];
const CITIES = ['القدس', 'رام الله والبيرة', 'نابلس', 'الخليل', 'بيت لحم', 'جنين', 'طولكرم', 'قلقيلية', 'سلفيت', 'طوباس', 'أريحا', 'غزة', 'خانيونس', 'رفح', 'دير البلح', 'شمال غزة', 'الداخل المحتل', 'خارج فلسطين'];
const MARK_TYPES = ['امتحان شهر أول', 'امتحان شهر ثاني', 'امتحان نصفي', 'امتحان نهائي', 'مشاركة وواجبات', 'اختبار قصير', 'أخرى'];

const $ = (id) => document.getElementById(id);
const app = $('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const sess = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
const latinDigits = (t) => String(t || '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0).replace(/\s/g, '');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const gName = (g) => (P.grades[g] || {}).name || '';
const subjOf = (g, id) => ((P.grades[g] || {}).subjects || []).find((s) => s.id === id);
const newSid = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function normPhone(t) { let d = latinDigits(t).replace(/\D/g, ''); d = d.replace(/^00/, ''); if (/^97[02]/.test(d)) d = d.slice(3); return d.replace(/^0+/, ''); }
function rndDigits(n, first) { const a = crypto.getRandomValues(new Uint32Array(n)); return [...a].map((x, i) => (i === 0 && first ? 1 + (x % 9) : x % 10)).join(''); }
async function sha(t) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pin:' + t)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function qhash(t) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return 'q' + (h >>> 0).toString(36); }
function shuffle(a, rnd = Math.random) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function seeded(str) { let h = 1779033703 ^ str.length; for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; }; }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2600); }
function fmtDate(ts) { if (!ts) return ''; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleDateString('ar-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' }); }
const lvl = (p) => p >= 85 ? 'g' : p >= 60 ? 'a' : 'r';
const lvlTxt = (p) => p >= 85 ? 'ممتاز' : p >= 70 ? 'جيد جداً' : p >= 50 ? 'بحاجة لتحسين' : 'ضعيف';
const field = (id, label, inner) => `<div class="field"><label for="${id}">${label}</label>${inner}</div>`;
const inp = (id, label, attrs = '') => field(id, label, `<input id="${id}" ${attrs}>`);
const sel = (id, label, opts, cur) => field(id, label, `<select id="${id}">${opts.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`);
const gradeOpts = () => Object.keys(P.grades).map((g) => [g, gName(g)]);

// ---------- Firebase ----------
const fb = initializeApp(P.firebase);
const auth = getAuth(fb);
const db = getFirestore(fb);
let auth2; const kidAuth = () => (auth2 ||= getAuth(initializeApp(P.firebase, 'kids'))); // second app: parent stays signed in

// ---------- theme ----------
let theme = (() => { try { return JSON.parse(store.get('theme') || '{}'); } catch { return {}; } })();
theme = { mode: theme.mode || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), accent: theme.accent || 'blue' };
function applyTheme(t, save) {
  theme = { ...theme, ...t };
  document.documentElement.dataset.mode = theme.mode; document.documentElement.dataset.accent = theme.accent;
  document.querySelector('meta[name=theme-color]').content = theme.mode === 'dark' ? '#0e0f13' : '#ffffff';
  store.set('theme', JSON.stringify(theme));
  if (save && C.mode === 'parent') setDoc(doc(db, 'owners', C.email), { theme }, { merge: true }).catch(() => {});
  if (save && C.mode === 'student' && C.kid) updateDoc(doc(db, 'students', C.kid.sid), { theme }).catch(() => {});
}
applyTheme({});
function themePicker() {
  const A = [['blue', '#2f6bff', 'أزرق'], ['pink', '#e0487f', 'زهري'], ['gray', '#6b7280', 'سكني']];
  return `<div class="field"><label>الوضع</label><div class="seg" id="tMode"><button data-m="light" class="${theme.mode === 'light' ? 'on' : ''}">☀️ نهاري</button><button data-m="dark" class="${theme.mode === 'dark' ? 'on' : ''}">🌙 ليلي</button></div></div>
    <div class="field" style="margin-top:12px"><label>اللون</label><div class="swatches">${A.map(([k, c, t]) => `<button class="sw ${theme.accent === k ? 'on' : ''}" data-a="${k}" title="${t}" style="background:${c}"></button>`).join('')}</div></div>`;
}
function bindThemePicker(after) {
  document.querySelectorAll('#tMode [data-m]').forEach((b) => b.onclick = () => { applyTheme({ mode: b.dataset.m }, true); after(); });
  document.querySelectorAll('.sw[data-a]').forEach((b) => b.onclick = () => { applyTheme({ accent: b.dataset.a }, true); after(); });
}
$('themeBtn').onclick = () => { modal(`<h3>المظهر</h3>${themePicker()}<div style="margin-top:18px"><button class="btn block" id="mClose">تم</button></div>`);
  const re = () => $('themeBtn').onclick(); bindThemePicker(re); $('mClose').onclick = closeModal; };

// ---------- modal / sheet ----------
function modal(html) { $('modalBox').innerHTML = html; $('modal').classList.add('show'); }
function closeModal() { $('modal').classList.remove('show'); }
$('modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

// ---------- state ----------
// C.mode: 'visitor' | 'parent' | 'student'
const C = { mode: 'visitor', email: '', owner: {}, kids: [], kid: null, ready: false };
let G = +store.get('grade') || 1;          // grade being browsed
const BANKS = {}, bankLoads = {};
const RES = {};                             // sid -> [result docs]
const subs = {};                            // sid -> unsubscribe
let kidUnsub = null;

function loadBank(g, id) {
  const key = g + ':' + id;
  return bankLoads[key] ||= new Promise((ok) => {
    window.TESTS = {};
    const sc = document.createElement('script');
    sc.src = `grades/g${g}/tests-${id}.js?h=${Math.floor(Date.now() / 36e5)}`;
    sc.onload = sc.onerror = () => { (BANKS[g] ||= {})[id] = window.TESTS[id] || null; ok(BANKS[g][id]); };
    document.head.appendChild(sc);
  });
}
function watchResults(sid) {
  if (subs[sid]) return;
  subs[sid] = onSnapshot(query(collection(db, 'results'), where('sid', '==', sid)), (qs) => {
    RES[sid] = qs.docs.map((d) => d.data()); rerender();
  }, () => { RES[sid] ||= []; rerender(); });
}
const gradeOf = (r) => +(r.grade || (P.legacy[r.sid] && P.legacy[r.sid].grade) || 0);
const resId = (sid, g, s, l) => { const L = P.legacy[sid]; return L && L.grade === g ? `${sid}_${s}_${l}` : `${sid}_g${g}_${s}_${l}`; };

async function kidFromDoc(sid, parent) {
  const d = await getDoc(doc(db, 'students', sid)).then((x) => x.exists() ? x.data() : {}, () => ({}));
  const L = P.legacy[sid] || {};
  const k = { sid, ...d, name: d.name || L.name || 'طالب', grade: +(d.grade || L.grade || 1), marks: d.grades || [], legacy: !!P.legacy[sid] };
  if (parent) k.secret = await getDoc(doc(db, 'kidsecret', sid)).then((x) => x.exists() ? x.data() : {}, () => ({}));
  return k;
}
async function loadFamily() {
  const em = C.email, ids = new Set();
  const qs = await getDocs(query(collection(db, 'access'), where('parents', 'array-contains', em))).catch(() => null);
  qs && qs.forEach((d) => ids.add(d.id));
  if (em === P.mamaEmail) Object.keys(P.legacy).forEach((s) => ids.add(s));
  C.kids = await Promise.all([...ids].map((sid) => kidFromDoc(sid, true)));
  C.kids.sort((a, b) => (a.created?.seconds || 0) - (b.created?.seconds || 0));
}
onAuthStateChanged(auth, async (u) => {
  Object.values(subs).forEach((f) => f()); for (const k in subs) delete subs[k];
  if (kidUnsub) kidUnsub(); kidUnsub = null;
  Object.assign(C, { mode: 'visitor', email: '', owner: {}, kids: [], kid: null, ready: false });
  if (u) {
    C.email = (u.email || '').toLowerCase();
    const studentOf = await getDocs(query(collection(db, 'access'), where('students', 'array-contains', C.email))).catch(() => null);
    C.owner = await getDoc(doc(db, 'owners', C.email)).then((d) => d.exists() ? d.data() : {}, () => ({}));
    if (C.email.endsWith(KID_DOMAIN) || (studentOf && !studentOf.empty && C.owner.role !== 'parent' && C.email !== P.mamaEmail)) {
      C.mode = 'student';
      const sid = studentOf && !studentOf.empty ? studentOf.docs[0].id : null;
      if (sid) {
        C.kid = await kidFromDoc(sid, false);
        if (!store.get('grade:' + sid)) G = C.kid.grade;
        kidUnsub = onSnapshot(doc(db, 'students', sid), (s) => { if (s.exists()) { const d = s.data(); Object.assign(C.kid, d, { marks: d.grades || [], grade: +(d.grade || C.kid.grade) }); rerender(); } }, () => {});
        watchResults(sid);
        if (C.kid.theme) applyTheme(C.kid.theme);
      }
    } else {
      C.mode = 'parent';
      if (C.owner.theme) applyTheme(C.owner.theme);
      await loadFamily();
      C.kids.forEach((k) => watchResults(k.sid));
    }
  }
  C.ready = true; chrome(); render();
});

// ---------- parent PIN lock for the dashboard ----------
const unlocked = () => !C.owner.pin || +(sess.get('pinUntil') || 0) > Date.now();
const pinInput = (id, ph) => `<input type="text" class="pinf" id="${id}" inputmode="numeric" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="${ph}" dir="ltr">`;
function needPin(then) {
  if (unlocked()) return then();
  modal(`<h3>🔒 رمز الأهل</h3><p class="muted">اكتبي الرمز السري لفتح لوحة الأهل</p>
    <div class="field">${pinInput('pin', '••••')}</div><div class="err" id="pinErr"></div>
    <div style="display:flex;gap:8px"><button class="btn" id="pinGo">فتح</button><button class="btn line" id="pinX">إلغاء</button></div>
    <button class="link" id="pinForgot" style="margin-top:12px">نسيتي الرمز؟</button>`);
  const go2 = async () => { const raw = $('pin').value.trim(), v = latinDigits(raw);
    if (await sha(v) !== C.owner.pin && await sha(raw) !== C.owner.pin) { $('pinErr').textContent = 'الرمز غير صحيح'; return; }
    sess.set('pinUntil', Date.now() + 30 * 60e3); closeModal(); then(); };
  $('pinGo').onclick = go2; $('pin').onkeydown = (e) => { if (e.key === 'Enter') go2(); };
  $('pinX').onclick = () => { closeModal(); go('#/'); };
  $('pinForgot').onclick = () => setPin(then, true);
  setTimeout(() => $('pin').focus(), 60);
}
function setPin(then, forgot) {
  modal(`<h3>🔑 ${forgot ? 'رمز جديد' : 'رمز الأهل'}</h3><p class="muted">${forgot ? 'اكتبي كلمة مرور حسابك، وبعدين اختاري رمز جديد.' : 'اختاري رمزاً من 4 أرقام لحماية لوحة الأهل من الأولاد.'}</p>
    ${forgot ? `<div class="field"><input type="password" id="accPw" placeholder="كلمة مرور الحساب" dir="ltr" autocomplete="current-password"></div>` : ''}
    <div class="field">${pinInput('pin1', 'الرمز الجديد')}</div><div class="field" style="margin-top:8px">${pinInput('pin2', 'أعيدي الرمز')}</div>
    <div class="err" id="pinErr"></div><div style="display:flex;gap:8px"><button class="btn" id="pinGo">حفظ</button><button class="btn line" id="pinX">${forgot ? 'إلغاء' : 'لاحقاً'}</button></div>`);
  $('pinGo').onclick = async () => {
    const err = (t) => { $('pinErr').textContent = t; };
    if (forgot) { try { await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, $('accPw').value)); } catch { return err('كلمة المرور غير صحيحة'); } }
    const v = latinDigits($('pin1').value); if (!/^\d{4,8}$/.test(v)) return err('الرمز لازم يكون من 4 إلى 8 أرقام');
    if (v !== latinDigits($('pin2').value)) return err('الرمزين مش متطابقين');
    const h = await sha(v);
    try { await setDoc(doc(db, 'owners', C.email), { pin: h }, { merge: true }); } catch { return err('ما زبط الحفظ'); }
    C.owner.pin = h; sess.set('pinUntil', Date.now() + 30 * 60e3); closeModal(); toast('تم حفظ رمز الأهل ✅'); then && then();
  };
  $('pinX').onclick = () => { closeModal(); then && !forgot && then(); };
}

// ---------- chrome: header links, bottom tabs, side sheet ----------
function navItems() {
  if (C.mode === 'parent') return [['#/', '🏠', 'الرئيسية'], ['#/grades', '📚', 'الصفوف'], ['#/ai', '🤖', 'المساعد'], ['#/settings', '⚙️', 'الإعدادات']];
  if (C.mode === 'student') return [['#/', '🏠', 'الرئيسية'], ['#/grades', '📚', 'الصفوف'], ['#/me', '📊', 'مستواي'], ['#/settings', '⚙️', 'الإعدادات']];
  return [['#/', '🏠', 'الرئيسية'], ['#/grades', '📚', 'الصفوف'], ['#/ai', '🤖', 'المساعد'], ['#/login', '👤', 'دخول']];
}
function chrome() {
  const cur = '#/' + (parse().name === 'home' ? '' : parse().name);
  const on = (h) => (h === cur || (h !== '#/' && cur.startsWith(h))) ? 'on' : '';
  const items = navItems();
  $('tabs').innerHTML = items.map(([h, ic, t]) => `<a href="${h}" class="${on(h)}"><span>${ic}</span>${t}</a>`).join('');
  $('links').innerHTML = items.map(([h, , t]) => `<a href="${h}" class="${on(h)}">${t}</a>`).join('');
  $('acctBtn').textContent = C.mode === 'visitor' ? '👤' : C.mode === 'student' ? (C.kid && C.kid.gender === 'f' ? '👧' : '🧒') : '👩‍👧';
}
$('acctBtn').onclick = () => go(C.mode === 'visitor' ? '#/login' : '#/settings');
function openSheet() {
  const it = (h, ic, t) => `<a href="${h}"><span>${ic}</span>${t}</a>`;
  let h = `<div style="padding:4px 8px 6px"><b>${C.mode === 'student' && C.kid ? esc(C.kid.name) : C.mode === 'parent' ? esc(C.owner.name || 'حساب الأهل') : 'زائر'}</b><div class="muted small">${C.mode === 'student' ? 'حساب طالب' : C.mode === 'parent' ? 'حساب ولي أمر' : 'تصفّح بدون حساب'}</div></div>`;
  h += it('#/', '🏠', 'الرئيسية') + it('#/grades', '📚', 'كل الصفوف');
  if (C.mode === 'student') h += it('#/me', '📊', 'مستواي وأخطائي') + it('#/schedule', '🗓️', 'جدول الدراسة');
  if (C.mode === 'parent') { h += `<div class="sh">أولادي</div>` + C.kids.map((k) => it(`#/kid/${k.sid}`, k.gender === 'f' ? '👧' : '🧒', esc(k.name))).join('') + it('#/addkid', '➕', 'إضافة طالب'); }
  h += it('#/ai', '🤖', 'المساعد الذكي');
  h += `<div class="sh">الصفوف</div><div class="grid-g">${Object.keys(P.grades).map((g) => `<button data-g="${g}" class="${+g === G ? 'on' : ''}">${g}</button>`).join('')}</div>`;
  h += `<div class="sh">الحساب</div>`;
  h += C.mode === 'visitor' ? it('#/login', '👤', 'تسجيل الدخول') + it('#/signup', '✨', 'حساب ولي أمر جديد') : it('#/settings', '⚙️', 'الإعدادات') + `<button class="it" id="shOut"><span>🚪</span>خروج</button>`;
  $('sheet').innerHTML = h; $('sheet').classList.add('show'); $('veil').classList.add('show');
  $('sheet').querySelectorAll('a').forEach((a) => a.onclick = closeSheet);
  $('sheet').querySelectorAll('[data-g]').forEach((b) => b.onclick = () => { setG(+b.dataset.g); closeSheet(); go('#/g/' + b.dataset.g); });
  const o = $('shOut'); if (o) o.onclick = () => { closeSheet(); logout(); };
}
function closeSheet() { $('sheet').classList.remove('show'); $('veil').classList.remove('show'); }
$('menuBtn').onclick = openSheet; $('veil').onclick = closeSheet;
function setG(g) { G = +g || 1; store.set('grade', G); if (C.kid) store.set('grade:' + C.kid.sid, G); }
function logout() { sess.set('pinUntil', 0); signOut(auth).then(() => { toast('تم الخروج'); go('#/'); }); }

// ---------- analysis helpers ----------
function lessonAvg(r) { const h = r.history && r.history.length ? r.history : [r]; return Math.round(h.reduce((a, x) => a + x.score / (x.total || QUIZ_LEN), 0) / h.length * 100); }
function qEntries(rs) { // every tracked question: how often asked, how often wrong, wrong last time?
  const out = [];
  rs.forEach((r) => Object.entries(r.qs || {}).forEach(([h, v]) => out.push({ h, n: v.n || 0, w: v.w || 0, lw: v.lw || 0, t: v.t || '', a: v.a || '', subject: r.subject, lesson: r.lesson, title: r.title, grade: gradeOf(r) })));
  return out;
}
function stats(rs) {
  const qe = qEntries(rs), n = qe.reduce((a, x) => a + x.n, 0), w = qe.reduce((a, x) => a + x.w, 0);
  const hist = rs.flatMap((r) => r.history && r.history.length ? r.history : [{ score: r.score, total: r.total || QUIZ_LEN }]);
  const asked = hist.reduce((a, x) => a + (x.total || QUIZ_LEN), 0), right = hist.reduce((a, x) => a + x.score, 0);
  return { lessons: rs.length, attempts: hist.length, asked, avg: rs.length ? Math.round(rs.reduce((a, r) => a + lessonAvg(r), 0) / rs.length) : 0,
    err: n ? Math.round(w / n * 100) : asked ? Math.round((asked - right) / asked * 100) : 0, toFix: qe.filter((x) => x.lw).length, qe };
}
function weekly(rs) {
  const since = Date.now() - 7 * 864e5;
  const h = rs.flatMap((r) => (r.history || []).filter((x) => x.t > since));
  return { quizzes: h.length, asked: h.reduce((a, x) => a + (x.total || QUIZ_LEN), 0), right: h.reduce((a, x) => a + x.score, 0), mins: Math.round(h.reduce((a, x) => a + (x.dur || 0), 0) / 60) };
}
const marksOf = (k, g) => (k.marks || []).filter((m) => +(m.grade || (P.legacy[k.sid] || {}).grade) === +g);
const markPct = (ms) => ms.length ? Math.round(ms.reduce((a, m) => a + m.score / m.outOf, 0) / ms.length * 100) : null;
function badge(r) { if (!r) return '<span class="badge">ابدأ</span>'; const p = Math.round(r.score / (r.total || QUIZ_LEN) * 100); return `<span class="badge ${lvl(p)}">${r.score}/${r.total || QUIZ_LEN}</span>`; }
function myResults(g) { const sid = C.kid && C.kid.sid; return sid ? (RES[sid] || []).filter((r) => gradeOf(r) === +g) : []; }

// ---------- pages ----------
const routes = {
  home() {
    if (C.mode === 'parent') return parentHome();
    if (C.mode === 'student') return studentHome();
    const g = G, Gd = P.grades[g];
    app.innerHTML = `<section class="hero fade"><h1>ادرس وتدرّب لكل الصفوف</h1>
        <p>كتب المنهاج الفلسطيني من الصف الأول للثاني عشر، واختبارات لكل درس. جرّب بدون حساب، أو سجّل عشان تنحفظ نتائجك ويتابعك أهلك.</p>
        <div class="row"><a class="btn" href="#/signup">إنشاء حساب ولي أمر</a><a class="btn line" href="#/login">تسجيل الدخول</a></div></section>
      <div class="sec"><h2>اختر الصف</h2><a href="#/grades">كل الصفوف</a></div>
      <div class="chips" id="gchips">${Object.keys(P.grades).map((x) => `<button class="chip ${+x === g ? 'on' : ''}" data-g="${x}">${esc(gName(x))}</button>`).join('')}</div>
      <div class="sec"><h2>مواد ${esc(Gd.name)}</h2><a href="#/g/${g}">فتح الصف</a></div>
      <div class="grid">${Gd.subjects.map((s) => subjTile(g, s)).join('')}</div>
      <div class="sec"><h2>كيف بتشتغل المنصة؟</h2></div>
      <div class="grid wide">
        <div class="card"><h3>👩‍👧 ولي الأمر بيعمل حساب</h3><div class="muted">برقم الجوال وكلمة سر، وبيضيف أولاده.</div></div>
        <div class="card"><h3>🔢 حساب لكل طالب</h3><div class="muted">رقم دخول من 6 أرقام وكلمة سر بتتولد تلقائياً.</div></div>
        <div class="card"><h3>📊 متابعة وتحليل</h3><div class="muted">شو حل، ووين بيغلط، ووين لازم يتحسن، مع علامات المدرسة.</div></div></div>`;
    app.querySelectorAll('#gchips [data-g]').forEach((b) => b.onclick = () => { setG(b.dataset.g); routes.home(); });
  },
  grades() {
    app.innerHTML = `<h1 class="page-h">كل الصفوف</h1><div class="grid">${Object.keys(P.grades).map((g) => {
      const n = P.grades[g].subjects.length, books = P.grades[g].subjects.reduce((a, s) => a + (s.books || []).length, 0);
      return `<a class="tile ${+g === G ? 'cur' : ''}" href="#/g/${g}"><span class="ic">${g}</span><b>${esc(gName(g))}</b><small>${n} مواد • ${books} كتاب</small></a>`; }).join('')}</div>`;
  },
  g(g) {
    g = +g; if (!P.grades[g]) return go('#/grades'); setG(g);
    const rs = C.mode === 'student' ? myResults(g) : [];
    app.innerHTML = `<div class="crumb"><a href="#/grades">الصفوف</a> ‹ ${esc(gName(g))}</div><h1 class="page-h">${esc(gName(g))}</h1>
      ${C.mode === 'student' && C.kid && g !== C.kid.grade ? `<div class="note" style="margin-bottom:12px"><b>ملاحظة</b>إنت مسجّل في ${esc(gName(C.kid.grade))}، وبتقدر تحل هون كمان وبتنحفظ نتائجك.</div>` : ''}
      <div class="grid">${P.grades[g].subjects.map((s) => subjTile(g, s, rs)).join('')}</div>`;
  },
  s(g, id, tab) { subjectPage(+g, id, tab); },
  read(g, id, i) {
    g = +g; const s = subjOf(g, id), b = s && (s.books || [])[+i]; if (!b) return go('#/g/' + g);
    app.innerHTML = `<div class="crumb"><a href="#/g/${g}">${esc(gName(g))}</a> ‹ <a href="#/s/${g}/${id}/books">${esc(s.name)}</a> ‹ ${esc(b.title)}</div>
      <div class="readbar"><b>📕 ${esc(b.title)}</b><span id="pgInfo" class="muted small">جاري تحميل الكتاب…</span><a class="btn line sm" href="${esc(b.file)}" target="_blank" rel="noopener">⬇️ تنزيل</a></div><div id="pages" class="pages"></div>`;
    openBook(b.file, s, b);
  },
  quiz(g, id, lid) {
    g = +g; const s = subjOf(g, id); if (!s) return go('#/grades');
    loadBank(g, id).then((bank) => {
      const lesson = bank && bank.units.flatMap((u) => u.lessons).find((l) => l.id === lid);
      if (!lesson) return go(`#/s/${g}/${id}`);
      const items = shuffle(lesson.q).slice(0, QUIZ_LEN).map(([text, opts]) => ({ text, opts, lesson: lesson.id, ltitle: lesson.title }));
      runQuiz({ g, s, title: lesson.title, items, lesson, back: `#/s/${g}/${id}` });
    });
  },
  fix(g, id) {
    g = +g; const s = subjOf(g, id); if (!s || C.mode !== 'student') return go('#/me');
    const wrong = qEntries(myResults(g).filter((r) => r.subject === id)).filter((x) => x.lw);
    loadBank(g, id).then((bank) => {
      const byH = {}; (bank ? bank.units.flatMap((u) => u.lessons) : []).forEach((l) => l.q.forEach(([text, opts]) => { byH[qhash(text)] = { text, opts, lesson: l.id, ltitle: l.title }; }));
      const items = shuffle(wrong.map((w) => byH[w.h]).filter(Boolean)).slice(0, QUIZ_LEN);
      if (!items.length) { app.innerHTML = `<div class="card center"><h3>👏 ما في أخطاء لتصحيحها في ${esc(s.name)}</h3><a class="btn" href="#/me">رجوع</a></div>`; return; }
      runQuiz({ g, s, title: 'تصحيح الأخطاء — ' + s.name, items, fix: true, back: '#/me' });
    });
  },
  login() { authPage('login'); },
  signup() { authPage('signup'); },
  addkid() { if (C.mode !== 'parent') return go('#/login'); needPin(addKidPage); },
  kid(sid, tab) { if (C.mode !== 'parent') return go('#/login'); needPin(() => kidPage(sid, tab || 'overview')); },
  me(tab) {
    if (C.mode !== 'student' || !C.kid) return go('#/login');
    app.innerHTML = `<h1 class="page-h">مستواي</h1>${gradeChips(C.kid, G, '#/me')}` + analysisHTML(C.kid, G, tab || 'overview', false);
    bindAnalysis(C.kid, G, false);
  },
  schedule() { schedulePage(); },
  settings() { settingsPage(); },
  ai() { aiPage(); },
};
routes.read.keep = routes.ai.keep = true;

function subjTile(g, s, rs) {
  const mine = (rs || []).filter((r) => r.subject === s.id), avg = mine.length ? Math.round(mine.reduce((a, r) => a + lessonAvg(r), 0) / mine.length) : null;
  return `<a class="tile" style="--c:${s.color}" href="#/s/${g}/${s.id}"><span class="ic">${s.icon}</span><b>${esc(s.name)}</b>
    ${avg !== null ? `<div class="meter"><i style="width:${avg}%"></i></div><small>${avg}% • ${mine.length} درس</small>` : `<small>${(s.books || []).length} كتاب</small>`}</a>`;
}
function subjectPage(g, id, tab) {
  const s = subjOf(g, id); if (!s) return go('#/g/' + g);
  tab ||= 'tests';
  const head = `<div class="crumb"><a href="#/g/${g}">${esc(gName(g))}</a> ‹ ${esc(s.name)}</div><h1 class="page-h">${s.icon} ${esc(s.name)}</h1>
    <div class="ptabs"><button data-t="tests" class="${tab === 'tests' ? 'on' : ''}">الاختبارات</button><button data-t="books" class="${tab === 'books' ? 'on' : ''}">الكتب</button></div>`;
  const bindTabs = () => app.querySelectorAll('.ptabs [data-t]').forEach((b) => b.onclick = () => go(`#/s/${g}/${id}/${b.dataset.t}`));
  if (tab === 'books') {
    const books = s.books || [];
    app.innerHTML = head + (books.length ? `<div class="rows">${books.map((b, i) => `<a class="row-i" href="#/read/${g}/${id}/${i}"><span>📄</span><span class="t">${esc(b.title)}</span><span class="badge">قراءة</span></a>`).join('')}</div>` : '<div class="card center muted">الكتاب رح ينضاف قريباً</div>');
    return bindTabs();
  }
  app.innerHTML = head + '<div class="card center muted">جاري التحميل…</div>'; bindTabs();
  loadBank(g, id).then((bank) => {
    if (parse().name !== 's') return;
    const rs = {}; myResults(g).filter((r) => r.subject === id).forEach((r) => { rs[r.lesson] = r; });
    let html = head;
    if (C.mode === 'visitor') html += `<div class="note" style="margin-bottom:12px"><b>تجربة</b>بتقدر تحل كل الاختبارات، بس النتائج ما بتنحفظ. <a href="#/login" style="color:var(--acc)">سجّل الدخول</a> عشان تنحفظ.</div>`;
    if (!bank || !bank.units.length) html += '<div class="card center muted">الاختبارات رح تنضاف قريباً</div>';
    else bank.units.forEach((u) => { html += `<div class="unit-h">${esc(u.title)}</div><div class="rows">${u.lessons.map((l) =>
      `<a class="row-i" href="#/quiz/${g}/${id}/${l.id}"><span class="t">${esc(l.title)}<small>${Math.min(QUIZ_LEN, l.q.length)} سؤال</small></span>${badge(rs[l.id])}</a>`).join('')}</div>`; });
    app.innerHTML = html; bindTabs();
  });
}

// ---------- quiz engine ----------
const MATHY = /^[\d\s+−×÷=().,/^²³√-]+$/; const LATIN = /^[\s"'(«]*[A-Za-z]/;
const dirAttr = (t) => LATIN.test(t) ? ' dir="ltr" style="text-align:left"' : MATHY.test(t) ? ' dir="ltr" style="text-align:right"' : '';
function runQuiz({ g, s, title, items, lesson, fix, back }) {
  const qs = items.map((it) => { const order = shuffle(it.opts.map((o, i) => i)); return { ...it, h: qhash(it.text), shown: order.map((i) => it.opts[i]), correct: order.indexOf(0) }; });
  let i = 0, score = 0; const t0 = Date.now(), wrong = [];
  const crumb = `<div class="crumb"><a href="${back}">${esc(s.name)}</a> ‹ ${esc(title)}</div>`;
  function show() {
    const q = qs[i];
    app.innerHTML = `${crumb}<div class="quiz fade"><div class="qtop"><span>السؤال ${i + 1} من ${qs.length}</span><span>✅ ${score}</span></div>
      <div class="meter"><i style="width:${(i / qs.length) * 100}%"></i></div>
      ${fix ? `<div class="muted small" style="margin-top:10px">${esc(q.ltitle)}</div>` : ''}
      <div class="qtext"${dirAttr(q.text)}>${esc(q.text)}</div>
      <div class="opts">${q.shown.map((o, k) => `<button class="opt" data-k="${k}"${dirAttr(o)}>${esc(o)}</button>`).join('')}</div>
      <div id="qnext" style="margin-top:16px"></div></div>`;
    app.querySelectorAll('.opt').forEach((b) => b.onclick = () => pick(+b.dataset.k));
  }
  function pick(k) {
    const q = qs[i], btns = app.querySelectorAll('.opt');
    btns.forEach((b) => b.disabled = true); btns[q.correct].classList.add('ok');
    q.wrong = k !== q.correct;
    if (!q.wrong) score++; else { btns[k].classList.add('bad'); wrong.push({ q: q.text, a: q.shown[k], c: q.shown[q.correct] }); }
    const last = i === qs.length - 1;
    $('qnext').innerHTML = `<button class="btn block" id="nx">${last ? 'النتيجة' : 'التالي'}</button>`;
    $('nx').onclick = () => { if (last) finish(); else { i++; show(); } }; $('nx').focus();
  }
  async function finish() {
    const total = qs.length, p = Math.round(score / total * 100);
    app.innerHTML = `${crumb}<div class="quiz fade"><div class="card center"><div class="muted">${esc(title)}</div>
      <div class="score">${score}<small> / ${total}</small></div><h3>${p >= 90 ? 'ممتاز! 🌟' : p >= 75 ? 'أحسنت! 👏' : p >= 50 ? 'جيد، راجع الأخطاء 💪' : 'بحاجة لمراجعة الدرس 📖'}</h3>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:12px">
        ${lesson ? `<a class="btn" href="#/quiz/${g}/${s.id}/${lesson.id}?r=${Date.now()}">أعد الاختبار</a>` : ''}<a class="btn line" href="${back}">رجوع</a></div>
      <div id="saveNote"></div></div>
      ${wrong.length ? `<div class="card rev"><h3>راجع أخطاءك (${wrong.length})</h3>${wrong.map((w) => `<div class="it"><div>${esc(w.q)}</div><div class="w">إجابتك: ${esc(w.a)}</div><div class="c">الصحيح: ${esc(w.c)}</div></div>`).join('')}</div>` : ''}</div>`;
    if (C.mode !== 'student' || !C.kid) { $('saveNote').innerHTML = `<div class="note" style="margin-top:14px"><b>النتيجة ما انحفظت</b>${C.mode === 'parent' ? 'إنتِ داخلة بحساب ولي الأمر. النتائج بتنحفظ لما الطالب يحل من حسابه.' : 'سجّل الدخول بحساب الطالب عشان تنحفظ نتائجك.'}</div>`; return; }
    const sid = C.kid.sid, dur = Math.round((Date.now() - t0) / 1000);
    const qmap = (list) => Object.fromEntries(list.map((q) => [q.h, { n: increment(1), w: increment(q.wrong ? 1 : 0), lw: q.wrong ? 1 : 0, t: q.text.slice(0, 300), a: q.opts[0].slice(0, 200) }]));
    try {
      if (lesson) {
        const prev = myResults(g).find((r) => r.subject === s.id && r.lesson === lesson.id);
        await setDoc(doc(db, 'results', resId(sid, g, s.id, lesson.id)), { sid, grade: g, subject: s.id, lesson: lesson.id, title: lesson.title, score, total,
          best: Math.max(score, (prev && prev.best) || 0), at: serverTimestamp(), attempts: increment(1),
          history: arrayUnion({ score, total, t: Date.now(), dur }), missed: wrong.map((w) => w.q).slice(0, 30), qs: qmap(qs) }, { merge: true });
      } else { // correction round: update each question's own lesson, the lesson score stays as it was
        const by = {}; qs.forEach((q) => (by[q.lesson] ||= { title: q.ltitle, list: [] }).list.push(q));
        await Promise.all(Object.entries(by).map(([lid, v]) => setDoc(doc(db, 'results', resId(sid, g, s.id, lid)), { sid, grade: g, subject: s.id, lesson: lid, title: v.title, qs: qmap(v.list), fixedAt: serverTimestamp() }, { merge: true })));
      }
      $('saveNote').innerHTML = '<div class="muted small" style="margin-top:12px">✅ انحفظت النتيجة</div>';
    } catch { $('saveNote').innerHTML = '<div class="err" style="margin-top:12px">ما انحفظت النتيجة (مشكلة اتصال)</div>'; }
  }
  show();
}

// ---------- sign in / sign up ----------
function authPage(kind) {
  if (C.mode !== 'visitor') return go('#/');
  const who = sess.get('loginAs') || 'student';
  if (kind === 'signup') {
    app.innerHTML = `<div class="auth fade"><h1>حساب ولي أمر جديد</h1><p class="muted">بعد الإنشاء بتضيف أولادك وبنولّدلهم حسابات.</p>
      <div class="card form">
        ${inp('sName', 'الاسم الكامل', 'autocomplete="name"')}
        <div class="two">${inp('sAge', 'العمر', 'type="number" min="16" max="99" inputmode="numeric"')}${inp('sKids', 'كم طفل عندك؟', 'type="number" min="0" max="20" inputmode="numeric"')}</div>
        ${inp('sSchool', 'كم واحد منهم بالمدرسة؟', 'type="number" min="0" max="20" inputmode="numeric"')}
        ${inp('sPhone', 'رقم الجوال', 'type="tel" dir="ltr" placeholder="05xxxxxxxx" autocomplete="tel"')}
        ${inp('sEmail', 'البريد الإلكتروني (لاسترداد الحساب)', 'type="email" dir="ltr" autocomplete="email"')}
        ${inp('sPw', 'كلمة المرور (8 خانات أو أكثر)', 'type="password" dir="ltr" autocomplete="new-password"')}
        ${inp('sPw2', 'تأكيد كلمة المرور', 'type="password" dir="ltr" autocomplete="new-password"')}
        <div class="err" id="aErr"></div><button class="btn block" id="sGo">إنشاء الحساب</button>
        <div class="center small muted">عندك حساب؟ <a href="#/login" style="color:var(--acc)">تسجيل الدخول</a></div></div></div>`;
    $('sGo').onclick = signupParent; return;
  }
  app.innerHTML = `<div class="auth fade"><h1>تسجيل الدخول</h1><p class="muted">اختر نوع الحساب</p>
    <div class="seg" id="who" style="margin-bottom:14px"><button data-w="student" class="${who === 'student' ? 'on' : ''}">🧒 طالب</button><button data-w="parent" class="${who === 'parent' ? 'on' : ''}">👩‍👧 ولي أمر</button></div>
    <div class="card form">${who === 'student'
      ? `${inp('lId', 'رقم الدخول (6 أرقام)', 'inputmode="numeric" dir="ltr" maxlength="6" autocomplete="username" placeholder="••••••"')}
         ${inp('lPw', 'كلمة السر', 'type="password" inputmode="numeric" dir="ltr" autocomplete="current-password"')}
         <div class="muted small">رقم الدخول وكلمة السر بتاخدهم من ماما أو بابا.</div>`
      : `${inp('lId', 'رقم الجوال أو البريد الإلكتروني', 'dir="ltr" autocomplete="username"')}
         ${inp('lPw', 'كلمة المرور', 'type="password" dir="ltr" autocomplete="current-password"')}`}
      <div class="err" id="aErr"></div><button class="btn block" id="lGo">دخول</button>
      ${who === 'parent' ? `<button class="link" id="lForgot">نسيت كلمة المرور؟</button><div class="center small muted">ما عندك حساب؟ <a href="#/signup" style="color:var(--acc)">أنشئ حساب ولي أمر</a></div>` : ''}</div></div>`;
  app.querySelectorAll('#who [data-w]').forEach((b) => b.onclick = () => { sess.set('loginAs', b.dataset.w); authPage('login'); });
  const err = (t) => { $('aErr').textContent = t; };
  const go2 = async () => {
    err(''); const id = $('lId').value.trim(), pw = $('lPw').value;
    let email;
    if (who === 'student') { const c = latinDigits(id); if (!/^\d{6}$/.test(c)) return err('رقم الدخول لازم يكون 6 أرقام'); email = c + KID_DOMAIN; }
    else email = await emailFor(id).catch(() => null);
    if (!email) return err('رقم الجوال غير مسجّل');
    $('lGo').disabled = true;
    try { await signInWithEmailAndPassword(auth, email, who === 'student' ? latinDigits(pw) : pw); toast('أهلاً وسهلاً 💙'); }
    catch (x) { err(/too-many/.test(String(x && x.code)) ? 'محاولات كثيرة، استنى شوي' : who === 'student' ? 'رقم الدخول أو كلمة السر غير صحيحة' : 'بيانات الدخول غير صحيحة'); $('lGo').disabled = false; }
  };
  $('lGo').onclick = go2; $('lPw').onkeydown = (e) => { if (e.key === 'Enter') go2(); };
  const f = $('lForgot'); if (f) f.onclick = async () => {
    const email = await emailFor($('lId').value.trim()).catch(() => null);
    if (!email) return err('اكتب رقم جوالك أو إيميلك أولاً');
    try { await sendPasswordResetEmail(auth, email); err(''); toast('📧 بعتنا رابط تغيير كلمة المرور على إيميلك المسجّل'); } catch { err('ما زبط الإرسال'); }
  };
}
async function emailFor(id) {
  if (!id) return null;
  if (id.includes('@')) return id.toLowerCase();
  const p = normPhone(id); if (p.length < 8) return null;
  const d = await getDoc(doc(db, 'phones', p));
  return d.exists() ? d.data().email : null;
}
async function signupParent() {
  const v = (id) => $(id).value.trim(), err = (t) => { $('aErr').textContent = t; };
  const name = v('sName'), age = +latinDigits(v('sAge')), kidsN = +latinDigits(v('sKids')), schoolN = +latinDigits(v('sSchool')), phone = normPhone(v('sPhone')), email = v('sEmail').toLowerCase(), pw = $('sPw').value;
  if (name.length < 3) return err('اكتب الاسم الكامل');
  if (!(age >= 16 && age <= 99)) return err('العمر غير صحيح');
  if (!(kidsN >= 0) || !(schoolN >= 0) || schoolN > kidsN) return err('تأكد من عدد الأطفال');
  if (phone.length < 8 || phone.length > 12) return err('رقم الجوال غير صحيح');
  if (!EMAIL_RE.test(email)) return err('البريد الإلكتروني غير صحيح');
  if (pw.length < 8) return err('كلمة المرور لازم تكون 8 خانات أو أكثر');
  if (pw !== $('sPw2').value) return err('كلمتا المرور غير متطابقتين');
  $('sGo').disabled = true;
  try {
    if ((await getDoc(doc(db, 'phones', phone))).exists()) { $('sGo').disabled = false; return err('رقم الجوال مسجّل من قبل. سجّل الدخول.'); }
    await createUserWithEmailAndPassword(auth, email, pw);
    await setDoc(doc(db, 'owners', email), { role: 'parent', name, age, kidsCount: kidsN, schoolKids: schoolN, phone, theme, created: serverTimestamp() }, { merge: true });
    await setDoc(doc(db, 'phones', phone), { email });
    C.owner = { ...C.owner, role: 'parent', name, phone };
    toast('تم إنشاء حسابك ✅'); setTimeout(() => setPin(() => go('#/addkid')), 400);
  } catch (x) {
    $('sGo').disabled = false;
    const c = String(x && x.code);
    err(/email-already-in-use/.test(c) ? 'هذا البريد عنده حساب. سجّل الدخول.' : /invalid-email/.test(c) ? 'البريد الإلكتروني غير صحيح' : /weak-password/.test(c) ? 'كلمة المرور ضعيفة' : 'ما زبط إنشاء الحساب، جرّب مرة ثانية');
  }
}

// ---------- parent ----------
function parentHome() {
  const kids = C.kids;
  app.innerHTML = `<div class="hello fade"><h1>أهلاً ${esc((C.owner.name || '').split(' ')[0] || '')} 👋</h1><p>${kids.length ? 'تابعي تقدّم أولادك' : 'ابدئي بإضافة أولادك'}</p></div>
    ${!C.owner.phone ? `<div class="note" style="margin-bottom:12px"><b>رقم الجوال</b>أضيفي رقم جوالك من <a href="#/settings" style="color:var(--acc)">الإعدادات</a> عشان تدخلي فيه.</div>` : ''}
    <div class="grid wide">${kids.map((k) => {
      const rs = (RES[k.sid] || []).filter((r) => gradeOf(r) === k.grade), st = stats(rs), wk = weekly(RES[k.sid] || []);
      return `<a class="card tile" href="#/kid/${k.sid}" style="box-shadow:none"><div class="kid"><div class="avatar">${k.gender === 'f' ? '👧' : '🧒'}</div>
        <div style="flex:1"><b>${esc(k.name)}</b><div class="muted small">${esc(gName(k.grade))}${k.school ? ' • ' + esc(k.school) : ''}</div></div>
        ${st.lessons ? `<span class="badge ${lvl(st.avg)}">${st.avg}%</span>` : ''}</div>
        <div class="stats s3" style="margin-top:12px"><div class="stat"><b>${st.lessons}</b><small>درس محلول</small></div><div class="stat"><b>${wk.quizzes}</b><small>اختبار هالأسبوع</small></div><div class="stat"><b>${st.toFix}</b><small>خطأ لتصحيحه</small></div></div>
        ${!k.login ? '<div class="muted small" style="margin-top:8px">⚠️ ما إله بيانات دخول بعد</div>' : ''}</a>`; }).join('')}
      <a class="tile center" href="#/addkid" style="justify-content:center;align-items:center;min-height:160px;border-style:dashed"><span class="ic">➕</span><b>إضافة طالب</b><small>بنولّد رقم دخول وكلمة سر</small></a></div>`;
}
function kidForm(k = {}, noGrade) {
  return `${inp('kName', 'اسم الطالب', `value="${esc(k.name || '')}"`)}
    <div class="field"><label>الجنس</label><div class="seg" id="kGender"><button data-v="m" class="${k.gender !== 'f' ? 'on' : ''}">🧒 ولد</button><button data-v="f" class="${k.gender === 'f' ? 'on' : ''}">👧 بنت</button></div></div>
    <div class="two">${noGrade ? `<input type="hidden" id="kGrade" value="${k.grade}">` : sel('kGrade', 'الصف', gradeOpts(), k.grade || 1)}${inp('kSection', 'الشعبة', `value="${esc(k.section || '')}" placeholder="مثلاً: أ"`)}</div>
    ${inp('kSchool', 'اسم المدرسة', `value="${esc(k.school || '')}"`)}
    <div class="two">${sel('kType', 'نوع المدرسة', SCHOOL_TYPES, k.schoolType || SCHOOL_TYPES[0])}${field('kCity', 'المدينة', `<input id="kCity" list="cities" value="${esc(k.city || '')}"><datalist id="cities">${CITIES.map((c) => `<option value="${c}">`).join('')}</datalist>`)}</div>
    ${field('kNotes', 'ملاحظات خاصة (اختياري، بتشوفها إنتِ بس)', `<textarea id="kNotes" placeholder="مثلاً: بحاجة لتقوية بالرياضيات">${esc((k.secret && k.secret.notes) || '')}</textarea>`)}`;
}
function bindKidForm() { app.querySelectorAll('#kGender [data-v]').forEach((b) => b.onclick = () => { app.querySelectorAll('#kGender button').forEach((x) => x.classList.toggle('on', x === b)); }); }
function readKidForm() {
  const v = (id) => $(id).value.trim();
  const k = { name: v('kName'), gender: app.querySelector('#kGender .on').dataset.v, grade: +$('kGrade').value, section: v('kSection'), school: v('kSchool'), schoolType: $('kType').value, city: v('kCity') };
  const notes = v('kNotes');
  if (k.name.length < 2) return { err: 'اكتبي اسم الطالب' };
  if (!k.section) return { err: 'اكتبي الشعبة' };
  if (k.school.length < 2) return { err: 'اكتبي اسم المدرسة' };
  if (!k.city) return { err: 'اختاري المدينة' };
  return { k, notes };
}
function addKidPage() {
  app.innerHTML = `<div class="auth fade" style="max-width:560px"><div class="crumb"><a href="#/">الرئيسية</a> ‹ إضافة طالب</div><h1>إضافة طالب</h1>
    <p class="muted">بعد الحفظ بنولّد للطالب رقم دخول من 6 أرقام وكلمة سر من 10 أرقام تلقائياً.</p>
    <div class="card form">${kidForm()}<div class="err" id="kErr"></div><button class="btn block" id="kGo">إنشاء حساب الطالب</button></div></div>`;
  bindKidForm();
  $('kGo').onclick = async () => {
    const r = readKidForm(); if (r.err) return ($('kErr').textContent = r.err);
    $('kGo').disabled = true; $('kGo').textContent = 'جاري الإنشاء…';
    const sid = newSid();
    try {
      await setDoc(doc(db, 'access', sid), { parents: [C.email], students: [] });
      await setDoc(doc(db, 'students', sid), { ...r.k, created: serverTimestamp(), history: [{ grade: r.k.grade, t: Date.now() }] });
      await setDoc(doc(db, 'kidsecret', sid), { notes: r.notes || '' });
      const cred = await makeLogin(sid);
      const k = await kidFromDoc(sid, true); C.kids.push(k); watchResults(sid);
      showCred(k, cred, () => go('#/kid/' + sid));
    } catch (e) { console.warn(e); $('kErr').textContent = 'ما زبط الإنشاء — تأكدي إن قواعد Firebase محدّثة'; $('kGo').disabled = false; $('kGo').textContent = 'إنشاء حساب الطالب'; }
  };
}
async function makeLogin(sid) { // reserve a fresh 6-digit code, create the auth account, link it to the child
  let code;
  for (let t = 0; t < 12 && !code; t++) { const c = rndDigits(6, true); if (!(await getDoc(doc(db, 'logins', c))).exists()) code = c; }
  if (!code) throw new Error('no code');
  const pw = rndDigits(10), email = code + KID_DOMAIN;
  await setDoc(doc(db, 'logins', code), { sid, by: C.email, at: serverTimestamp() });
  const a2 = kidAuth();
  try { await createUserWithEmailAndPassword(a2, email, pw); } finally { signOut(a2).catch(() => {}); }
  await setDoc(doc(db, 'access', sid), { parents: arrayUnion(C.email), students: arrayUnion(email) }, { merge: true });
  await setDoc(doc(db, 'students', sid), { login: code }, { merge: true });
  await setDoc(doc(db, 'kidsecret', sid), { pw }, { merge: true });
  return { code, pw };
}
function showCred(k, cred, then) {
  const txt = `بيانات دخول ${k.name} على منصة الطالب\nرقم الدخول: ${cred.code}\nكلمة السر: ${cred.pw}\n${location.origin + location.pathname}`;
  modal(`<h3>✅ جاهز حساب ${esc(k.name)}</h3><p class="muted">احفظي البيانات وأعطيها للطالب. بتقدري تشوفيها بأي وقت من صفحة الطالب.</p>
    <div class="cred"><div class="kv"><span>رقم الدخول</span><code>${cred.code}</code></div><div class="kv"><span>كلمة السر</span><code>${cred.pw}</code></div></div>
    <div style="display:flex;gap:8px;margin-top:14px"><button class="btn" id="cCopy">نسخ</button><button class="btn line" id="cOk">تم</button></div>`);
  $('cCopy').onclick = () => navigator.clipboard.writeText(txt).then(() => toast('تم النسخ ✅'), () => toast('ما زبط النسخ'));
  $('cOk').onclick = () => { closeModal(); then && then(); };
}
function kidPage(sid, tab) {
  const k = C.kids.find((x) => x.sid === sid); if (!k) return go('#/');
  const gsel = +(sess.get('kg:' + sid) || k.grade);
  const T = [['overview', 'نظرة عامة'], ['analysis', 'التحليل والأخطاء'], ['marks', 'علامات المدرسة'], ['info', 'البيانات والحساب']];
  let html = `<div class="crumb"><a href="#/">أولادي</a> ‹ ${esc(k.name)}</div>
    <div class="kid" style="margin-bottom:6px"><div class="avatar">${k.gender === 'f' ? '👧' : '🧒'}</div><div><h1 class="page-h" style="margin:0">${esc(k.name)}</h1><div class="muted small">${esc(gName(k.grade))}${k.section ? ' • شعبة ' + esc(k.section) : ''}${k.school ? ' • ' + esc(k.school) : ''}</div></div></div>
    <div class="ptabs">${T.map(([t, n]) => `<button data-t="${t}" class="${t === tab ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  if (tab === 'overview' || tab === 'analysis') html += gradeChips(k, gsel, `#/kid/${sid}/${tab}`) + analysisHTML(k, gsel, tab, true);
  else if (tab === 'marks') html += marksHTML(k, gsel);
  else html += infoHTML(k);
  app.innerHTML = html;
  app.querySelectorAll('.ptabs [data-t]').forEach((b) => b.onclick = () => go(`#/kid/${sid}/${b.dataset.t}`));
  if (tab === 'overview' || tab === 'analysis') bindAnalysis(k, gsel, true);
  else if (tab === 'marks') bindMarks(k, gsel);
  else bindInfo(k);
}
function gradeChips(k, gsel, base) {
  const gs = [...new Set((RES[k.sid] || []).map(gradeOf).concat(marksOf({ ...k, marks: k.marks }, gsel).length ? [gsel] : []).concat([k.grade]).filter(Boolean))].sort((a, b) => a - b);
  if (gs.length < 2) return '';
  return `<div class="chips" id="kgChips" style="margin-bottom:8px">${gs.map((g) => `<button class="chip ${g === gsel ? 'on' : ''}" data-g="${g}">${esc(gName(g))}</button>`).join('')}</div>`;
}
function analysisHTML(k, g, tab, parent) {
  const rs = (RES[k.sid] || []).filter((r) => gradeOf(r) === g), st = stats(rs), subs2 = (P.grades[g] || { subjects: [] }).subjects;
  if (!RES[k.sid]) return '<div class="card center muted">جاري التحميل…</div>';
  if (!rs.length) return `<div class="card center"><div style="font-size:40px">📝</div><h3>لسا ما في نتائج في ${esc(gName(g))}</h3><div class="muted">${parent ? 'لما يحل الطالب اختبارات من حسابه بتظهر هون.' : 'حل أول اختبار وبيظهر مستواك هون.'}</div>${parent ? '' : `<a class="btn" style="margin-top:12px" href="#/g/${g}">ابدأ</a>`}</div>`;
  const per = subs2.map((s) => { const r = rs.filter((x) => x.subject === s.id); return { s, rs: r, st: stats(r), mk: markPct(marksOf(k, g).filter((m) => m.subject === s.id)) }; });
  if (tab === 'overview') {
    const wk = weekly(RES[k.sid] || []), tested = per.filter((x) => x.rs.length).sort((a, b) => b.st.avg - a.st.avg);
    return `<div class="stats"><div class="stat"><b>${st.avg}%</b><small>المستوى العام — ${lvlTxt(st.avg)}</small></div><div class="stat"><b>${st.lessons}</b><small>درس محلول</small></div>
        <div class="stat"><b>${st.asked}</b><small>سؤال جاوب عليه</small></div><div class="stat"><b>${st.err}%</b><small>نسبة الأخطاء</small></div></div>
      <div class="sec"><h2>هالأسبوع</h2></div>
      <div class="stats"><div class="stat"><b>${wk.quizzes}</b><small>اختبار</small></div><div class="stat"><b>${wk.asked}</b><small>سؤال</small></div><div class="stat"><b>${wk.asked ? Math.round(wk.right / wk.asked * 100) : 0}%</b><small>إجابات صحيحة</small></div><div class="stat"><b>${wk.mins}</b><small>دقيقة دراسة</small></div></div>
      <div class="two" style="margin-top:14px"><div class="card"><h3>💪 أقوى المواد</h3>${tested.filter((x) => x.st.avg >= 75).slice(0, 3).map((x) => `<div>${x.s.icon} ${esc(x.s.name)} <b>${x.st.avg}%</b></div>`).join('') || '<div class="muted">بعد شوية اختبارات بتبيّن</div>'}</div>
        <div class="card"><h3>📌 بحاجة لتقوية</h3>${tested.slice().reverse().filter((x) => x.st.avg < 75).slice(0, 3).map((x) => `<div>${x.s.icon} ${esc(x.s.name)} <b>${x.st.avg}%</b></div>`).join('') || '<div class="muted">ما في مواد ضعيفة 👏</div>'}</div></div>
      ${st.toFix ? `<div class="card" style="margin-top:12px"><div class="kid"><div class="avatar">🛠️</div><div style="flex:1"><b>${st.toFix} سؤال لسا غلط</b><div class="muted small">${parent ? 'الطالب بيقدر يصححهم من حسابه بزر «صحّح أخطاءك».' : 'صححهم عشان يرتفع مستواك'}</div></div>${parent ? '' : '<a class="btn sm" href="#/me/analysis">صحّح</a>'}</div></div>` : ''}
      <div class="sec"><h2>المواد</h2></div><div class="card"><div class="legend"><span><i style="background:var(--acc)"></i>مستواه بالمنصة</span><span><i style="background:color-mix(in srgb,var(--text) 55%,transparent)"></i>علامات المدرسة</span></div>
      <div class="bars">${per.map((x) => `<div class="bar-r"><div class="lbl"><span>${x.s.icon} ${esc(x.s.name)}</span><span class="muted">${x.rs.length ? x.st.avg + '%' : '—'}${x.mk !== null ? ' • مدرسة ' + x.mk + '%' : ''}</span></div>
        <div class="tr"><i class="site" style="width:${x.rs.length ? Math.max(2, x.st.avg) : 0}%"></i>${x.mk !== null ? `<i class="school" style="width:${Math.max(2, x.mk)}%"></i>` : ''}</div></div>`).join('')}</div></div>`;
  }
  // analysis
  const qe = st.qe, worst = qe.filter((x) => x.w).sort((a, b) => b.w / b.n - a.w / a.n || b.w - a.w).slice(0, 20);
  const weakLessons = rs.map((r) => ({ r, a: lessonAvg(r) })).filter((x) => x.a < 70).sort((a, b) => a.a - b.a).slice(0, 8);
  const legacyMissed = rs.filter((r) => !r.qs && (r.missed || []).length);
  return `<div class="sec" style="margin-top:6px"><h2>نسبة الأخطاء حسب المادة</h2></div>
    <div class="card tbl-wrap"><table class="tbl"><tr><th>المادة</th><th>دروس</th><th>المستوى</th><th>الأخطاء</th><th>لسا غلط</th><th></th></tr>${per.filter((x) => x.rs.length).map((x) => `
      <tr><td>${x.s.icon} ${esc(x.s.name)}</td><td>${x.st.lessons}</td><td><span class="badge ${lvl(x.st.avg)}">${x.st.avg}%</span></td><td>${x.st.err}%</td><td>${x.st.toFix}</td>
      <td>${!parent && x.st.toFix ? `<a class="btn sm soft" href="#/fix/${g}/${x.s.id}">صحّح</a>` : ''}</td></tr>`).join('')}</table></div>
    <div class="two" style="margin-top:12px">
      <div class="card"><h3>🛠️ وين ${parent ? 'بيقدر يصحح' : 'بتقدر تصحح'}</h3>${per.filter((x) => x.st.toFix).map((x) => `<div class="row-i" style="padding:8px 0;cursor:default"><span class="t">${x.s.icon} ${esc(x.s.name)}<small>${x.st.toFix} سؤال غلط بآخر مرة</small></span>${parent ? '' : `<a class="btn sm" href="#/fix/${g}/${x.s.id}">ابدأ</a>`}</div>`).join('') || '<div class="muted">ما في أخطاء معلّقة 👏</div>'}</div>
      <div class="card"><h3>📈 وين لازم ${parent ? 'يتحسن' : 'تتحسن'}</h3>${weakLessons.map((x) => { const s = subjOf(g, x.r.subject); return `<div class="row-i" style="padding:8px 0;cursor:default"><span class="t">${esc(x.r.title || x.r.lesson)}<small>${s ? esc(s.name) : ''}</small></span><span class="badge ${lvl(x.a)}">${x.a}%</span>${parent ? '' : ` <a class="btn sm line" href="#/quiz/${g}/${x.r.subject}/${x.r.lesson}">أعد</a>`}</div>`; }).join('') || '<div class="muted">كل الدروس فوق 70% 👏</div>'}</div></div>
    <div class="sec"><h2>أكثر الأسئلة اللي ${parent ? 'بيغلط' : 'بتغلط'} فيها</h2></div>
    <div class="card">${worst.map((x) => { const s = subjOf(g, x.subject); return `<div class="mq"><div class="q">${esc(x.t)}</div><div class="a">✔ ${esc(x.a)}</div>
      <div class="m">${s ? s.icon + ' ' + esc(s.name) + ' • ' : ''}${esc(x.title || '')} • غلط ${x.w} من ${x.n} (${Math.round(x.w / x.n * 100)}%) • ${x.lw ? '<span style="color:var(--bad)">لسا غلط</span>' : '<span style="color:var(--ok)">صار صح</span>'}</div></div>`; }).join('')
      || (legacyMissed.length ? legacyMissed.slice(0, 6).flatMap((r) => r.missed.slice(0, 3).map((q) => `<div class="mq"><div class="q">${esc(q)}</div><div class="m">${esc(r.title || '')}</div></div>`)).join('') : '<div class="muted">لسا ما في أخطاء مسجّلة</div>')}</div>`;
}
function bindAnalysis(k, g, parent) {
  app.querySelectorAll('#kgChips [data-g]').forEach((b) => b.onclick = () => {
    if (parent) { sess.set('kg:' + k.sid, b.dataset.g); render(); } else { setG(+b.dataset.g); render(); }
  });
}
function marksHTML(k, g) {
  const ms = marksOf(k, g).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')), subs2 = P.grades[g].subjects;
  const avg = markPct(ms);
  return `${gradeChips(k, g, '')}<div class="stats"><div class="stat"><b>${avg ?? '—'}${avg !== null ? '%' : ''}</b><small>معدل علامات المدرسة</small></div><div class="stat"><b>${ms.length}</b><small>علامة مسجّلة</small></div></div>
    <div class="card form" style="margin-top:12px"><h3>➕ إضافة علامة</h3>
      <div class="two">${sel('mSub', 'المادة', subs2.map((s) => [s.id, s.name]))}${sel('mType', 'نوع الامتحان', MARK_TYPES)}</div>
      <div class="two">${sel('mSem', 'الفصل', [['1', 'الفصل الأول'], ['2', 'الفصل الثاني']], new Date().getMonth() >= 1 && new Date().getMonth() <= 6 ? '2' : '1')}${inp('mDate', 'التاريخ', `type="date" value="${new Date().toISOString().slice(0, 10)}"`)}</div>
      <div class="two">${inp('mScore', 'العلامة', 'type="number" min="0" step="0.5" inputmode="decimal"')}${inp('mOut', 'من', 'type="number" min="1" value="20" inputmode="decimal"')}</div>
      <div class="err" id="mErr"></div><button class="btn" id="mAdd">حفظ العلامة</button></div>
    <div class="sec"><h2>حسب المادة</h2></div><div class="grid">${subs2.map((s) => { const p = markPct(ms.filter((m) => m.subject === s.id)); return `<div class="tile" style="--c:${s.color};cursor:default"><span class="ic">${s.icon}</span><b>${esc(s.name)}</b><small>${p === null ? 'لا يوجد' : p + '% — ' + lvlTxt(p)}</small></div>`; }).join('')}</div>
    <div class="sec"><h2>كل العلامات</h2></div>
    ${ms.length ? `<div class="card tbl-wrap"><table class="tbl"><tr><th>المادة</th><th>الامتحان</th><th>الفصل</th><th>العلامة</th><th>التاريخ</th><th></th></tr>${ms.map((m) => { const s = subjOf(g, m.subject), p = Math.round(m.score / m.outOf * 100);
      return `<tr><td>${s ? s.icon + ' ' + esc(s.name) : ''}</td><td>${esc(m.type || m.title || '')}</td><td>${m.sem ? (m.sem === '2' ? 'الثاني' : 'الأول') : ''}</td><td><span class="badge ${lvl(p)}">${m.score}/${m.outOf}</span></td><td class="small">${esc(m.date || '')}</td><td><button class="x" data-id="${m.id}">🗑</button></td></tr>`; }).join('')}</table></div>` : '<div class="card center muted">لا توجد علامات بعد</div>'}`;
}
function bindMarks(k, g) {
  bindAnalysis(k, g, true);
  const ref = doc(db, 'students', k.sid);
  $('mAdd').onclick = async () => {
    const m = { id: Date.now().toString(36), grade: g, subject: $('mSub').value, type: $('mType').value, sem: $('mSem').value, score: +latinDigits($('mScore').value), outOf: +latinDigits($('mOut').value), date: $('mDate').value };
    if ($('mScore').value === '' || !(m.outOf > 0) || m.score < 0 || m.score > m.outOf) return ($('mErr').textContent = 'تأكدي من العلامة');
    try { await setDoc(ref, { grades: arrayUnion(m) }, { merge: true }); k.marks = [...(k.marks || []), m]; toast('تم حفظ العلامة ✅'); render(); } catch { $('mErr').textContent = 'ما زبط الحفظ'; }
  };
  app.querySelectorAll('.x[data-id]').forEach((b) => b.onclick = async () => {
    if (!confirm('حذف هذه العلامة؟')) return;
    const left = (k.marks || []).filter((m) => m.id !== b.dataset.id);
    try { await setDoc(ref, { grades: left }, { merge: true }); k.marks = left; render(); } catch { toast('ما زبط الحذف'); }
  });
}
function infoHTML(k) {
  const sec = k.secret || {};
  return `<div class="two"><div>
      <div class="card"><h3>🔐 بيانات دخول الطالب</h3>${k.login ? `<div class="cred"><div class="kv"><span>رقم الدخول</span><code>${esc(k.login)}</code></div>
        <div class="kv"><span>كلمة السر</span><code id="pwShow">${sec.pw ? '••••••••••' : '—'}</code></div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${sec.pw ? '<button class="btn sm" id="pwEye">إظهار</button><button class="btn sm line" id="pwCopy">نسخ</button>' : ''}<button class="btn sm line" id="pwNew">كلمة سر جديدة</button></div>`
        : `<p class="muted">هذا الطالب ما إله بيانات دخول بعد.</p><button class="btn" id="mkLogin">توليد رقم دخول وكلمة سر</button>`}</div>
      <div class="card"><h3>🔔 رسالة للطالب</h3><div class="field"><textarea id="noteTxt" placeholder="بتظهر للطالب بالصفحة الرئيسية">${esc(k.note || '')}</textarea></div>
        <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm" id="noteSave">حفظ</button><button class="btn sm line" id="noteClear">مسح</button></div></div>
      <div class="card"><h3>🎓 الصف</h3><p class="muted small">لما ينتقل لصف أعلى غيّريه هون. بيانات الدخول بتضل نفسها، ونتائج الصفوف السابقة محفوظة.</p>
        <div style="display:flex;gap:8px;align-items:end">${sel('kGradeOnly', 'الصف الحالي', gradeOpts(), k.grade)}<button class="btn" id="gSave">نقل</button></div></div></div>
    <div><div class="card form"><h3>📋 بيانات الطالب</h3>${kidForm(k, true)}
      <div class="err" id="kErr"></div><button class="btn" id="kSave">حفظ البيانات</button></div></div></div>`;
}
function bindInfo(k) {
  bindKidForm();
  const ref = doc(db, 'students', k.sid);
  const mk = $('mkLogin'); if (mk) mk.onclick = async () => { mk.disabled = true;
    try { if (!(await getDoc(ref)).exists()) await setDoc(ref, { name: k.name, grade: k.grade }, { merge: true }); const cred = await makeLogin(k.sid); k.login = cred.code; k.secret = { ...(k.secret || {}), pw: cred.pw }; showCred(k, cred, render); }
    catch (e) { console.warn(e); toast('ما زبط — تأكدي إن قواعد Firebase محدّثة'); mk.disabled = false; } };
  const eye = $('pwEye'); if (eye) eye.onclick = () => { const s = $('pwShow'), on = s.textContent.includes('•'); s.textContent = on ? k.secret.pw : '••••••••••'; eye.textContent = on ? 'إخفاء' : 'إظهار'; };
  const cp = $('pwCopy'); if (cp) cp.onclick = () => navigator.clipboard.writeText(`رقم الدخول: ${k.login}\nكلمة السر: ${k.secret.pw}`).then(() => toast('تم النسخ ✅'));
  const nw = $('pwNew'); if (nw) nw.onclick = async () => {
    if (!confirm('بنولّد كلمة سر جديدة، والقديمة بتوقف. متأكدة؟')) return;
    nw.disabled = true;
    try {
      const a2 = kidAuth(), pw = rndDigits(10);
      if (!k.secret || !k.secret.pw) throw new Error('no old pw');
      const c = await signInWithEmailAndPassword(a2, k.login + KID_DOMAIN, k.secret.pw);
      await updatePassword(c.user, pw); signOut(a2).catch(() => {});
      await setDoc(doc(db, 'kidsecret', k.sid), { pw }, { merge: true }); k.secret.pw = pw;
      showCred(k, { code: k.login, pw }, render);
    } catch (e) { console.warn(e); toast('ما زبط تغيير كلمة السر'); nw.disabled = false; }
  };
  const saveNote = async (t) => { try { await setDoc(ref, { note: t, noteAt: serverTimestamp() }, { merge: true }); k.note = t; toast('تم الحفظ ✅'); } catch { toast('ما زبط الحفظ'); } };
  $('noteSave').onclick = () => saveNote($('noteTxt').value.trim());
  $('noteClear').onclick = () => { $('noteTxt').value = ''; saveNote(''); };
  $('gSave').onclick = async () => {
    const g = +$('kGradeOnly').value; if (g === k.grade) return toast('هذا صفه الحالي');
    if (!confirm(`نقل ${k.name} إلى ${gName(g)}؟ نتائجه السابقة بتضل محفوظة.`)) return;
    try { await setDoc(ref, { grade: g, history: arrayUnion({ grade: g, t: Date.now() }) }, { merge: true }); k.grade = g; sess.set('kg:' + k.sid, g); toast(`صار ${k.name} في ${gName(g)} ✅`); render(); } catch { toast('ما زبط الحفظ'); }
  };
  $('kSave').onclick = async () => {
    const r = readKidForm(); if (r.err) return ($('kErr').textContent = r.err);
    delete r.k.grade;
    try { await setDoc(ref, r.k, { merge: true }); await setDoc(doc(db, 'kidsecret', k.sid), { notes: r.notes || '' }, { merge: true });
      Object.assign(k, r.k); k.secret = { ...(k.secret || {}), notes: r.notes }; toast('تم حفظ البيانات ✅'); render(); } catch { $('kErr').textContent = 'ما زبط الحفظ'; }
  };
}

// ---------- student ----------
function studentHome() {
  const k = C.kid;
  if (!k) { app.innerHTML = `<div class="card center"><h3>حسابك مش مربوط بطالب</h3><div class="muted">اطلب من أهلك يتأكدوا من بيانات دخولك.</div></div>`; return; }
  const g = k.grade, rs = myResults(g), st = stats(rs), slot = todaySubject(k);
  app.innerHTML = `<div class="hello fade"><h1>أهلاً ${esc(k.name)} ${k.gender === 'f' ? '🌸' : '⭐'}</h1><p>${esc(gName(g))}</p></div>
    ${k.note ? `<div class="note" style="margin-bottom:14px"><b>🔔 رسالة من أهلك</b>${esc(k.note)}</div>` : ''}
    <div class="stats"><div class="stat"><b>${st.avg}%</b><small>مستواك</small></div><div class="stat"><b>${st.lessons}</b><small>درس حليته</small></div><div class="stat"><b>${st.toFix}</b><small>خطأ لتصحيحه</small></div></div>
    <div class="grid wide" style="margin-top:12px">
      ${slot ? `<a class="card tile" href="#/s/${g}/${slot.id}" style="box-shadow:none"><div class="kid"><div class="avatar">${slot.icon}</div><div><div class="muted small">مادة اليوم</div><b>${esc(slot.name)}</b></div></div></a>` : ''}
      ${st.toFix ? `<a class="card tile" href="#/me/analysis" style="box-shadow:none"><div class="kid"><div class="avatar">🛠️</div><div><b>صحّح أخطاءك</b><div class="muted small">${st.toFix} سؤال غلطت فيهم</div></div></div></a>` : ''}
      <a class="card tile" href="#/schedule" style="box-shadow:none"><div class="kid"><div class="avatar">🗓️</div><div><b>جدول الدراسة</b><div class="muted small">مادة لكل يوم</div></div></div></a></div>
    <div class="sec"><h2>موادي</h2><a href="#/grades">صفوف ثانية</a></div>
    <div class="grid">${P.grades[g].subjects.map((s) => subjTile(g, s, rs)).join('')}</div>`;
}
function scheduleOrder(k) { const ids = P.grades[k.grade].subjects.map((s) => s.id), saved = (k.order || []).filter((id) => ids.includes(id)); return saved.length === ids.length ? saved : shuffle(ids, seeded(String(k.sid))); }
function lastSaturday(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); return x; }
function slotOf(k, weeks) { const now = new Date(); if (now.getDay() === 5) return null; const start = lastSaturday(k.start && k.start.toDate ? k.start.toDate() : new Date(2026, 9, 24));
  const w = Math.floor((lastSaturday(now) - start) / (7 * 864e5)); return { week: ((w % weeks) + weeks) % weeks, day: (now.getDay() + 1) % 7 }; }
function todaySubject(k) { const o = scheduleOrder(k), weeks = Math.max(1, Math.ceil(o.length / 6)), sl = slotOf(k, weeks); return sl && sl.day < 6 ? subjOf(k.grade, o[sl.week * 6 + sl.day]) : null; }
function schedulePage() {
  const k = C.kid; if (!k) return go('#/');
  const o = scheduleOrder(k), weeks = Math.max(1, Math.ceil(o.length / 6)), sl = slotOf(k, weeks);
  let h = `<h1 class="page-h">🗓️ جدول الدراسة</h1>`;
  for (let w = 0; w < weeks; w++) {
    h += `<div class="card">${weeks > 1 ? `<h3>الأسبوع ${w + 1}</h3>` : ''}<table class="sched">${DAYS.map((d, i) => { const s = subjOf(k.grade, o[w * 6 + i]);
      return `<tr class="${sl && sl.week === w && sl.day === i ? 'now' : ''}"><td>${d}</td><td>${s ? `${s.icon} ${esc(s.name)}` : '🔁 مراجعة عامة'}</td></tr>`; }).join('')}<tr class="fri"><td>الجمعة</td><td>🌴 عطلة</td></tr></table></div>`;
  }
  app.innerHTML = h;
}

// ---------- settings ----------
function settingsPage() {
  if (C.mode === 'visitor') return go('#/login');
  const parent = C.mode === 'parent';
  app.innerHTML = `<h1 class="page-h">الإعدادات</h1><div class="two"><div>
    <div class="card"><h3>المظهر</h3>${themePicker()}</div>
    ${parent ? `<div class="card form"><h3>حسابي</h3>${inp('oName', 'الاسم', `value="${esc(C.owner.name || '')}"`)}
      ${inp('oPhone', 'رقم الجوال (للدخول)', `type="tel" dir="ltr" value="${esc(C.owner.phone ? '0' + C.owner.phone : '')}"`)}
      <div class="muted small">البريد للاسترداد: <span dir="ltr">${esc(C.email)}</span></div><div class="err" id="oErr"></div><button class="btn" id="oSave">حفظ</button></div>` : ''}
    </div><div>
    ${parent ? `<div class="card"><h3>🔒 رمز لوحة الأهل</h3><p class="muted small">${C.owner.pin ? 'لوحة الأهل محمية برمز.' : 'ما في رمز. أي حد بيفتح الجهاز بيقدر يدخل لوحة الأهل.'}</p><button class="btn line" id="pinBtn">${C.owner.pin ? 'تغيير الرمز' : 'إضافة رمز'}</button></div>` : `<div class="card"><h3>حسابي</h3><div>${esc(C.kid ? C.kid.name : '')}</div><div class="muted small">رقم الدخول: <span dir="ltr">${esc(C.email.split('@')[0])}</span></div></div>`}
    <div class="card"><button class="btn danger block" id="outBtn">🚪 تسجيل الخروج</button></div></div></div>`;
  bindThemePicker(settingsPage);
  $('outBtn').onclick = logout;
  if (!parent) return;
  $('pinBtn').onclick = () => C.owner.pin ? needPin(() => setPin(settingsPage)) : setPin(settingsPage);
  $('oSave').onclick = async () => {
    const name = $('oName').value.trim(), phone = normPhone($('oPhone').value), err = (t) => { $('oErr').textContent = t; };
    if (name.length < 3) return err('اكتبي الاسم');
    if (phone && (phone.length < 8 || phone.length > 12)) return err('رقم الجوال غير صحيح');
    try {
      if (phone && phone !== C.owner.phone) {
        const ex = await getDoc(doc(db, 'phones', phone));
        if (ex.exists() && ex.data().email !== C.email) return err('الرقم مسجّل لحساب ثاني');
        await setDoc(doc(db, 'phones', phone), { email: C.email });
        if (C.owner.phone) await deleteDoc(doc(db, 'phones', C.owner.phone)).catch(() => {});
      }
      await setDoc(doc(db, 'owners', C.email), { name, phone: phone || C.owner.phone || '', role: 'parent' }, { merge: true });
      Object.assign(C.owner, { name, phone: phone || C.owner.phone }); err(''); toast('تم الحفظ ✅');
    } catch (e) { console.warn(e); err('ما زبط الحفظ — تأكدي إن قواعد Firebase محدّثة'); }
  };
}

// ---------- book reader (pdf.js) ----------
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsReady;
function loadPdfjs() { return pdfjsReady ||= new Promise((ok, fail) => { const sc = document.createElement('script'); sc.src = PDFJS + 'pdf.min.js';
  sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); }; sc.onerror = fail; document.head.appendChild(sc); }); }
async function openBook(file, s, b) {
  const box = $('pages'), info = $('pgInfo');
  try {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ url: file, cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/' }).promise;
    if (!box.isConnected) return; info.textContent = `${pdf.numPages} صفحة`;
    const vp1 = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const io = new IntersectionObserver((ents) => ents.forEach((e) => { if (!e.isIntersecting || e.target.dataset.done) return; e.target.dataset.done = 1; io.unobserve(e.target); drawPage(pdf, +e.target.dataset.n, e.target, s, b); }), { rootMargin: '800px 0px' });
    for (let n = 1; n <= pdf.numPages; n++) { const d = document.createElement('div'); d.className = 'page'; d.dataset.n = n; d.style.aspectRatio = `${vp1.width} / ${vp1.height}`; d.innerHTML = `<span class="pn">${n}</span>`; box.appendChild(d); io.observe(d); }
  } catch { info.textContent = 'ما قدرنا نعرض الكتاب هون — اضغط تنزيل'; }
}
async function drawPage(pdf, n, el, s, b) {
  const page = await pdf.getPage(n), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: (el.clientWidth / page.getViewport({ scale: 1 }).width) * dpr });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; el.style.aspectRatio = `${vp.width} / ${vp.height}`; el.prepend(c);
  const ask = document.createElement('button'); ask.className = 'askpage'; ask.textContent = '🤖 اسأل عن هالصفحة';
  ask.onclick = async () => { pendingImg = await shrinkImage(c, `صفحة ${n} — ${s.name} ${b.title}`); go('#/ai'); };
  el.appendChild(ask);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
}

// ---------- smart assistant (Gemini via Firebase AI Logic) ----------
const chatLog = []; let aiChat = null, aiLib, aiModel = 0, pendingImg = null, speakNext = false;
const AI_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
function fmtAI(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^[*-] /gm, '• ').replace(/\n/g, '<br>'); }
const bubble = (m, i) => `<div class="msg ${m.who}">${m.img ? `<img class="mimg" src="${m.img}" alt="">` : ''}${m.who === 'bot' ? fmtAI(m.text) : esc(m.text)}${m.ok && m.who === 'bot' && window.speechSynthesis ? ` <button class="say" data-i="${i}" title="اسمع">🔊</button>` : ''}</div>`;
function speak(t) { const ss = window.speechSynthesis; if (!ss) return; ss.cancel(); const u = new SpeechSynthesisUtterance(t.replace(/[#*_`]/g, '').replace(/\p{Extended_Pictographic}/gu, '')); u.lang = 'ar'; const v = ss.getVoices().find((x) => /^ar/i.test(x.lang)); if (v) u.voice = v; u.rate = G <= 4 ? 0.9 : 1; ss.speak(u); }
function listen(btn) { const r = new Rec(); r.lang = 'ar-PS'; r.interimResults = false; btn.classList.add('rec'); toast('🎤 احكي سؤالك…');
  r.onresult = (e) => { const t = e.results[0][0].transcript.trim(); if (t) { speakNext = true; askAI(t); } };
  r.onerror = (e) => toast(e.error === 'not-allowed' ? 'لازم تسمح للموقع يستعمل المايك' : 'ما سمعت منيح، جرّب مرة ثانية'); r.onend = () => btn.classList.remove('rec'); r.start(); }
function shrinkImage(src, label) { return new Promise((ok) => { const done = (img) => { const k = Math.min(1, 1280 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); const url = c.toDataURL('image/jpeg', 0.8); ok({ url, data: url.split(',')[1], label }); };
  if (src instanceof HTMLCanvasElement) return done(src); const im = new Image(); im.onload = () => done(im); im.src = URL.createObjectURL(src); }); }
function aiPage() {
  const who = C.kid ? C.kid.name : '';
  app.innerHTML = `<h1 class="page-h">🤖 المساعد الذكي</h1><p class="muted" style="margin-top:-8px">اسأل عن أي درس من كتب ${esc(gName(G))}، بالكتابة أو بصوتك أو بصورة.</p>
    <div class="card"><div class="chat" id="chat">${chatLog.map(bubble).join('') || `<div class="msg bot">أهلاً ${esc(who)} 👋 شو بتحب نتعلم اليوم؟</div>`}</div>
    <div class="chips" style="margin-bottom:8px">${['اشرحلي درساً بطريقة سهلة', 'اسألني 5 أسئلة في الرياضيات', 'كيف أنظّم وقت دراستي؟'].map((t) => `<button class="chip">${t}</button>`).join('')}</div>
    ${pendingImg ? `<div class="pimg"><img src="${pendingImg.url}" alt=""><span class="small">${esc(pendingImg.label || 'صورة مرفقة')}</span><button class="x" id="pimgX">✕</button></div>` : ''}
    <form class="ask" id="askF"><label class="cam" title="صورة">📷<input type="file" accept="image/*" capture="environment" id="askImg" hidden></label>${Rec ? '<button type="button" class="cam" id="micBtn">🎤</button>' : ''}
      <input id="askQ" placeholder="اكتب سؤالك…" autocomplete="off"><button class="btn">إرسال</button></form></div>`;
  const box = $('chat'); box.scrollTop = box.scrollHeight;
  app.querySelectorAll('.chips .chip').forEach((c) => c.onclick = () => askAI(c.textContent));
  if (Rec) $('micBtn').onclick = (e) => listen(e.currentTarget);
  app.querySelectorAll('.say').forEach((b) => b.onclick = () => speak(chatLog[+b.dataset.i].text));
  $('askImg').onchange = async (e) => { const f = e.target.files[0]; if (f) { pendingImg = await shrinkImage(f); aiPage(); } };
  if (pendingImg) $('pimgX').onclick = () => { pendingImg = null; aiPage(); };
  $('askF').onsubmit = (e) => { e.preventDefault(); const q = $('askQ').value.trim(); if (q || pendingImg) { const im = pendingImg; pendingImg = null; askAI(q || 'اقرأ السؤال في الصورة واشرحلي كيف أحله خطوة خطوة', im); } };
}
async function newChat() {
  aiLib ||= await import('https://www.gstatic.com/firebasejs/12.3.0/firebase-ai.js');
  const { getAI, getGenerativeModel, GoogleAIBackend } = aiLib, ai = getAI(fb, { backend: new GoogleAIBackend() });
  const sys = `أنت «المساعد الذكي»، معلّم لطيف وصبور لطالب في ${gName(G)} (المنهاج الفلسطيني). المواد: ${P.grades[G].subjects.map((s) => s.name).join('، ')}.
- التزم بمحتوى كتب المنهاج: جاوب بجواب بسيط وواضح ولا تخرج عن مواضيع الدراسة.
- اشرح خطوة بخطوة واسأل الطالب ليفكّر، ولا تعطِ حل الواجب كاملاً دون شرح.${G <= 4 ? '\n- الطالب طفل صغير: جمل قصيرة جداً وأمثلة من حياته.' : ''}
- في الإنجليزي اشرح بالعربية مع أمثلة إنجليزية. إذا أرسل صورة اقرأها بدقة واشرح الحل.
- ابتعد عن أي موضوع غير مناسب للأطفال.`;
  return (m) => getGenerativeModel(ai, { model: m, systemInstruction: sys }).startChat({ history: chatLog.filter((x) => x.ok).map((x) => ({ role: x.who === 'me' ? 'user' : 'model', parts: [{ text: x.text }] })) });
}
async function askAI(q, img) {
  chatLog.push({ who: 'me', text: q, img: img && img.url }); const pending = { who: 'bot', text: '…' }; chatLog.push(pending);
  if (parse().name === 'ai') aiPage();
  try {
    let r, tries = 0; const msg = img ? [{ text: q }, { inlineData: { mimeType: 'image/jpeg', data: img.data } }] : q;
    for (;;) { try { aiChat ||= (await newChat())(AI_MODELS[aiModel]); r = await aiChat.sendMessage(msg); break; }
      catch (e) { aiChat = null; const m = String(e && e.message);
        if (/not found|404|not supported|no longer available/i.test(m) && aiModel < AI_MODELS.length - 1) { aiModel++; continue; }
        if (/503|500|429|401|deadline|overloaded|fetch|network/i.test(m) && tries++ < 3) { await new Promise((ok) => setTimeout(ok, 1500 * tries)); continue; } throw e; } }
    pending.text = r.response.text(); pending.ok = true; chatLog[chatLog.length - 2].ok = true; if (speakNext) speak(pending.text);
  } catch (e) { aiChat = null; const m = String(e && e.message);
    pending.text = /not.?enabled|PERMISSION|403/i.test(m) ? 'المساعد الذكي لسا مش مفعّل.' : /429|quota|RESOURCE_EXHAUSTED/i.test(m) ? 'المساعد وصل للحد اليومي، جرّب بعد شوي.' : 'صار خطأ بالاتصال، جرّب مرة ثانية.'; }
  speakNext = false; if (parse().name === 'ai') aiPage();
}

// ---------- router ----------
function go(h) { if (location.hash === h) render(); else location.hash = h; }
function parse() { const [path] = (location.hash.slice(1) || '/').split('?'); const [name, ...args] = path.split('/').filter(Boolean); return { name: routes[name] ? name : 'home', args }; }
const TITLES = { home: '', grades: 'الصفوف', g: '', s: '', read: 'الكتاب', quiz: 'اختبار', fix: 'تصحيح الأخطاء', login: 'تسجيل الدخول', signup: 'حساب جديد', addkid: 'إضافة طالب', kid: 'لوحة الأهل', me: 'مستواي', schedule: 'الجدول', settings: 'الإعدادات', ai: 'المساعد' };
function render() {
  const r = parse(); closeSheet(); chrome();
  $('ttl').textContent = TITLES[r.name] || (r.name === 'g' || r.name === 's' ? gName(r.args[0]) : '') || 'منصة الطالب';
  if (!C.ready) { app.innerHTML = '<div class="card center muted" style="margin-top:30px">جاري التحميل…</div>'; return; }
  routes[r.name](...r.args); window.scrollTo(0, 0);
}
function rerender() {
  const r = parse(); if (!C.ready || r.name === 'quiz' || r.name === 'fix' || routes[r.name].keep) return;
  const a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  const y = window.scrollY; routes[r.name](...r.args); window.scrollTo(0, y);
}
addEventListener('hashchange', render);
render();
