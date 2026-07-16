import { firebaseConfig, app, usernameToEmail } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot,
  getDoc, setDoc, query, orderBy, serverTimestamp, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const auth = getAuth(app);
const db = getFirestore(app);

// Register the service worker — needed both for offline app-shell caching and
// for Chrome/Edge to consider this installable as a desktop/mobile app.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => console.warn("Service worker registration failed:", err));
  });
}

// ---------------------------------------------------------------
// LOGIN BACKGROUND VIDEO — handle autoplay quirks across iOS/Android/
// desktop. The CSS gradient behind it always animates regardless, so
// there's motion even if the video can't play for any reason.
// ---------------------------------------------------------------
(function setupLoginVideo() {
  const video = document.getElementById("login-bg-video");
  if (!video) return;
  video.muted = true;
  video.playsInline = true;
  video.addEventListener("playing", () => video.classList.add("ready"));
  video.addEventListener("error", () => console.warn("Login background video failed to load — check login-bg.mp4 was pushed to the repo root."));
  const tryPlay = () => video.play().catch(() => { /* autoplay blocked; gradient fallback still shows */ });
  tryPlay();
  // Some mobile browsers only allow playback after the first user gesture.
  document.addEventListener("click", tryPlay, { once: true });
  document.addEventListener("touchstart", tryPlay, { once: true });
})();

// ---------------------------------------------------------------
// STATE
// ---------------------------------------------------------------
const STAGES = ["pending", "pitched", "rejected", "enrolled"];
const CATEGORIES = [
  { key: "parent", label: "Parents" },
  { key: "athlete", label: "Athletes" },
  { key: "academy", label: "Academies / Coaches" }
];
const STEP_KEYS = [
  { key: "inferencing", label: "Inferencing" },
  { key: "annotation", label: "Annotation" },
  { key: "reportGeneration", label: "Report Gen" },
  { key: "reportSent", label: "Report Sent" }
];
const ANNOTATORS = ["Mourya", "Keerthi", "Benoush", "Srinivas V", "Srinivas P", "Harkhraj"];
const VALID_ROLES = ["admin", "sales", "tournament"];
const PLAN_DEFS = {
  demo:        { label: "Demo / Free Trial", applies: ["parent","athlete"], tier: "demo" },
  foundation:  { label: "Foundation",        applies: ["parent","athlete"], tier: "mid"  },
  performance: { label: "Performance",       applies: ["parent","athlete"], tier: "high" },
  elite:       { label: "Elite",             applies: ["parent","athlete"], tier: "top"  },
  demo_pilot:  { label: "Demo Pilot",        applies: ["academy"],          tier: "demo" },
  super25:     { label: "Super 25",          applies: ["academy"],          tier: "mid"  },
  super100:    { label: "Super 100",         applies: ["academy"],          tier: "high" },
  super500:    { label: "Super 500",         applies: ["academy"],          tier: "top"  }
};
function plansForCategory(cat) {
  return Object.entries(PLAN_DEFS).filter(([,v]) => v.applies.includes(cat)).map(([key,v]) => ({ key, ...v }));
}
function allPlanDefs() {
  return Object.entries(PLAN_DEFS).map(([key,v]) => ({ key, ...v }));
}
function planLabel(key) { return PLAN_DEFS[key]?.label || "Not set"; }
function planTierClass(key) { return "tier-" + (PLAN_DEFS[key]?.tier || "demo"); }

const COUNTRY_CODES = [
  { code: "+91", name: "India", digits: 10 },
  { code: "+1", name: "USA / Canada", digits: 10 },
  { code: "+44", name: "UK", digits: 10 },
  { code: "+971", name: "UAE", digits: 9 },
  { code: "+61", name: "Australia", digits: 9 },
  { code: "+65", name: "Singapore", digits: 8 }
];

function splitPhone(full) {
  if (!full) return { code: "+91", number: "" };
  const m = String(full).trim().match(/^(\+\d{1,4})\s*(.*)$/);
  if (m) return { code: m[1], number: m[2].replace(/\D/g, "") };
  return { code: "+91", number: String(full).replace(/\D/g, "") };
}
function renderPhoneFieldHTML(prefix, existingFull) {
  const { code, number } = splitPhone(existingFull);
  return `
    <div class="phone-field">
      <select id="${prefix}-cc">
        ${COUNTRY_CODES.map(c => `<option value="${c.code}" data-digits="${c.digits}" ${c.code===code?"selected":""}>${c.name} (${c.code})</option>`).join("")}
      </select>
      <input type="tel" id="${prefix}-num" value="${escapeAttr(number)}" placeholder="Phone number" inputmode="numeric" maxlength="15">
    </div>
    <div class="field-error" id="${prefix}-err"></div>
  `;
}
function validatePhoneField(prefix, required) {
  const cc = document.getElementById(`${prefix}-cc`);
  const num = document.getElementById(`${prefix}-num`);
  const err = document.getElementById(`${prefix}-err`);
  const digits = num.value.replace(/\D/g, "");
  const expected = COUNTRY_CODES.find(c => c.code === cc.value)?.digits;
  if (!digits) {
    if (required) { err.textContent = "Phone number is required."; return null; }
    err.textContent = ""; return "";
  }
  if (digits.length !== expected) {
    err.textContent = `${cc.options[cc.selectedIndex].text} numbers must be exactly ${expected} digits.`;
    return null;
  }
  err.textContent = "";
  return `${cc.value} ${digits}`;
}
function validateEmailField(id, required) {
  const el = document.getElementById(id);
  const errEl = document.getElementById(id + "-err");
  const val = el.value.trim();
  if (!val) {
    if (errEl) errEl.textContent = required ? "Email is required." : "";
    return required ? null : "";
  }
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
  if (!ok) { if (errEl) errEl.textContent = "Enter a valid email address."; return null; }
  if (errEl) errEl.textContent = "";
  return val;
}
function renderPlanPickerHTML(pickerId, category, selectedKey) {
  const plans = plansForCategory(category);
  return `<div class="plan-picker" id="${pickerId}">
    ${plans.map(p => `<button type="button" class="plan-pill ${p.key===selectedKey?"selected":""}" data-plan="${p.key}">${p.label}</button>`).join("")}
  </div>`;
}
function wirePlanPicker(pickerId) {
  const container = document.getElementById(pickerId);
  if (!container) return;
  container.querySelectorAll(".plan-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".plan-pill").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });
}
function getSelectedPlan(pickerId, fallback) {
  const container = document.getElementById(pickerId);
  const sel = container?.querySelector(".plan-pill.selected");
  return sel?.dataset.plan || fallback;
}
function roleFieldPlaceholder(category) {
  return category === "academy" ? "e.g. Management, Head Coach, Owner" : "e.g. Father, Mother, Guardian";
}
const SUPER_ADMIN_USERNAMES = ["suresh", "sesha"];

let appUsers = [];

let currentUser = null;   // { uid, name, role, username }
let currentView = "dashboard";
let currentSalesTab = "parent";
let currentRmTab = "parent";
let selectedTournamentId = null;

let salesLeads = [];
let rmContacts = [];
let tournaments = [];
let registrations = [];
let progressDocs = [];

let unsubs = [];

// ---------------------------------------------------------------
// TOAST + SAFE WRITES (shows a fading warning if Firestore rejects
// a write, e.g. someone acting outside their role's permissions)
// ---------------------------------------------------------------
function showToast(message) {
  const stack = document.getElementById("toast-stack");
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = message;
  stack.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
function reportDbError(err) {
  if (err && err.code === "permission-denied") {
    showToast("You don't have permission to do that.");
  } else {
    showToast("Something went wrong — please try again.");
  }
  console.error(err);
}
async function safeAdd(colName, data) {
  try { return await addDoc(collection(db, colName), data); }
  catch (err) { reportDbError(err); throw err; }
}
async function safeUpdate(colName, id, data) {
  try { return await updateDoc(doc(db, colName, id), data); }
  catch (err) { reportDbError(err); throw err; }
}
async function safeDelete(colName, id) {
  try { return await deleteDoc(doc(db, colName, id)); }
  catch (err) { reportDbError(err); throw err; }
}
async function safeSet(colName, id, data) {
  try { return await setDoc(doc(db, colName, id), data); }
  catch (err) { reportDbError(err); throw err; }
}

// ---------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------
const loginScreen = document.getElementById("login-screen");
const appShell = document.getElementById("app-shell");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");

loginBtn.addEventListener("click", handleLogin);
document.getElementById("login-password").addEventListener("keydown", e => {
  if (e.key === "Enter") handleLogin();
});

async function handleLogin() {
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  if (!username || !password) {
    loginError.textContent = "Enter both username and password.";
    return;
  }
  loginError.textContent = "";
  loginBtn.textContent = "Signing in…";
  try {
    await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
  } catch (err) {
    loginError.textContent = "Incorrect username or password.";
    loginBtn.textContent = "Sign in";
  }
}

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (user) {
    const userDocSnap = await getDoc(doc(db, "users", user.uid));
    if (!userDocSnap.exists()) {
      loginError.textContent = "No profile found for this account. Ask an admin to add you in the users collection.";
      loginBtn.textContent = "Sign in";
      await signOut(auth);
      return;
    }
    const profile = userDocSnap.data();
    if (!VALID_ROLES.includes(profile.role)) {
      loginError.textContent = "This account's access has been disabled. Contact an admin.";
      loginBtn.textContent = "Sign in";
      await signOut(auth);
      return;
    }
    currentUser = { uid: user.uid, name: profile.name, role: profile.role, username: profile.username };
    enterApp();
  } else {
    currentUser = null;
    unsubs.forEach(u => u());
    unsubs = [];
    loginScreen.classList.remove("hidden");
    appShell.classList.add("hidden");
    loginBtn.textContent = "Sign in";
    document.getElementById("login-password").value = "";
  }
});

