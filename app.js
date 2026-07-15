import { firebaseConfig, app, usernameToEmail } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot,
  getDoc, setDoc, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const auth = getAuth(app);
const db = getFirestore(app);

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

function applyRoleVisibility() {
  const salesNav = document.querySelector('.nav-item[data-view="sales"]');
  const rmNav = document.querySelector('.nav-item[data-view="rm"]');
  const progressNav = document.querySelector('.nav-item[data-view="progress"]');
  const backupNav = document.querySelector('.nav-item[data-view="backup"]');
  const usersNav = document.querySelector('.nav-item[data-view="users"]');
  // Everyone can view Dashboard. Adjust nav based on role.
  if (currentUser.role === "sales") {
    rmNav.style.display = "none";
    progressNav.style.display = "none";
    backupNav.style.display = "none";
    usersNav.style.display = "none";
  } else if (currentUser.role === "tournament") {
    salesNav.style.display = "none";
    backupNav.style.display = "none";
    usersNav.style.display = "none";
  } else {
    // admin sees everything
    salesNav.style.display = "";
    rmNav.style.display = "";
    progressNav.style.display = "";
    backupNav.style.display = "";
    usersNav.style.display = "";
  }
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
    if (currentView === "dashboard" || currentView === "rm") render();
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
  if (currentUser.role === "admin") {
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
}

// ---------------------------------------------------------------
// SALES PIPELINE
// ---------------------------------------------------------------
function renderSales() {
  const list = salesLeads.filter(l => l.category === currentSalesTab);
  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div><div class="page-title">Sales Pipeline</div><div class="page-desc">Track outreach through to enrollment</div></div>
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
      if (lead) {
        await updateDoc(doc(db, "salesLeads", lead.id), payload);
      } else {
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, "salesLeads"), payload);
      }
      closeModal();
    });
    if (lead) {
      document.getElementById("m-delete").addEventListener("click", async () => {
        if (confirm("Delete this contact permanently?")) {
          await deleteDoc(doc(db, "salesLeads", lead.id));
          closeModal();
        }
      });
    }
  }
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

      ${canEditRM() ? `<button class="btn btn-ghost btn-sm" id="register-btn" style="margin-bottom:14px;">+ Register existing contact</button>` : ""}

      <div class="rm-list">
        ${rows.map((r, idx) => `
          <div class="rm-row ${r.priority ? "priority" : ""}">
            <span class="rank">${idx+1}</span>
            ${canEditPriority() ? `<button class="star-btn ${r.priority?"on":""}" data-reg="${r.id}" data-action="star">★</button>` : (r.priority ? `<span style="color:var(--gold);">★</span>` : "")}
            <span class="rname">${escapeHtml(r.contact.name)}</span>
            <span class="rmeta">${escapeHtml(r.contact.contact||"")}</span>
            <span class="badge ${r.contact.tier==="paid"?"paid":"free"}">${r.contact.tier==="paid"?"Paid":"Free"}</span>
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
      await deleteDoc(doc(db, "tournaments", selectedTournamentId));
      const regs = registrations.filter(r => r.tournamentId === selectedTournamentId);
      for (const r of regs) await deleteDoc(doc(db, "registrations", r.id));
      selectedTournamentId = null;
    }
  });
  document.getElementById("register-btn")?.addEventListener("click", () => openRegisterModal());

  root.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const regId = btn.dataset.reg;
      const action = btn.dataset.action;
      const reg = registrations.find(r => r.id === regId);
      if (action === "star") await updateDoc(doc(db, "registrations", regId), { priority: !reg.priority });
      if (action === "unregister" && confirm("Remove this registration?")) await deleteDoc(doc(db, "registrations", regId));
      if (action === "edit-contact") openEditContactModal(btn.dataset.contact);
      if (action === "up" || action === "down") {
        const list = rows;
        const i = list.findIndex(r => r.id === regId);
        const swapWith = action === "up" ? i - 1 : i + 1;
        if (swapWith >= 0 && swapWith < list.length) {
          const a = list[i], b = list[swapWith];
          await updateDoc(doc(db, "registrations", a.id), { priorityRank: swapWith });
          await updateDoc(doc(db, "registrations", b.id), { priorityRank: i });
        }
      }
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
    const ref = await addDoc(collection(db, "tournaments"), {
      name, date: document.getElementById("t-date").value, location: document.getElementById("t-location").value.trim(),
      createdAt: serverTimestamp()
    });
    selectedTournamentId = ref.id;
    closeModal();
  });
}

function openRegisterModal() {
  const already = new Set(registrations.filter(r=>r.tournamentId===selectedTournamentId && r.category===currentRmTab).map(r=>r.contactId));
  const pool = rmContacts.filter(c => c.category === currentRmTab && !already.has(c.id));
  showModal(`
    <h3>Register for ${escapeHtml(tournaments.find(t=>t.id===selectedTournamentId)?.name||"")}</h3>
    <div class="field">
      <label>Existing contact</label>
      <select id="reg-contact">${pool.length ? pool.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("") : `<option value="">No available contacts — add one below</option>`}</select>
    </div>
    <div class="access-note">Don't see who you need? Add a new relationship-management contact:</div>
    <div class="form-grid">
      <div class="field full"><label>New contact name</label><input id="new-c-name" placeholder="Leave blank to use selection above"></div>
      <div class="field full"><label>Contact info</label><input id="new-c-contact"></div>
      <div class="field full"><label>Tier</label>
        <select id="new-c-tier"><option value="free">Free tier</option><option value="paid">Paid</option></select>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Register</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    let contactId = document.getElementById("reg-contact").value;
    const newName = document.getElementById("new-c-name").value.trim();
    if (newName) {
      const ref = await addDoc(collection(db, "rmContacts"), {
        name: newName, category: currentRmTab, contact: document.getElementById("new-c-contact").value.trim(),
        tier: document.getElementById("new-c-tier").value,
        createdAt: serverTimestamp()
      });
      contactId = ref.id;
    }
    if (!contactId) { alert("Choose or add a contact."); return; }
    await addDoc(collection(db, "registrations"), {
      tournamentId: selectedTournamentId, contactId, category: currentRmTab,
      priority: false, priorityRank: 0, registeredAt: serverTimestamp()
    });
    closeModal();
  });
}

