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
const STAGES = [
  { key: "prospects",     label: "Prospects",     action: "First Call" },
  { key: "interest",      label: "Interest",      action: "Follow-up / Email" },
  { key: "consideration", label: "Consideration", action: "Demo Stage" },
  { key: "intent",        label: "Intent",        action: "Pricing Questions" },
  { key: "evaluation",    label: "Evaluation",    action: "Negotiation" },
  { key: "action",        label: "Action",        action: "Issue a PO / Sign on Contract" },
  { key: "retention",     label: "Retention",     action: "Ensuring product works / Feedback" }
];
const STAGE_KEYS = STAGES.map(s => s.key);
function stageLabel(key) { return STAGES.find(s => s.key === key)?.label || key; }
// A lead is considered "won" (and gets a Clients record) once it reaches Action or Retention.
const WON_STAGES = ["action", "retention"];

const CATEGORIES = [
  { key: "parent", label: "Parents" },
  { key: "athlete", label: "Athletes" },
  { key: "academy", label: "Academies / Coaches" }
];
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
const SUPER_ADMIN_USERNAMES = ["suresh", "sesha", "mourya"];

let appUsers = [];

let currentUser = null;   // { uid, name, role, username }
let currentView = "dashboard";
let currentSalesTab = "parent";
let showLostLeads = false;
let currentRmTab = "parent";
let selectedTournamentId = null;

let salesLeads = [];
let rmContacts = [];
let tournaments = [];
let registrations = [];
let tasks = [];

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
  const backupNav = document.querySelector('.nav-item[data-view="backup"]');
  const usersNav = document.querySelector('.nav-item[data-view="users"]');
  // Everyone can view Dashboard and Tasks. Adjust the rest based on role.
  if (currentUser.role === "sales") {
    rmNav.style.display = "none";
    clientsNav.style.display = "none";
    backupNav.style.display = "none";
  } else if (currentUser.role === "tournament") {
    salesNav.style.display = "none";
    backupNav.style.display = "none";
  } else {
    // admin sees everything
    salesNav.style.display = "";
    rmNav.style.display = "";
    clientsNav.style.display = "";
    backupNav.style.display = "";
  }
  // Users tab: only Suresh/Sesha/Mourya specifically, regardless of anyone else's admin role.
  usersNav.style.display = isSuperAdmin() ? "" : "none";
}

function canEditSales() { return currentUser.role === "admin" || currentUser.role === "sales"; }
function canEditRM() { return currentUser.role === "admin"; }
function canEditPriority() { return currentUser.role === "admin" || currentUser.role === "tournament"; }
function canManageTasks() { return currentUser.role === "admin"; }
function canUpdateTask(task) { return currentUser.role === "admin" || task.assignedTo === currentUser.username; }

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
    if (currentView === "rm") render();
  }));
  unsubs.push(onSnapshot(collection(db, "registrations"), snap => {
    registrations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentView === "rm") render();
  }));
  unsubs.push(onSnapshot(query(collection(db, "tasks"), orderBy("createdAt", "desc")), snap => {
    tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentView === "tasks" || currentView === "dashboard") render();
  }));
  // Everyone can read the users list (needed to populate the Task-assignee dropdown),
  // even though only super-admins can edit it (see the Users tab itself).
  unsubs.push(onSnapshot(collection(db, "users"), snap => {
    appUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentView === "users" || currentView === "tasks") render();
  }));
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
  if (currentView === "tasks") return renderTasks();
  if (currentView === "backup") return renderBackup();
  if (currentView === "users") return renderUsers();
}