function enterApp() {
  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  document.getElementById("user-name-display").textContent = currentUser.name;
  document.getElementById("user-role-display").textContent = roleLabel(currentUser.role);
  document.getElementById("user-initial").textContent = currentUser.name.charAt(0).toUpperCase();
  applyRoleVisibility();
  attachListeners();
  navigateTo("dashboard");
}

function roleLabel(role) {
  if (role === "admin") return "Admin";
  if (role === "sales") return "Sales";
  if (role === "tournament") return "Tournament Stage";
  return role;
}

function isSuperAdmin() {
  return currentUser.role === "admin" && SUPER_ADMIN_USERNAMES.includes((currentUser.username || "").toLowerCase());
}

function applyRoleVisibility() {
  const salesNav = document.querySelector('.nav-item[data-view="sales"]');
  const rmNav = document.querySelector('.nav-item[data-view="rm"]');
  const clientsNav = document.querySelector('.nav-item[data-view="clients"]');
  const progressNav = document.querySelector('.nav-item[data-view="progress"]');
  const backupNav = document.querySelector('.nav-item[data-view="backup"]');
  const usersNav = document.querySelector('.nav-item[data-view="users"]');
  // Everyone can view Dashboard. Adjust nav based on role.
  if (currentUser.role === "sales") {
    rmNav.style.display = "none";
    clientsNav.style.display = "none";
    progressNav.style.display = "none";
    backupNav.style.display = "none";
  } else if (currentUser.role === "tournament") {
    salesNav.style.display = "none";
    backupNav.style.display = "none";
  } else {
    // admin sees everything
    salesNav.style.display = "";
    rmNav.style.display = "";
    clientsNav.style.display = "";
    progressNav.style.display = "";
    backupNav.style.display = "";
  }
  // Users tab: only Suresh/Sesha specifically, regardless of anyone else's admin role.
  usersNav.style.display = isSuperAdmin() ? "" : "none";
}

function canEditSales() { return currentUser.role === "admin" || currentUser.role === "sales"; }
function canEditRM() { return currentUser.role === "admin"; }
function canEditPriority() { return currentUser.role === "admin" || currentUser.role === "tournament"; }
function canEditProgress() { return currentUser.role === "admin" || currentUser.role === "tournament"; }

// ---------------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------------
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => navigateTo(item.dataset.view));
});
document.getElementById("menu-toggle").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
});

function navigateTo(view) {
  currentView = view;
  document.querySelectorAll(".nav-item").forEach(i => i.classList.toggle("active", i.dataset.view === view));
  document.getElementById("sidebar").classList.remove("open");
  render();
}

// ---------------------------------------------------------------
// REALTIME LISTENERS
// ---------------------------------------------------------------
function attachListeners() {
  unsubs.push(onSnapshot(query(collection(db, "salesLeads"), orderBy("createdAt", "desc")), snap => {
    salesLeads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentView === "dashboard" || currentView === "sales") render();
  }));
  unsubs.push(onSnapshot(query(collection(db, "rmContacts"), orderBy("createdAt", "desc")), snap => {
    rmContacts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentView === "dashboard" || currentView === "rm" || currentView === "clients") render();
  }));
  unsubs.push(onSnapshot(collection(db, "tournaments"), snap => {
    tournaments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    tournaments.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    if (!selectedTournamentId && tournaments.length) selectedTournamentId = tournaments[0].id;
    if (currentView === "rm" || currentView === "progress") render();
  }));
  unsubs.push(onSnapshot(collection(db, "registrations"), snap => {
    registrations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentView === "rm" || currentView === "progress") render();
  }));
  unsubs.push(onSnapshot(collection(db, "progress"), snap => {
    progressDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentView === "progress") render();
  }));
  if (isSuperAdmin()) {
    unsubs.push(onSnapshot(collection(db, "users"), snap => {
      appUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (currentView === "users") render();
    }));
  }
}

// ---------------------------------------------------------------
// RENDER ROOT
// ---------------------------------------------------------------
const root = document.getElementById("view-root");
function render() {
  if (currentView === "dashboard") return renderDashboard();
  if (currentView === "sales") return renderSales();
  if (currentView === "rm") return renderRM();
  if (currentView === "clients") return renderClients();
  if (currentView === "progress") return renderProgress();
  if (currentView === "backup") return renderBackup();
  if (currentView === "users") return renderUsers();
}