function openEditContactModal(contactId) {
  const contact = rmContacts.find(c => c.id === contactId);
  if (!contact) return;
  showModal(`
    <h3>Edit Contact</h3>
    <div class="form-grid">
      <div class="field full"><label>Name</label><input id="ec-name" value="${escapeAttr(contact.name)}"></div>
      <div class="field full"><label>Contact info</label><input id="ec-contact" value="${escapeAttr(contact.contact||"")}"></div>
      <div class="field full"><label>Tier</label>
        <select id="ec-tier">
          <option value="free" ${contact.tier!=="paid"?"selected":""}>Free tier</option>
          <option value="paid" ${contact.tier==="paid"?"selected":""}>Paid</option>
        </select>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("ec-name").value.trim();
    if (!name) { alert("Name is required."); return; }
    await updateDoc(doc(db, "rmContacts", contactId), {
      name, contact: document.getElementById("ec-contact").value.trim(),
      tier: document.getElementById("ec-tier").value
    });
    closeModal();
  });
}

// ---------------------------------------------------------------
// VIDEO PIPELINE PROGRESS TRACKER (enrolled athletes, per tournament)
// ---------------------------------------------------------------
function renderProgress() {
  const athleteRegs = registrations
    .filter(r => r.category === "athlete")
    .map(r => ({ ...r, contact: rmContacts.find(c => c.id === r.contactId), tourney: tournaments.find(t => t.id === r.tournamentId) }))
    .filter(r => r.contact && r.tourney);

  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div><div class="page-title">Video Pipeline</div><div class="page-desc">Inferencing → Annotation → Report Generation → Report Sent</div></div>
      </div>
      <div class="court-rule"></div>
      ${!canEditProgress() ? `<div class="access-note">View-only access.</div>` : ""}
      ${athleteRegs.map(r => {
        const p = progressDocs.find(p => p.contactId === r.contactId && p.tournamentId === r.tournamentId) || {};
        return `
        <div class="progress-row" data-contact="${r.contactId}" data-tourney="${r.tournamentId}">
          <div class="pname">${escapeHtml(r.contact.name)}</div>
          <div class="ptourney">${escapeHtml(r.tourney.name)}</div>
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
      }).join("") || `<div class="empty-state">No athletes registered for tournaments yet</div>`}
    </div>
  `;

  if (canEditProgress()) {
    root.querySelectorAll(".status-dot").forEach(dot => {
      dot.addEventListener("click", async () => {
        const rowEl = dot.closest(".progress-row");
        const contactId = rowEl.dataset.contact, tournamentId = rowEl.dataset.tourney;
        const stepKey = dot.dataset.step;
        let existing = progressDocs.find(p => p.contactId === contactId && p.tournamentId === tournamentId);
        const newVal = !(existing && existing[stepKey]);
        if (existing) {
          await updateDoc(doc(db, "progress", existing.id), { [stepKey]: newVal, updatedAt: serverTimestamp() });
        } else {
          await addDoc(collection(db, "progress"), { contactId, tournamentId, [stepKey]: newVal, updatedAt: serverTimestamp() });
        }
      });
    });
    root.querySelectorAll(".annotator-select").forEach(sel => {
      sel.addEventListener("change", async () => {
        const rowEl = sel.closest(".progress-row");
        const contactId = rowEl.dataset.contact, tournamentId = rowEl.dataset.tourney;
        let existing = progressDocs.find(p => p.contactId === contactId && p.tournamentId === tournamentId);
        if (existing) {
          await updateDoc(doc(db, "progress", existing.id), { annotator: sel.value, updatedAt: serverTimestamp() });
        } else {
          await addDoc(collection(db, "progress"), { contactId, tournamentId, annotator: sel.value, updatedAt: serverTimestamp() });
        }
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
      <div class="page-header"><div><div class="page-title">Backup</div><div class="page-desc">Export a full snapshot of the database as JSON</div></div></div>
      <div class="court-rule"></div>
      <div class="panel">
        <div class="panel-title">Export</div>
        <p style="color:var(--chalk-dim); font-size:13px; margin-bottom:14px;">Downloads sales leads, relationship contacts, tournaments, registrations, and video-pipeline progress in one file. Do this at month-end and store it somewhere safe.</p>
        <button class="btn btn-primary" id="export-btn">Download Backup (.json)</button>
      </div>
    </div>
  `;
  document.getElementById("export-btn").addEventListener("click", () => {
    const data = { exportedAt: new Date().toISOString(), salesLeads, rmContacts, tournaments, registrations, progress: progressDocs };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `visist-crm-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ---------------------------------------------------------------
// USERS (admin only) — add people and change roles without touching
// the Firebase console.
// ---------------------------------------------------------------
function renderUsers() {
  if (currentUser.role !== "admin") {
    root.innerHTML = `<div class="view"><div class="access-note">Admins only.</div></div>`;
    return;
  }
  root.innerHTML = `
    <div class="view">
      <div class="page-header">
        <div><div class="page-title">Users</div><div class="page-desc">Add logins and change what each person can do</div></div>
        <button class="btn btn-primary" id="add-user-btn">+ Add User</button>
      </div>
      <div class="court-rule"></div>
      <div class="access-note">Roles: <b>admin</b> (full access) · <b>sales</b> (Sales Pipeline only) · <b>tournament</b> (Relationships, priority, video pipeline) · <b>disabled</b> (blocks sign-in).</div>
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
      await updateDoc(doc(db, "users", sel.dataset.uid), { role: sel.value });
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
      await setDoc(doc(db, "users", cred.user.uid), { name, username, role, createdAt: serverTimestamp() });
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