// ---------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------
function renderDashboard() {
  const countByCat = (list, cat) => list.filter(x => x.category === cat).length;
  // "Onboarded" now reflects the Clients list directly — this includes both
  // people enrolled through the Sales pipeline AND anyone added straight into
  // Clients (e.g. via tournament registration), which is the real source of
  // truth for "who is currently on board." Exhausted-plan clients aren't
  // counted as currently onboarded.
  const enrolledByCat = cat => rmContacts.filter(x => x.category === cat && x.planStatus !== "exhausted").length;

  const totalLeads = salesLeads.length;
  const won = salesLeads.filter(l => WON_STAGES.includes(l.stage) && !l.lost).length;
  const lost = salesLeads.filter(l => l.lost).length;
  const closedOut = won + lost;
  const successRate = closedOut > 0 ? Math.round((won / closedOut) * 100) : 0;
  const activeLeads = salesLeads.filter(l => !l.lost && !WON_STAGES.includes(l.stage)).length;

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
        <div class="stat-card countup"><div class="stat-label">Parents Onboarded</div><div class="stat-value">${enrolledByCat("parent")}</div><div class="stat-sub">active clients</div></div>
        <div class="stat-card countup"><div class="stat-label">Athletes Onboarded</div><div class="stat-value">${enrolledByCat("athlete")}</div><div class="stat-sub">active clients</div></div>
        <div class="stat-card countup"><div class="stat-label">Academies Onboarded</div><div class="stat-value">${enrolledByCat("academy")}</div><div class="stat-sub">active clients</div></div>
      </div>

      <div class="panel">
        <div class="panel-title">Sales Success Rate</div>
        <div class="stat-grid" style="margin-bottom:0;">
          <div class="stat-card good countup"><div class="stat-label">Success Rate</div><div class="stat-value">${successRate}%</div><div class="stat-sub">won ÷ (won + lost)</div></div>
          <div class="stat-card accent countup"><div class="stat-label">Total Leads</div><div class="stat-value">${totalLeads}</div><div class="stat-sub">across all categories</div></div>
          <div class="stat-card countup"><div class="stat-label">Active in Funnel</div><div class="stat-value">${activeLeads}</div><div class="stat-sub">still in progress</div></div>
          <div class="stat-card bad countup"><div class="stat-label">Lost</div><div class="stat-value">${lost}</div><div class="stat-sub">did not convert</div></div>
        </div>
      </div>

      <div class="chart-row">
        <div class="panel chart-box">
          <div class="panel-title">Funnel by Category</div>
          <canvas id="chart-funnel"></canvas>
        </div>
        <div class="panel chart-box">
          <div class="panel-title">Won vs Lost</div>
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
                ${STAGES.map(s => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;color:var(--chalk-dim);">
                  <span>${s.label}</span><span class="badge stage-${s.key}">${salesLeads.filter(l=>l.category===c.key && l.stage===s.key && !l.lost).length}</span>
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

  const stageColors = ["#5B8CFF", "#7ED321", "#F5A623", "#A855F7", "#FF9F5B", "#3ECF8E", "#2E5B3F"];

  funnelChartInstance = new Chart(funnelCtx, {
    type: "bar",
    data: {
      labels: CATEGORIES.map(c => c.label),
      datasets: STAGES.map((stage, i) => ({
        label: stage.label,
        data: CATEGORIES.map(c => salesLeads.filter(l => l.category === c.key && l.stage === stage.key && !l.lost).length),
        backgroundColor: stageColors[i],
        borderRadius: 4
      }))
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: textColor, font: { size: 10 } } } },
      scales: {
        x: { stacked: true, ticks: { color: textColor }, grid: { display: false } },
        y: { stacked: true, ticks: { color: textColor, stepSize: 1 }, grid: { color: gridColor } }
      }
    }
  });

  const wonCount = salesLeads.filter(l => WON_STAGES.includes(l.stage) && !l.lost).length;
  const lostCount = salesLeads.filter(l => l.lost).length;
  outcomeChartInstance = new Chart(outcomeCtx, {
    type: "doughnut",
    data: {
      labels: ["Won", "Lost", "Still in progress"],
      datasets: [{
        data: [wonCount, lostCount, salesLeads.length - wonCount - lostCount],
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
        <div><div class="page-title">Funnel</div><div class="page-desc">7-stage sales pipeline, from first contact to retention</div></div>
        ${canEditSales() ? `<button class="btn btn-primary" id="add-lead-btn">+ Add Contact</button>` : ""}
      </div>
      <div class="court-rule"></div>
      ${!canEditSales() ? `<div class="access-note">View-only access.</div>` : ""}
      <div class="tabbar">
        ${CATEGORIES.map(c => `<button class="tabbtn ${currentSalesTab===c.key?"active":""}" data-tab="${c.key}">${c.label}</button>`).join("")}
        <button class="tabbtn ${showLostLeads?"active":""}" id="toggle-lost-btn" style="margin-left:auto; color:var(--coral);">Lost (${list.filter(l=>l.lost).length})</button>
      </div>
      <div class="funnel-grid" style="grid-template-columns:repeat(7,minmax(170px,1fr)); overflow-x:auto;">
        ${showLostLeads ? `
          <div class="funnel-col" style="grid-column:1/-1;">
            <div class="funnel-col-head"><span class="label" style="color:var(--coral);">Lost</span><span class="count">${list.filter(l=>l.lost).length}</span></div>
            <div class="funnel-list" style="max-height:none; flex-direction:row; flex-wrap:wrap;">
              ${list.filter(l=>l.lost).map(l => `
                <div class="lead-card" data-id="${l.id}" style="width:220px;">
                  <div class="lname">${escapeHtml(l.name)}</div>
                  <div class="lmeta">${escapeHtml(l.contact||"")}${l.assignedTo ? " · "+escapeHtml(l.assignedTo) : ""}</div>
                </div>
              `).join("") || `<div class="empty-state">No lost leads in this category</div>`}
            </div>
          </div>
        ` : STAGES.map(stage => `
          <div class="funnel-col" data-stage="${stage.key}">
            <div class="funnel-col-head">
              <div>
                <span class="label">${stage.label}</span>
                <div style="font-size:10px; color:var(--chalk-faint); margin-top:2px;">${stage.action}</div>
              </div>
              <span class="count">${list.filter(l=>l.stage===stage.key && !l.lost).length}</span>
            </div>
            <div class="funnel-list">
              ${list.filter(l=>l.stage===stage.key && !l.lost).map(l => `
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
  root.querySelectorAll(".tabbtn[data-tab]").forEach(b => b.addEventListener("click", () => { currentSalesTab = b.dataset.tab; renderSales(); }));
  document.getElementById("toggle-lost-btn").addEventListener("click", () => { showLostLeads = !showLostLeads; renderSales(); });
  root.querySelectorAll(".lead-card").forEach(c => c.addEventListener("click", () => openLeadModal(c.dataset.id)));
  const addBtn = document.getElementById("add-lead-btn");
  if (addBtn) addBtn.addEventListener("click", () => openLeadModal(null));
}

function openLeadModal(id) {
  const lead = id ? salesLeads.find(l => l.id === id) : null;
  const editable = canEditSales();
  const category = lead?.category || currentSalesTab;
  showModal(`
    <h3>${lead ? "Edit Contact" : "Add Contact"}</h3>
    <div class="form-grid">
      <div class="field full"><label>Name</label><input id="m-name" value="${lead?escapeAttr(lead.name):""}" ${editable?"":"disabled"}></div>
      <div class="field"><label>Category</label>
        <select id="m-category" ${editable?"":"disabled"}>${CATEGORIES.map(c=>`<option value="${c.key}" ${category===c.key?"selected":""}>${c.label}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Stage</label>
        <select id="m-stage" ${editable?"":"disabled"}>${STAGES.map(s=>`<option value="${s.key}" ${lead?.stage===s.key||(!lead&&s.key==="prospects")?"selected":""}>${s.label} — ${s.action}</option>`).join("")}</select>
      </div>
      <div class="field full"><label>Phone</label>${renderPhoneFieldHTML("m-phone", lead?.contact)}</div>
      <div class="field full"><label>Email (optional)</label><input id="m-email" value="${lead?escapeAttr(lead.email||""):""}" placeholder="name@example.com" ${editable?"":"disabled"}><div class="field-error" id="m-email-err"></div></div>
      <div class="field full"><label>Website (optional${category==="academy"?", for academies":""})</label><input id="m-website" value="${lead?escapeAttr(lead.website||""):""}" placeholder="https://example.com" ${editable?"":"disabled"}></div>
      <div class="field full"><label>Source</label><input id="m-source" value="${lead?escapeAttr(lead.source||""):""}" placeholder="Referral, inbound, cold, etc." ${editable?"":"disabled"}></div>
      <div class="field full"><label>Assigned To</label><input id="m-assigned" value="${lead?escapeAttr(lead.assignedTo||""):""}" ${editable?"":"disabled"}></div>
      <div class="field full"><label>Notes</label><textarea id="m-notes" ${editable?"":"disabled"}>${lead?escapeHtml(lead.notes||""):""}</textarea></div>
    </div>
    ${editable ? `<label style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--chalk-dim); margin-top:4px;">
      <input type="checkbox" id="m-lost" ${lead?.lost?"checked":""}> Mark as lost (didn't convert)
    </label>` : (lead?.lost ? `<div class="access-note" style="color:var(--coral);">This lead is marked lost.</div>` : "")}
    <div class="modal-actions">
      ${lead && editable ? `<button class="btn btn-danger" id="m-delete">Delete</button>` : ""}
      <button class="btn btn-ghost" id="m-cancel">Close</button>
      ${editable ? `<button class="btn btn-primary" id="m-save">Save</button>` : ""}
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  if (editable) {
    document.getElementById("m-save").addEventListener("click", async () => {
      const name = document.getElementById("m-name").value.trim();
      if (!name) { alert("Name is required."); return; }
      const phone = validatePhoneField("m-phone", false);
      const email = validateEmailField("m-email", false);
      if (phone === null || email === null) return;
      const payload = {
        name,
        category: document.getElementById("m-category").value,
        stage: document.getElementById("m-stage").value,
        contact: phone, email,
        website: document.getElementById("m-website").value.trim(),
        source: document.getElementById("m-source").value.trim(),
        assignedTo: document.getElementById("m-assigned").value.trim(),
        notes: document.getElementById("m-notes").value.trim(),
        lost: document.getElementById("m-lost").checked,
        updatedAt: serverTimestamp()
      };
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
        if (WON_STAGES.includes(payload.stage) && !payload.lost) {
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
        await safeUpdate("rmContacts", existingContactId, { plan, cost, category, name: payload.name, contact: payload.contact || existingContact.contact || "", email: payload.email || existingContact.email || "" });
      } else {
        const ref = await safeAdd("rmContacts", {
          name: payload.name, category, contact: payload.contact || "", email: payload.email || "", plan, cost,
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
        <div class="field full"><label>Website (optional${currentRmTab==="academy"?", for academies":""})</label><input id="new-c-website" placeholder="https://example.com"></div>
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
          website: document.getElementById("new-c-website").value.trim(),
          plan: getSelectedPlan("new-c-plan-picker", plansForCategory(currentRmTab)[0]?.key),
          cost: document.getElementById("new-c-cost").value.trim(),
          sourceTournamentId: selectedTournamentId,
          sourceTournamentName: tournaments.find(t=>t.id===selectedTournamentId)?.name || "",
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
      <div class="field full"><label>Category</label>
        <select id="ec-category">${CATEGORIES.map(c=>`<option value="${c.key}" ${contact.category===c.key?"selected":""}>${c.label}</option>`).join("")}</select>
      </div>
      <div class="field full"><label>Phone</label>${renderPhoneFieldHTML("ec-phone", contact.contact)}</div>
      <div class="field full"><label>Email (optional)</label><input id="ec-email" value="${escapeAttr(contact.email||"")}" placeholder="name@example.com"><div class="field-error" id="ec-email-err"></div></div>
      <div class="field full"><label>Role</label><input id="ec-role" value="${escapeAttr(contact.role||"")}" placeholder="${roleFieldPlaceholder(contact.category)}"></div>
      <div class="field full"><label>Website (optional${contact.category==="academy"?", for academies":""})</label><input id="ec-website" value="${escapeAttr(contact.website||"")}" placeholder="https://example.com"></div>
      <div class="field full" id="ec-plan-field"><label>Plan</label>${renderPlanPickerHTML("ec-plan-picker", contact.category, contact.plan || plansForCategory(contact.category)[0]?.key)}</div>
      <div class="field full"><label>Cost (optional)</label><input id="ec-cost" value="${escapeAttr(contact.cost||"")}" placeholder="e.g. ₹2,000/month"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  wirePlanPicker("ec-plan-picker");
  document.getElementById("ec-category").addEventListener("change", (e) => {
    // Plan tiers differ by category (parent/athlete vs academy), so refresh the picker.
    document.getElementById("ec-plan-field").innerHTML = `<label>Plan</label>${renderPlanPickerHTML("ec-plan-picker", e.target.value, plansForCategory(e.target.value)[0]?.key)}`;
    wirePlanPicker("ec-plan-picker");
  });
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("ec-name").value.trim();
    if (!name) { alert("Name is required."); return; }
    const category = document.getElementById("ec-category").value;
    const phone = validatePhoneField("ec-phone", false);
    const email = validateEmailField("ec-email", false);
    if (phone === null || email === null) return;
    try {
      await safeUpdate("rmContacts", contactId, {
        name, category, contact: phone, email,
        role: document.getElementById("ec-role").value.trim(),
        website: document.getElementById("ec-website").value.trim(),
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
let currentClientsStatusFilter = "active"; // "active" | "exhausted"
let currentClientsSourceFilter = "all"; // "all" | "tournament"

function renderClients() {
  let list = rmContacts.filter(c => currentClientsStatusFilter === "exhausted" ? c.planStatus === "exhausted" : c.planStatus !== "exhausted");
  if (currentClientsCatFilter !== "all") list = list.filter(c => c.category === currentClientsCatFilter);
  if (currentClientsPlanFilter !== "all") list = list.filter(c => (c.plan || "") === currentClientsPlanFilter);
  if (currentClientsSourceFilter === "tournament") list = list.filter(c => c.sourceTournamentId);

  // Which plan filter buttons to show depends on which category is selected —
  // parent/athlete and academy use entirely different plan tiers.
  const planOptions = currentClientsCatFilter === "all"
    ? allPlanDefs()
    : plansForCategory(currentClientsCatFilter);

  const activeOnly = c => c.planStatus !== "exhausted";
  const countFor = (cat) => rmContacts.filter(c => (cat==="all"||c.category===cat) && activeOnly(c)).length;
  const exhaustedCount = rmContacts.filter(c => c.planStatus === "exhausted").length;
  const tournamentSourcedCount = rmContacts.filter(c => c.sourceTournamentId && activeOnly(c)).length;

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
        <div class="stat-card accent countup"><div class="stat-label">From Tournaments</div><div class="stat-value">${tournamentSourcedCount}</div></div>
        <div class="stat-card bad countup"><div class="stat-label">Exhausted Plans</div><div class="stat-value">${exhaustedCount}</div></div>
      </div>

      <div class="mode-toggle" style="max-width:340px;">
        <button type="button" class="${currentClientsStatusFilter==="active"?"active":""}" data-statusfilter="active">Active clients</button>
        <button type="button" class="${currentClientsStatusFilter==="exhausted"?"active":""}" data-statusfilter="exhausted">Exhausted plans (${exhaustedCount})</button>
      </div>

      <div class="tabbar">
        <button class="tabbtn ${currentClientsCatFilter==="all"?"active":""}" data-catfilter="all">All</button>
        ${CATEGORIES.map(c => `<button class="tabbtn ${currentClientsCatFilter===c.key?"active":""}" data-catfilter="${c.key}">${c.label}</button>`).join("")}
        <button class="tabbtn ${currentClientsSourceFilter==="tournament"?"active":""}" id="toggle-tournament-source" style="margin-left:auto;">From tournaments only</button>
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
            ${c.website ? `<a href="${escapeAttr(c.website)}" target="_blank" rel="noopener" class="rmeta" style="color:var(--blue);">${escapeHtml(c.website.replace(/^https?:\/\//,''))}</a>` : ""}
            ${c.cost ? `<span class="rmeta">${escapeHtml(c.cost)}</span>` : ""}
            ${c.sourceTournamentName ? `<span class="badge tier-mid" title="Acquired via this tournament">🏆 ${escapeHtml(c.sourceTournamentName)}</span>` : ""}
            <span class="badge ${planTierClass(c.plan)}">${planLabel(c.plan)}</span>
            ${canEditRM() ? `<button class="btn btn-ghost btn-sm" data-contact="${c.id}" data-action="edit-client">Edit</button>` : ""}
            ${canEditRM() ? (currentClientsStatusFilter === "active"
                ? `<button class="btn btn-ghost btn-sm" data-contact="${c.id}" data-action="mark-exhausted">Mark exhausted</button>`
                : `<button class="btn btn-ghost btn-sm" data-contact="${c.id}" data-action="reactivate">Reactivate</button>`) : ""}
            ${canEditRM() ? `<button class="btn btn-ghost btn-sm" data-contact="${c.id}" data-action="delete-client">Delete</button>` : ""}
          </div>
        `).join("") || `<div class="empty-state">No clients match this filter yet</div>`}
      </div>
    </div>
  `;

  root.querySelectorAll("[data-statusfilter]").forEach(b => b.addEventListener("click", () => { currentClientsStatusFilter = b.dataset.statusfilter; renderClients(); }));
  root.querySelectorAll("[data-catfilter]").forEach(b => b.addEventListener("click", () => { currentClientsCatFilter = b.dataset.catfilter; currentClientsPlanFilter = "all"; renderClients(); }));
  root.querySelectorAll("[data-planfilter]").forEach(b => b.addEventListener("click", () => { currentClientsPlanFilter = b.dataset.planfilter; renderClients(); }));
  document.getElementById("toggle-tournament-source").addEventListener("click", () => { currentClientsSourceFilter = currentClientsSourceFilter === "tournament" ? "all" : "tournament"; renderClients(); });
  root.querySelectorAll("[data-action='edit-client']").forEach(b => b.addEventListener("click", () => openEditContactModal(b.dataset.contact)));
  root.querySelectorAll("[data-action='mark-exhausted']").forEach(b => b.addEventListener("click", async () => {
    try { await safeUpdate("rmContacts", b.dataset.contact, { planStatus: "exhausted" }); } catch (err) {}
  }));
  root.querySelectorAll("[data-action='reactivate']").forEach(b => b.addEventListener("click", async () => {
    try { await safeUpdate("rmContacts", b.dataset.contact, { planStatus: "active" }); } catch (err) {}
  }));
  root.querySelectorAll("[data-action='delete-client']").forEach(b => b.addEventListener("click", async () => {
    const c = rmContacts.find(x => x.id === b.dataset.contact);
    if (confirm(`Permanently delete ${c?.name || "this client"}? This cannot be undone.`)) {
      try { await safeDelete("rmContacts", b.dataset.contact); } catch (err) {}
    }
  }));
}

// ---------------------------------------------------------------
// TASKS — list tasks and assign them to a team member. Everyone can
// see the board; only admins create/delete/reassign; the assignee
// (or an admin) can move a task's status.
// ---------------------------------------------------------------
const TASK_STATUSES = [
  { key: "todo", label: "To Do" },
  { key: "in-progress", label: "In Progress" },
  { key: "done", label: "Done" }
];

function renderTasks() {
  const byStatus = key => tasks.filter(t => t.status === key);

  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div><div class="page-title">Tasks</div><div class="page-desc">Assign work to the team and track progress</div></div>
        ${canManageTasks() ? `<button class="btn btn-primary" id="add-task-btn">+ New Task</button>` : ""}
      </div>
      <div class="court-rule"></div>
      <div class="funnel-grid" style="grid-template-columns:repeat(3,1fr);">
        ${TASK_STATUSES.map(st => `
          <div class="funnel-col">
            <div class="funnel-col-head"><span class="label">${st.label}</span><span class="count">${byStatus(st.key).length}</span></div>
            <div class="funnel-list" style="max-height:560px;">
              ${byStatus(st.key).map(t => `
                <div class="lead-card" data-id="${t.id}">
                  <div class="lname">${escapeHtml(t.title)}</div>
                  <div class="lmeta">${t.assignedTo ? "Assigned to " + escapeHtml(t.assignedTo) : "Unassigned"}</div>
                </div>
              `).join("") || `<div class="empty-state">Nothing here</div>`}
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
  document.getElementById("add-task-btn")?.addEventListener("click", () => openTaskModal(null));
  root.querySelectorAll(".lead-card").forEach(c => c.addEventListener("click", () => openTaskModal(c.dataset.id)));
}

function openTaskModal(id) {
  const task = id ? tasks.find(t => t.id === id) : null;
  const canManage = canManageTasks();
  const canUpdate = task ? canUpdateTask(task) : canManage;
  const assigneeOptions = appUsers.map(u => u.username).filter(Boolean);
  showModal(`
    <h3>${task ? "Edit Task" : "New Task"}</h3>
    <div class="form-grid">
      <div class="field full"><label>Title</label><input id="t-title" value="${task?escapeAttr(task.title):""}" ${canManage?"":"disabled"}></div>
      <div class="field full"><label>Notes (optional)</label><textarea id="t-notes" ${canManage?"":"disabled"}>${task?escapeHtml(task.notes||""):""}</textarea></div>
      <div class="field"><label>Assign to</label>
        <select id="t-assignee" ${canManage?"":"disabled"}>
          <option value="">Unassigned</option>
          ${assigneeOptions.map(u => `<option value="${u}" ${task?.assignedTo===u?"selected":""}>${u}</option>`).join("")}
        </select>
      </div>
      <div class="field"><label>Status</label>
        <select id="t-status" ${canUpdate?"":"disabled"}>
          ${TASK_STATUSES.map(s => `<option value="${s.key}" ${(task?.status||"todo")===s.key?"selected":""}>${s.label}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="modal-actions">
      ${task && canManage ? `<button class="btn btn-danger" id="m-delete">Delete</button>` : ""}
      <button class="btn btn-ghost" id="m-cancel">Close</button>
      ${canManage || canUpdate ? `<button class="btn btn-primary" id="m-save">Save</button>` : ""}
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  if (task && canManage) {
    document.getElementById("m-delete").addEventListener("click", async () => {
      if (confirm("Delete this task?")) { try { await safeDelete("tasks", task.id); closeModal(); } catch (err) {} }
    });
  }
  if (canManage || canUpdate) {
    document.getElementById("m-save").addEventListener("click", async () => {
      try {
        if (canManage) {
          const title = document.getElementById("t-title").value.trim();
          if (!title) { alert("Title is required."); return; }
          const payload = {
            title,
            notes: document.getElementById("t-notes").value.trim(),
            assignedTo: document.getElementById("t-assignee").value,
            status: document.getElementById("t-status").value
          };
          if (task) await safeUpdate("tasks", task.id, payload);
          else await safeAdd("tasks", { ...payload, createdAt: serverTimestamp() });
        } else {
          // Non-admin assignee can only move their own task's status.
          await safeUpdate("tasks", task.id, { status: document.getElementById("t-status").value });
        }
        closeModal();
      } catch (err) { /* toasted already */ }
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
        <p style="color:var(--chalk-dim); font-size:13px; margin-bottom:14px;">Downloads sales leads, relationship contacts, tournaments, registrations, and tasks in one file. Do this at month-end and store it somewhere safe.</p>
        <button class="btn btn-primary" id="export-btn">Download Backup (.json)</button>
      </div>
      <div class="panel">
        <div class="panel-title">Restore from JSON</div>
        <p style="color:var(--chalk-dim); font-size:13px; margin-bottom:14px;">Upload a backup file exported from this app. This <b>adds</b> the records back into the database — it does not delete what's currently there, so you may get duplicates if you restore the same file twice.</p>
        <input type="file" id="import-file" accept="application/json" style="margin-bottom:12px; color:var(--chalk-dim); font-size:13px;">
        <div><button class="btn btn-primary" id="import-btn">Restore from file</button></div>
        <div id="import-status" style="font-size:13px; color:var(--chalk-dim); margin-top:10px;"></div>
      </div>
      <div class="panel" style="border-color: var(--coral);">
        <div class="panel-title" style="color: var(--coral);">Danger Zone — Erase Test Data</div>
        <p style="color:var(--chalk-dim); font-size:13px; margin-bottom:14px;">
          For individual test records: go to Contacts or Clients and use each row's own <b>Delete</b> button.<br><br>
          To wipe <b>everything</b> at once (all sales contacts, clients, tournaments, registrations, and tasks — a full reset), type <b>DELETE</b> below. This cannot be undone, and there's no way to recover it afterward except restoring an earlier backup file.
        </p>
        <div class="form-grid" style="margin-bottom:12px;">
          <input type="text" id="wipe-confirm-input" class="full" placeholder="Type DELETE to enable" style="grid-column:1/-1; padding:10px 12px; background:var(--surface-2); border:1px solid var(--line); border-radius:8px; color:var(--chalk);">
        </div>
        <button class="btn btn-danger" id="wipe-all-btn" disabled>Erase All Data</button>
        <div id="wipe-status" style="font-size:13px; color:var(--chalk-dim); margin-top:10px;"></div>
      </div>
    </div>
  `;
  document.getElementById("export-btn").addEventListener("click", () => {
    const data = { exportedAt: new Date().toISOString(), salesLeads, rmContacts, tournaments, registrations, tasks };
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
        registrations: data.registrations, tasks: data.tasks
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

  document.getElementById("wipe-confirm-input").addEventListener("input", (e) => {
    document.getElementById("wipe-all-btn").disabled = e.target.value.trim() !== "DELETE";
  });
  document.getElementById("wipe-all-btn").addEventListener("click", async () => {
    if (!confirm("This will permanently delete every sales contact, client, tournament, registration, and task. Are you absolutely sure?")) return;
    const status = document.getElementById("wipe-status");
    status.textContent = "Erasing…";
    try {
      let count = 0;
      for (const [colName, list] of Object.entries({ salesLeads, rmContacts, tournaments, registrations, tasks })) {
        for (const rec of list) { await safeDelete(colName, rec.id); count++; }
      }
      status.textContent = `Done — erased ${count} records.`;
    } catch (err) {
      status.textContent = "Something went wrong partway through — check the toast messages above.";
    }
  });
}
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
      <div class="access-note">Roles: <b>admin</b> (full access) · <b>sales</b> (Funnel only) · <b>tournament</b> (Relationships, priority) · <b>disabled</b> (blocks sign-in). This panel is only visible to Suresh, Sesha, and Mourya.</div>
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