// ---------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------
function renderDashboard() {
  const countByCat = (list, cat) => list.filter(x => x.category === cat).length;
  const enrolledByCat = cat => salesLeads.filter(x => x.category === cat && x.stage === "enrolled").length;

  const totalLeads = salesLeads.length;
  const enrolled = salesLeads.filter(l => l.stage === "enrolled").length;
  const rejected = salesLeads.filter(l => l.stage === "rejected").length;
  const closedOut = enrolled + rejected;
  const successRate = closedOut > 0 ? Math.round((enrolled / closedOut) * 100) : 0;

  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div>
          <div class="page-title">Dashboard</div>
          <div class="page-desc">Onboarding snapshot &amp; sales performance</div>
        </div>
      </div>
      <div class="court-rule"></div>

      <div class="stat-grid">
        <div class="stat-card countup"><div class="stat-label">Parents Onboarded</div><div class="stat-value">${enrolledByCat("parent")}</div><div class="stat-sub">enrolled to date</div></div>
        <div class="stat-card countup"><div class="stat-label">Athletes Onboarded</div><div class="stat-value">${enrolledByCat("athlete")}</div><div class="stat-sub">enrolled to date</div></div>
        <div class="stat-card countup"><div class="stat-label">Academies Onboarded</div><div class="stat-value">${enrolledByCat("academy")}</div><div class="stat-sub">enrolled to date</div></div>
      </div>

      <div class="panel">
        <div class="panel-title">Sales Success Rate</div>
        <div class="stat-grid" style="margin-bottom:0;">
          <div class="stat-card good countup"><div class="stat-label">Success Rate</div><div class="stat-value">${successRate}%</div><div class="stat-sub">enrolled ÷ (enrolled + rejected)</div></div>
          <div class="stat-card accent countup"><div class="stat-label">Total Leads</div><div class="stat-value">${totalLeads}</div><div class="stat-sub">across all categories</div></div>
          <div class="stat-card countup"><div class="stat-label">Pending Contact</div><div class="stat-value">${salesLeads.filter(l => l.stage === "pending").length}</div><div class="stat-sub">awaiting outreach</div></div>
          <div class="stat-card bad countup"><div class="stat-label">Rejected</div><div class="stat-value">${rejected}</div><div class="stat-sub">did not convert</div></div>
        </div>
      </div>

      <div class="chart-row">
        <div class="panel chart-box">
          <div class="panel-title">Pipeline by Category</div>
          <canvas id="chart-funnel"></canvas>
        </div>
        <div class="panel chart-box">
          <div class="panel-title">Enrolled vs Rejected</div>
          <canvas id="chart-outcome"></canvas>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">By Category</div>
        <div class="funnel-grid" style="grid-template-columns:repeat(3,1fr);">
          ${CATEGORIES.map(c => `
            <div class="funnel-col">
              <div class="funnel-col-head"><span class="label">${c.label}</span></div>
              <div style="padding:14px;">
                ${STAGES.map(s => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;color:var(--chalk-dim);">
                  <span>${s.charAt(0).toUpperCase()+s.slice(1)}</span><span class="badge ${s}">${salesLeads.filter(l=>l.category===c.key && l.stage===s).length}</span>
                </div>`).join("")}
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;

  renderDashboardCharts();
}

let funnelChartInstance = null, outcomeChartInstance = null;
function renderDashboardCharts() {
  if (typeof Chart === "undefined") return;
  const funnelCtx = document.getElementById("chart-funnel");
  const outcomeCtx = document.getElementById("chart-outcome");
  if (funnelChartInstance) funnelChartInstance.destroy();
  if (outcomeChartInstance) outcomeChartInstance.destroy();

  const gridColor = "rgba(255,255,255,0.06)";
  const textColor = "#A9C2AF";

  funnelChartInstance = new Chart(funnelCtx, {
    type: "bar",
    data: {
      labels: CATEGORIES.map(c => c.label),
      datasets: STAGES.map((stage, i) => ({
        label: stage.charAt(0).toUpperCase() + stage.slice(1),
        data: CATEGORIES.map(c => salesLeads.filter(l => l.category === c.key && l.stage === stage).length),
        backgroundColor: ["#5B8CFF", "#7ED321", "#FF6B5E", "#3ECF8E"][i],
        borderRadius: 4
      }))
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: textColor, font: { size: 11 } } } },
      scales: {
        x: { stacked: true, ticks: { color: textColor }, grid: { display: false } },
        y: { stacked: true, ticks: { color: textColor, stepSize: 1 }, grid: { color: gridColor } }
      }
    }
  });

  const enrolledCount = salesLeads.filter(l => l.stage === "enrolled").length;
  const rejectedCount = salesLeads.filter(l => l.stage === "rejected").length;
  outcomeChartInstance = new Chart(outcomeCtx, {
    type: "doughnut",
    data: {
      labels: ["Enrolled", "Rejected", "Still in progress"],
      datasets: [{
        data: [enrolledCount, rejectedCount, salesLeads.length - enrolledCount - rejectedCount],
        backgroundColor: ["#3ECF8E", "#FF6B5E", "#2E5B3F"],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom", labels: { color: textColor, font: { size: 11 } } } }
    }
  });
}

// ---------------------------------------------------------------
// SALES PIPELINE
// ---------------------------------------------------------------
function renderSales() {
  const list = salesLeads.filter(l => l.category === currentSalesTab);
  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div><div class="page-title">Contacts</div><div class="page-desc">Track outreach through to enrollment</div></div>
        ${canEditSales() ? `<button class="btn btn-primary" id="add-lead-btn">+ Add Contact</button>` : ""}
      </div>
      <div class="court-rule"></div>
      ${!canEditSales() ? `<div class="access-note">View-only access.</div>` : ""}
      <div class="tabbar">
        ${CATEGORIES.map(c => `<button class="tabbtn ${currentSalesTab===c.key?"active":""}" data-tab="${c.key}">${c.label}</button>`).join("")}
      </div>
      <div class="funnel-grid">
        ${STAGES.map(stage => `
          <div class="funnel-col" data-stage="${stage}">
            <div class="funnel-col-head">
              <span class="label">${stage}</span>
              <span class="count">${list.filter(l=>l.stage===stage).length}</span>
            </div>
            <div class="funnel-list">
              ${list.filter(l=>l.stage===stage).map(l => `
                <div class="lead-card" data-id="${l.id}">
                  <div class="lname">${escapeHtml(l.name)}</div>
                  <div class="lmeta">${escapeHtml(l.contact||"")}${l.assignedTo ? " · "+escapeHtml(l.assignedTo) : ""}</div>
                </div>
              `).join("") || `<div class="empty-state">No one here yet</div>`}
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
  root.querySelectorAll(".tabbtn").forEach(b => b.addEventListener("click", () => { currentSalesTab = b.dataset.tab; renderSales(); }));
  root.querySelectorAll(".lead-card").forEach(c => c.addEventListener("click", () => openLeadModal(c.dataset.id)));
  const addBtn = document.getElementById("add-lead-btn");
  if (addBtn) addBtn.addEventListener("click", () => openLeadModal(null));
}

function openLeadModal(id) {
  const lead = id ? salesLeads.find(l => l.id === id) : null;
  const editable = canEditSales();
  showModal(`
    <h3>${lead ? "Edit Contact" : "Add Contact"}</h3>
    <div class="form-grid">
      <div class="field full"><label>Name</label><input id="m-name" value="${lead?escapeAttr(lead.name):""}" ${editable?"":"disabled"}></div>
      <div class="field"><label>Category</label>
        <select id="m-category" ${editable?"":"disabled"}>${CATEGORIES.map(c=>`<option value="${c.key}" ${lead?.category===c.key||(!lead&&currentSalesTab===c.key)?"selected":""}>${c.label}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Stage</label>
        <select id="m-stage" ${editable?"":"disabled"}>${STAGES.map(s=>`<option value="${s}" ${lead?.stage===s||(!lead&&s==="pending")?"selected":""}>${s}</option>`).join("")}</select>
      </div>
      <div class="field full"><label>Contact (phone/email)</label><input id="m-contact" value="${lead?escapeAttr(lead.contact||""):""}" ${editable?"":"disabled"}></div>
      <div class="field full"><label>Source</label><input id="m-source" value="${lead?escapeAttr(lead.source||""):""}" placeholder="Referral, inbound, cold, etc." ${editable?"":"disabled"}></div>
      <div class="field full"><label>Assigned To</label><input id="m-assigned" value="${lead?escapeAttr(lead.assignedTo||""):""}" ${editable?"":"disabled"}></div>
      <div class="field full"><label>Notes</label><textarea id="m-notes" ${editable?"":"disabled"}>${lead?escapeHtml(lead.notes||""):""}</textarea></div>
    </div>
    <div class="modal-actions">
      ${lead && editable ? `<button class="btn btn-danger" id="m-delete">Delete</button>` : ""}
      <button class="btn btn-ghost" id="m-cancel">Close</button>
      ${editable ? `<button class="btn btn-primary" id="m-save">Save</button>` : ""}
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  if (editable) {
    document.getElementById("m-save").addEventListener("click", async () => {
      const payload = {
        name: document.getElementById("m-name").value.trim(),
        category: document.getElementById("m-category").value,
        stage: document.getElementById("m-stage").value,
        contact: document.getElementById("m-contact").value.trim(),
        source: document.getElementById("m-source").value.trim(),
        assignedTo: document.getElementById("m-assigned").value.trim(),
        notes: document.getElementById("m-notes").value.trim(),
        updatedAt: serverTimestamp()
      };
      if (!payload.name) { alert("Name is required."); return; }
      try {
        let leadId;
        if (lead) {
          await safeUpdate("salesLeads", lead.id, payload);
          leadId = lead.id;
        } else {
          payload.createdAt = serverTimestamp();
          const ref = await safeAdd("salesLeads", payload);
          leadId = ref.id;
        }
        if (payload.stage === "enrolled") {
          openEnrollPlanModal(leadId, payload);
        } else {
          closeModal();
        }
      } catch (err) { /* toasted already */ }
    });
    if (lead) {
      document.getElementById("m-delete").addEventListener("click", async () => {
        if (confirm("Delete this contact permanently?")) {
          try { await safeDelete("salesLeads", lead.id); closeModal(); }
          catch (err) { /* toasted already */ }
        }
      });
    }
  }
}

// Step 2 of enrollment: choose the client's subscription plan, which either
// creates their Clients record (rmContacts) or updates the one already linked
// to this lead. This is what makes an "enrolled" sales contact show up in Clients.
function openEnrollPlanModal(leadId, payload) {
  const lead = salesLeads.find(l => l.id === leadId);
  const category = payload.category;
  const existingContactId = lead?.linkedContactId;
  const existingContact = existingContactId ? rmContacts.find(c => c.id === existingContactId) : null;
  showModal(`
    <h3>Enrolled! Set up their client plan</h3>
    <div class="access-note">${escapeHtml(payload.name)} will be added to Clients under ${CATEGORIES.find(c=>c.key===category)?.label || category}.</div>
    <div class="form-grid">
      <div class="field full"><label>Plan</label>${renderPlanPickerHTML("enroll-plan-picker", category, existingContact?.plan || plansForCategory(category)[0]?.key)}</div>
      <div class="field full"><label>Cost (optional)</label><input id="enroll-cost" value="${escapeAttr(existingContact?.cost||"")}" placeholder="e.g. ₹2,000/month"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-skip">Skip for now</button>
      <button class="btn btn-primary" id="m-save">Save &amp; Add to Clients</button>
    </div>
  `);
  wirePlanPicker("enroll-plan-picker");
  document.getElementById("m-skip").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    try {
      const plan = getSelectedPlan("enroll-plan-picker", plansForCategory(category)[0]?.key);
      const cost = document.getElementById("enroll-cost").value.trim();
      if (existingContactId && existingContact) {
        await safeUpdate("rmContacts", existingContactId, { plan, cost });
      } else {
        const ref = await safeAdd("rmContacts", {
          name: payload.name, category, contact: payload.contact || "", plan, cost,
          createdAt: serverTimestamp()
        });
        await safeUpdate("salesLeads", leadId, { linkedContactId: ref.id });
      }
      closeModal();
    } catch (err) { /* toasted already */ }
  });
}

// ---------------------------------------------------------------
// RELATIONSHIP MANAGEMENT — TOURNAMENTS
// ---------------------------------------------------------------
function renderRM() {
  const tourney = tournaments.find(t => t.id === selectedTournamentId);
  const regsForTourney = registrations.filter(r => r.tournamentId === selectedTournamentId && r.category === currentRmTab);
  const rows = regsForTourney
    .map(r => ({ ...r, contact: rmContacts.find(c => c.id === r.contactId) }))
    .filter(r => r.contact)
    .sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || (a.priorityRank||0) - (b.priorityRank||0));

  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div><div class="page-title">Relationship Management</div><div class="page-desc">Tournament registrations &amp; priority follow-up</div></div>
        ${canEditRM() ? `<button class="btn btn-primary" id="add-tourney-btn">+ New Tournament</button>` : ""}
      </div>
      <div class="court-rule"></div>

      <div class="panel" style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <label style="font-size:12px; color:var(--chalk-faint); text-transform:uppercase;">Tournament</label>
        <select id="tourney-select" style="max-width:280px;">
          ${tournaments.length ? tournaments.map(t => `<option value="${t.id}" ${t.id===selectedTournamentId?"selected":""}>${escapeHtml(t.name)} — ${t.date||"no date"}</option>`).join("") : `<option>No tournaments yet</option>`}
        </select>
        ${tourney ? `<span style="font-size:12px;color:var(--chalk-faint);">${escapeHtml(tourney.location||"")}</span>` : ""}
        ${canEditRM() && tourney ? `<button class="btn btn-ghost btn-sm" id="del-tourney-btn" style="margin-left:auto;">Delete tournament</button>` : ""}
      </div>

      <div class="tabbar">
        ${CATEGORIES.map(c => `<button class="tabbtn ${currentRmTab===c.key?"active":""}" data-tab="${c.key}">${c.label}</button>`).join("")}
      </div>

      ${canEditRM() ? `<button class="btn btn-ghost btn-sm" id="register-btn" style="margin-bottom:14px;">+ Register for tournament</button>` : ""}

      <div class="rm-list">
        ${rows.map((r, idx) => `
          <div class="rm-row ${r.priority ? "priority" : ""}">
            <span class="rank">${idx+1}</span>
            ${canEditPriority() ? `<button class="star-btn ${r.priority?"on":""}" data-reg="${r.id}" data-action="star">★</button>` : (r.priority ? `<span style="color:var(--gold);">★</span>` : "")}
            <span class="rname">${escapeHtml(r.contact.name)}</span>
            <span class="rmeta">${escapeHtml(r.contact.contact||"")}</span>
            <span class="badge ${planTierClass(r.contact.plan)}">${planLabel(r.contact.plan)}</span>
            ${canEditPriority() ? `
              <button class="arrow-btn" data-reg="${r.id}" data-action="up">↑</button>
              <button class="arrow-btn" data-reg="${r.id}" data-action="down">↓</button>
            ` : ""}
            ${canEditRM() ? `<button class="btn btn-ghost btn-sm" data-contact="${r.contact.id}" data-action="edit-contact">Edit</button>` : ""}
            ${canEditRM() ? `<button class="btn btn-ghost btn-sm" data-reg="${r.id}" data-action="unregister">Remove</button>` : ""}
          </div>
        `).join("") || `<div class="empty-state">No ${CATEGORIES.find(c=>c.key===currentRmTab).label.toLowerCase()} registered for this tournament yet</div>`}
      </div>
    </div>
  `;

  document.getElementById("tourney-select")?.addEventListener("change", e => { selectedTournamentId = e.target.value; renderRM(); });
  root.querySelectorAll(".tabbtn").forEach(b => b.addEventListener("click", () => { currentRmTab = b.dataset.tab; renderRM(); }));
  document.getElementById("add-tourney-btn")?.addEventListener("click", openTournamentModal);
  document.getElementById("del-tourney-btn")?.addEventListener("click", async () => {
    if (confirm("Delete this tournament and all its registrations?")) {
      try {
        await safeDelete("tournaments", selectedTournamentId);
        const regs = registrations.filter(r => r.tournamentId === selectedTournamentId);
        for (const r of regs) await safeDelete("registrations", r.id);
        selectedTournamentId = null;
      } catch (err) { /* toasted already */ }
    }
  });
  document.getElementById("register-btn")?.addEventListener("click", () => openRegisterModal());

  root.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        const regId = btn.dataset.reg;
        const action = btn.dataset.action;
        const reg = registrations.find(r => r.id === regId);
        if (action === "star") await safeUpdate("registrations", regId, { priority: !reg.priority });
        if (action === "unregister" && confirm("Remove this registration?")) await safeDelete("registrations", regId);
        if (action === "edit-contact") openEditContactModal(btn.dataset.contact);
        if (action === "up" || action === "down") {
          const list = rows;
          const i = list.findIndex(r => r.id === regId);
          const swapWith = action === "up" ? i - 1 : i + 1;
          if (swapWith >= 0 && swapWith < list.length) {
            const a = list[i], b = list[swapWith];
            await safeUpdate("registrations", a.id, { priorityRank: swapWith });
            await safeUpdate("registrations", b.id, { priorityRank: i });
          }
        }
      } catch (err) { /* already toasted by safe* wrapper */ }
    });
  });
}

function openTournamentModal() {
  showModal(`
    <h3>New Tournament</h3>
    <div class="form-grid">
      <div class="field full"><label>Name</label><input id="t-name" placeholder="e.g. Bengaluru Open U-15"></div>
      <div class="field"><label>Date</label><input id="t-date" type="date"></div>
      <div class="field"><label>Location</label><input id="t-location"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Create</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("t-name").value.trim();
    if (!name) { alert("Name required."); return; }
    try {
      const ref = await safeAdd("tournaments", {
        name, date: document.getElementById("t-date").value, location: document.getElementById("t-location").value.trim(),
        createdAt: serverTimestamp()
      });
      selectedTournamentId = ref.id;
      closeModal();
    } catch (err) { /* toasted already */ }
  });
}

function openRegisterModal() {
  const already = new Set(registrations.filter(r=>r.tournamentId===selectedTournamentId && r.category===currentRmTab).map(r=>r.contactId));
  const pool = rmContacts.filter(c => c.category === currentRmTab && !already.has(c.id));
  showModal(`
    <h3>Register for ${escapeHtml(tournaments.find(t=>t.id===selectedTournamentId)?.name||"")}</h3>
    <div class="mode-toggle">
      <button type="button" class="active" data-mode="existing">Existing contact</button>
      <button type="button" data-mode="new">Add new contact</button>
    </div>

    <div id="mode-existing">
      <div class="field">
        <label>Choose contact</label>
        <button type="button" class="btn btn-ghost picker-btn" id="contact-picker-btn">
          <span id="contact-picker-label">${pool.length ? "Tap to search & select…" : "No available contacts — switch to \"Add new contact\""}</span><span>▾</span>
        </button>
        <input type="hidden" id="reg-contact-id" value="">
        <div class="picker-panel hidden" id="contact-picker-panel">
          <input type="text" id="contact-search" placeholder="Search by name or phone…">
          <div class="picker-results" id="contact-search-results"></div>
        </div>
      </div>
    </div>

    <div id="mode-new" class="hidden">
      <div class="form-grid">
        <div class="field full"><label>Name</label><input id="new-c-name" placeholder="Full name"></div>
        <div class="field full"><label>Phone</label>${renderPhoneFieldHTML("new-c-phone", "")}</div>
        <div class="field full"><label>Email (optional)</label><input id="new-c-email" placeholder="name@example.com"><div class="field-error" id="new-c-email-err"></div></div>
        <div class="field full"><label>Role</label><input id="new-c-role" placeholder="${roleFieldPlaceholder(currentRmTab)}"></div>
        <div class="field full"><label>Plan</label>${renderPlanPickerHTML("new-c-plan-picker", currentRmTab, plansForCategory(currentRmTab)[0]?.key)}</div>
        <div class="field full"><label>Cost (optional)</label><input id="new-c-cost" placeholder="e.g. ₹2,000/month"></div>
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Register</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  wirePlanPicker("new-c-plan-picker");

  // Contact search picker
  const pickerBtn = document.getElementById("contact-picker-btn");
  const pickerPanel = document.getElementById("contact-picker-panel");
  const searchInput = document.getElementById("contact-search");
  const resultsBox = document.getElementById("contact-search-results");
  function renderPickerResults(term) {
    const t = term.trim().toLowerCase();
    const matches = pool.filter(c => !t || c.name.toLowerCase().includes(t) || (c.contact||"").toLowerCase().includes(t));
    resultsBox.innerHTML = matches.map(c => `
      <div class="picker-row" data-id="${c.id}">
        <div><div class="prname">${escapeHtml(c.name)}</div><div class="prmeta">${escapeHtml(c.contact||"no contact info")}</div></div>
        <span class="badge ${planTierClass(c.plan)}">${planLabel(c.plan)}</span>
      </div>
    `).join("") || `<div class="empty-state">No matches</div>`;
    resultsBox.querySelectorAll(".picker-row").forEach(row => {
      row.addEventListener("click", () => {
        const c = pool.find(x => x.id === row.dataset.id);
        document.getElementById("reg-contact-id").value = c.id;
        document.getElementById("contact-picker-label").textContent = c.name;
        pickerPanel.classList.add("hidden");
      });
    });
  }
  if (pool.length) {
    pickerBtn.addEventListener("click", () => {
      pickerPanel.classList.toggle("hidden");
      if (!pickerPanel.classList.contains("hidden")) { renderPickerResults(""); searchInput.focus(); }
    });
    searchInput.addEventListener("input", () => renderPickerResults(searchInput.value));
  } else {
    pickerBtn.disabled = true;
  }

  let mode = "existing";
  document.querySelectorAll(".mode-toggle button").forEach(b => {
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      document.querySelectorAll(".mode-toggle button").forEach(x => x.classList.toggle("active", x === b));
      document.getElementById("mode-existing").classList.toggle("hidden", mode !== "existing");
      document.getElementById("mode-new").classList.toggle("hidden", mode !== "new");
    });
  });

  document.getElementById("m-save").addEventListener("click", async () => {
    try {
      let contactId;
      if (mode === "new") {
        const newName = document.getElementById("new-c-name").value.trim();
        if (!newName) { alert("Enter a name for the new contact."); return; }
        const phone = validatePhoneField("new-c-phone", false);
        const email = validateEmailField("new-c-email", false);
        if (phone === null || email === null) return; // validation error already shown inline
        const ref = await safeAdd("rmContacts", {
          name: newName, category: currentRmTab,
          contact: phone, email,
          role: document.getElementById("new-c-role").value.trim(),
          plan: getSelectedPlan("new-c-plan-picker", plansForCategory(currentRmTab)[0]?.key),
          cost: document.getElementById("new-c-cost").value.trim(),
          createdAt: serverTimestamp()
        });
        contactId = ref.id;
      } else {
        contactId = document.getElementById("reg-contact-id").value;
        if (!contactId) { alert("Choose a contact, or switch to \"Add new contact\"."); return; }
      }
      await safeAdd("registrations", {
        tournamentId: selectedTournamentId, contactId, category: currentRmTab,
        priority: false, priorityRank: 0, registeredAt: serverTimestamp()
      });
      closeModal();
    } catch (err) { /* toasted already */ }
  });
}

function openEditContactModal(contactId) {
  const contact = rmContacts.find(c => c.id === contactId);
  if (!contact) return;
  showModal(`
    <h3>Edit Contact</h3>
    <div class="form-grid">
      <div class="field full"><label>Name</label><input id="ec-name" value="${escapeAttr(contact.name)}"></div>
      <div class="field full"><label>Phone</label>${renderPhoneFieldHTML("ec-phone", contact.contact)}</div>
      <div class="field full"><label>Email (optional)</label><input id="ec-email" value="${escapeAttr(contact.email||"")}" placeholder="name@example.com"><div class="field-error" id="ec-email-err"></div></div>
      <div class="field full"><label>Role</label><input id="ec-role" value="${escapeAttr(contact.role||"")}" placeholder="${roleFieldPlaceholder(contact.category)}"></div>
      <div class="field full"><label>Plan</label>${renderPlanPickerHTML("ec-plan-picker", contact.category, contact.plan || plansForCategory(contact.category)[0]?.key)}</div>
      <div class="field full"><label>Cost (optional)</label><input id="ec-cost" value="${escapeAttr(contact.cost||"")}" placeholder="e.g. ₹2,000/month"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  wirePlanPicker("ec-plan-picker");
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("ec-name").value.trim();
    if (!name) { alert("Name is required."); return; }
    const phone = validatePhoneField("ec-phone", false);
    const email = validateEmailField("ec-email", false);
    if (phone === null || email === null) return;
    try {
      await safeUpdate("rmContacts", contactId, {
        name, contact: phone, email,
        role: document.getElementById("ec-role").value.trim(),
        plan: getSelectedPlan("ec-plan-picker", contact.plan),
        cost: document.getElementById("ec-cost").value.trim()
      });
      closeModal();
    } catch (err) { /* toasted already */ }
  });
}

// ---------------------------------------------------------------
// CLIENTS — every parent/athlete/academy contact, categorized by
// subscription plan (free tier / demo trial / paid). Registering
// someone for a tournament (new-contact mode) also creates them here,
// since both views read the same rmContacts collection.
// ---------------------------------------------------------------
let currentClientsCatFilter = "all";
let currentClientsPlanFilter = "all";

function renderClients() {
  let list = rmContacts.slice();
  if (currentClientsCatFilter !== "all") list = list.filter(c => c.category === currentClientsCatFilter);
  if (currentClientsPlanFilter !== "all") list = list.filter(c => (c.plan || "") === currentClientsPlanFilter);

  // Which plan filter buttons to show depends on which category is selected —
  // parent/athlete and academy use entirely different plan tiers.
  const planOptions = currentClientsCatFilter === "all"
    ? allPlanDefs()
    : plansForCategory(currentClientsCatFilter);

  const countFor = (cat) => rmContacts.filter(c => cat==="all"||c.category===cat).length;

  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div><div class="page-title">Clients</div><div class="page-desc">Every contact across categories, tracked by subscription plan</div></div>
      </div>
      <div class="court-rule"></div>

      <div class="stat-grid">
        <div class="stat-card countup"><div class="stat-label">Parents</div><div class="stat-value">${countFor("parent")}</div></div>
        <div class="stat-card countup"><div class="stat-label">Athletes</div><div class="stat-value">${countFor("athlete")}</div></div>
        <div class="stat-card countup"><div class="stat-label">Academies</div><div class="stat-value">${countFor("academy")}</div></div>
      </div>

      <div class="tabbar">
        <button class="tabbtn ${currentClientsCatFilter==="all"?"active":""}" data-catfilter="all">All</button>
        ${CATEGORIES.map(c => `<button class="tabbtn ${currentClientsCatFilter===c.key?"active":""}" data-catfilter="${c.key}">${c.label}</button>`).join("")}
      </div>
      <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap;">
        <button class="btn btn-sm ${currentClientsPlanFilter==="all"?"btn-primary":"btn-ghost"}" data-planfilter="all">All plans</button>
        ${planOptions.map(p => `<button class="btn btn-sm ${currentClientsPlanFilter===p.key?"btn-primary":"btn-ghost"}" data-planfilter="${p.key}">${p.label}</button>`).join("")}
      </div>

      <div class="rm-list">
        ${list.map(c => `
          <div class="rm-row">
            <span class="rname">${escapeHtml(c.name)}</span>
            <span class="rmeta">${CATEGORIES.find(x=>x.key===c.category)?.label || c.category}</span>
            <span class="rmeta">${escapeHtml(c.contact||"")}</span>
            ${c.role ? `<span class="rmeta">${escapeHtml(c.role)}</span>` : ""}
            ${c.cost ? `<span class="rmeta">${escapeHtml(c.cost)}</span>` : ""}
            <span class="badge ${planTierClass(c.plan)}">${planLabel(c.plan)}</span>
            ${canEditRM() ? `<button class="btn btn-ghost btn-sm" data-contact="${c.id}" data-action="edit-client">Edit</button>` : ""}
          </div>
        `).join("") || `<div class="empty-state">No clients match this filter yet</div>`}
      </div>
    </div>
  `;

  root.querySelectorAll("[data-catfilter]").forEach(b => b.addEventListener("click", () => { currentClientsCatFilter = b.dataset.catfilter; currentClientsPlanFilter = "all"; renderClients(); }));
  root.querySelectorAll("[data-planfilter]").forEach(b => b.addEventListener("click", () => { currentClientsPlanFilter = b.dataset.planfilter; renderClients(); }));
  root.querySelectorAll("[data-action='edit-client']").forEach(b => b.addEventListener("click", () => openEditContactModal(b.dataset.contact)));
}

// ---------------------------------------------------------------
// VIDEO PIPELINE PROGRESS TRACKER (enrolled athletes, per tournament)
// ---------------------------------------------------------------
function renderProgress() {
  // Broadened to every registered category (not just athletes) — any
  // registrant's video pipeline can be tracked here.
  const allRegs = registrations
    .map(r => ({ ...r, contact: rmContacts.find(c => c.id === r.contactId), tourney: tournaments.find(t => t.id === r.tournamentId) }))
    .filter(r => r.contact && r.tourney);

  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div><div class="page-title">Deliverables</div><div class="page-desc">Inferencing → Annotation → Report Generation → Report Sent</div></div>
      </div>
      <div class="court-rule"></div>
      ${!canEditProgress() ? `<div class="access-note">View-only access.</div>` : ""}
      ${allRegs.map(r => {
        const p = progressDocs.find(p => p.contactId === r.contactId && p.tournamentId === r.tournamentId) || {};
        const sources = p.videoSources || [];
        return `
        <div class="progress-card" data-contact="${r.contactId}" data-tourney="${r.tournamentId}">
          <div class="progress-head">
            <span class="pname">${escapeHtml(r.contact.name)}</span>
            <span class="ptourney">${escapeHtml(r.tourney.name)}</span>
            <span class="badge tier-mid">${CATEGORIES.find(c=>c.key===r.category)?.label || r.category}</span>
          </div>
          <div class="video-sources">
            <label>Video Sources</label>
            <div class="source-chips">
              ${sources.map(s => `<span class="source-chip">${escapeHtml(s)}${canEditProgress()?`<button data-remove-source="${escapeAttr(s)}">×</button>`:""}</span>`).join("") || `<span style="font-size:12px; color:var(--chalk-faint);">None added yet</span>`}
            </div>
            ${canEditProgress() ? `
              <div class="source-add">
                <input type="text" class="source-input" placeholder="e.g. mour_vs_aj_set1_far.mp4">
                <button class="btn btn-ghost btn-sm add-source-btn">+ Add</button>
              </div>
            ` : ""}
          </div>
          <div class="steps">
            ${STEP_KEYS.map(s => `
              <div class="step-unit">
                <span class="status-dot ${p[s.key]?"done":""}" data-step="${s.key}" title="Click to toggle"></span>
                <span class="step-label">${s.label}</span>
                ${s.key === "annotation" ? `
                  <select class="annotator-select" data-annotator-for="annotation" ${canEditProgress()?"":"disabled"}>
                    <option value="">Unassigned</option>
                    ${ANNOTATORS.map(a => `<option value="${a}" ${p.annotator===a?"selected":""}>${a}</option>`).join("")}
                  </select>
                ` : ""}
              </div>
            `).join("")}
          </div>
        </div>`;
      }).join("") || `<div class="empty-state">No one registered for tournaments yet</div>`}
    </div>
  `;

  async function upsertProgress(contactId, tournamentId, fields) {
    let existing = progressDocs.find(p => p.contactId === contactId && p.tournamentId === tournamentId);
    if (existing) {
      await safeUpdate("progress", existing.id, { ...fields, updatedAt: serverTimestamp() });
    } else {
      await safeAdd("progress", { contactId, tournamentId, ...fields, updatedAt: serverTimestamp() });
    }
  }

  if (canEditProgress()) {
    root.querySelectorAll(".status-dot").forEach(dot => {
      dot.addEventListener("click", async () => {
        try {
          const rowEl = dot.closest(".progress-card");
          const contactId = rowEl.dataset.contact, tournamentId = rowEl.dataset.tourney;
          const stepKey = dot.dataset.step;
          const existing = progressDocs.find(p => p.contactId === contactId && p.tournamentId === tournamentId);
          const newVal = !(existing && existing[stepKey]);
          await upsertProgress(contactId, tournamentId, { [stepKey]: newVal });
        } catch (err) { /* toasted already */ }
      });
    });
    root.querySelectorAll(".annotator-select").forEach(sel => {
      sel.addEventListener("change", async () => {
        try {
          const rowEl = sel.closest(".progress-card");
          await upsertProgress(rowEl.dataset.contact, rowEl.dataset.tourney, { annotator: sel.value });
        } catch (err) { /* toasted already */ }
      });
    });
    root.querySelectorAll(".add-source-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".progress-card");
        const input = card.querySelector(".source-input");
        const val = input.value.trim();
        if (!val) return;
        try {
          const contactId = card.dataset.contact, tournamentId = card.dataset.tourney;
          const existing = progressDocs.find(p => p.contactId === contactId && p.tournamentId === tournamentId);
          if (existing) {
            await safeUpdate("progress", existing.id, { videoSources: arrayUnion(val), updatedAt: serverTimestamp() });
          } else {
            await safeAdd("progress", { contactId, tournamentId, videoSources: [val], updatedAt: serverTimestamp() });
          }
        } catch (err) { /* toasted already */ }
      });
    });
    root.querySelectorAll("[data-remove-source]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".progress-card");
        try {
          const contactId = card.dataset.contact, tournamentId = card.dataset.tourney;
          const existing = progressDocs.find(p => p.contactId === contactId && p.tournamentId === tournamentId);
          if (existing) await safeUpdate("progress", existing.id, { videoSources: arrayRemove(btn.dataset.removeSource), updatedAt: serverTimestamp() });
        } catch (err) { /* toasted already */ }
      });
    });
  }
}

// ---------------------------------------------------------------
// BACKUP
// ---------------------------------------------------------------
function renderBackup() {
  root.innerHTML = `
    <div class="view">
      <div class="page-header"><div><div class="page-title">Backup</div><div class="page-desc">Export or restore a full snapshot of the database as JSON</div></div></div>
      <div class="court-rule"></div>
      <div class="panel">
        <div class="panel-title">Export</div>
        <p style="color:var(--chalk-dim); font-size:13px; margin-bottom:14px;">Downloads sales leads, relationship contacts, tournaments, registrations, and deliverables progress in one file. Do this at month-end and store it somewhere safe.</p>
        <button class="btn btn-primary" id="export-btn">Download Backup (.json)</button>
      </div>
      <div class="panel">
        <div class="panel-title">Restore from JSON</div>
        <p style="color:var(--chalk-dim); font-size:13px; margin-bottom:14px;">Upload a backup file exported from this app. This <b>adds</b> the records back into the database — it does not delete what's currently there, so you may get duplicates if you restore the same file twice.</p>
        <input type="file" id="import-file" accept="application/json" style="margin-bottom:12px; color:var(--chalk-dim); font-size:13px;">
        <div><button class="btn btn-primary" id="import-btn">Restore from file</button></div>
        <div id="import-status" style="font-size:13px; color:var(--chalk-dim); margin-top:10px;"></div>
      </div>
    </div>
  `;
  document.getElementById("export-btn").addEventListener("click", () => {
    const data = { exportedAt: new Date().toISOString(), salesLeads, rmContacts, tournaments, registrations, progress: progressDocs };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `visisthub-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("import-btn").addEventListener("click", async () => {
    const fileInput = document.getElementById("import-file");
    const status = document.getElementById("import-status");
    const file = fileInput.files[0];
    if (!file) { status.textContent = "Choose a .json file first."; return; }
    status.textContent = "Reading file…";
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!confirm("This will add every record in this file back into the live database. Continue?")) { status.textContent = ""; return; }
      status.textContent = "Restoring…";
      const collectionsMap = {
        salesLeads: data.salesLeads, rmContacts: data.rmContacts, tournaments: data.tournaments,
        registrations: data.registrations, progress: data.progress
      };
      let count = 0;
      for (const [colName, records] of Object.entries(collectionsMap)) {
        if (!Array.isArray(records)) continue;
        for (const rec of records) {
          const { id, ...fields } = rec;
          await safeAdd(colName, fields);
          count++;
        }
      }
      status.textContent = `Restored ${count} records.`;
    } catch (err) {
      status.textContent = "Couldn't restore that file — make sure it's a backup exported from this app.";
      console.error(err);
    }
  });
}

// ---------------------------------------------------------------
// USERS (admin only) — add people and change roles without touching
// the Firebase console.
// ---------------------------------------------------------------
function renderUsers() {
  if (!isSuperAdmin()) {
    root.innerHTML = `<div class="view"><div class="access-note">This section is restricted.</div></div>`;
    return;
  }
  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div><div class="page-title">Users</div><div class="page-desc">Add logins and change what each person can do</div></div>
        <button class="btn btn-primary" id="add-user-btn">+ Add User</button>
      </div>
      <div class="court-rule"></div>
      <div class="access-note">Roles: <b>admin</b> (full access) · <b>sales</b> (Contacts only) · <b>tournament</b> (Relationships, priority, Deliverables) · <b>disabled</b> (blocks sign-in). This panel is only visible to Suresh and Sesha.</div>
      <div class="rm-list">
        ${appUsers.map(u => `
          <div class="rm-row">
            <span class="rname">${escapeHtml(u.name)}${u.id===currentUser.uid?" (you)":""}</span>
            <span class="rmeta">${escapeHtml(u.username)}@visistcrm.app</span>
            ${u.id===currentUser.uid ? `
              <span class="badge free">${roleLabel(u.role)}</span>
            ` : `
            <select class="role-select" data-uid="${u.id}" style="max-width:150px;">
              <option value="admin" ${u.role==="admin"?"selected":""}>Admin</option>
              <option value="sales" ${u.role==="sales"?"selected":""}>Sales</option>
              <option value="tournament" ${u.role==="tournament"?"selected":""}>Tournament Stage</option>
              <option value="disabled" ${u.role==="disabled"?"selected":""}>Disabled</option>
            </select>
            `}
          </div>
        `).join("") || `<div class="empty-state">No users yet — add the first one.</div>`}
      </div>
    </div>
  `;
  document.getElementById("add-user-btn").addEventListener("click", openAddUserModal);
  root.querySelectorAll(".role-select").forEach(sel => {
    sel.addEventListener("change", async () => {
      try { await safeUpdate("users", sel.dataset.uid, { role: sel.value }); }
      catch (err) { /* toasted already */ }
    });
  });
}

function openAddUserModal() {
  showModal(`
    <h3>Add User</h3>
    <div class="form-grid">
      <div class="field full"><label>Full name</label><input id="nu-name" placeholder="e.g. Rohan"></div>
      <div class="field full"><label>Username</label><input id="nu-username" placeholder="e.g. rohan (no spaces)"></div>
      <div class="field full"><label>Password</label><input id="nu-password" type="text" placeholder="Set a starting password"></div>
      <div class="field full"><label>Role</label>
        <select id="nu-role">
          <option value="admin">Admin (full access)</option>
          <option value="sales">Sales (Sales Pipeline only)</option>
          <option value="tournament" selected>Tournament Stage</option>
        </select>
      </div>
    </div>
    <div id="nu-error" style="color:var(--coral); font-size:13px; margin-top:8px; min-height:16px;"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Create Login</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("nu-name").value.trim();
    const username = document.getElementById("nu-username").value.trim().toLowerCase();
    const password = document.getElementById("nu-password").value;
    const role = document.getElementById("nu-role").value;
    const errBox = document.getElementById("nu-error");
    if (!name || !username || !password) { errBox.textContent = "All fields are required."; return; }
    if (password.length < 6) { errBox.textContent = "Password must be at least 6 characters (Firebase minimum)."; return; }
    if (/\s/.test(username)) { errBox.textContent = "Username can't contain spaces."; return; }

    document.getElementById("m-save").textContent = "Creating…";
    // Create the auth account on a throwaway secondary Firebase app instance so it
    // doesn't sign the admin out of their own session.
    const secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now());
    const secondaryAuth = getAuth(secondaryApp);
    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, usernameToEmail(username), password);
      await safeSet("users", cred.user.uid, { name, username, role, createdAt: serverTimestamp() });
      await signOut(secondaryAuth);
      closeModal();
    } catch (err) {
      errBox.textContent = err.code === "auth/email-already-in-use"
        ? "That username is already taken."
        : "Couldn't create the login: " + err.message;
      document.getElementById("m-save").textContent = "Create Login";
    } finally {
      await deleteApp(secondaryApp);
    }
  });
}

// ---------------------------------------------------------------
// MODAL HELPERS
// ---------------------------------------------------------------
function showModal(innerHtml) {
  closeModal();
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.id = "active-modal-bg";
  bg.innerHTML = `<div class="modal">${innerHtml}</div>`;
  bg.addEventListener("click", e => { if (e.target === bg) closeModal(); });
  document.body.appendChild(bg);
}
function closeModal() {
  document.getElementById("active-modal-bg")?.remove();
}

// ---------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
}
function escapeAttr(str) { return escapeHtml(str); }