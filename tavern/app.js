/* Tavern: live NPC sheets for the table.
   Read the README in this folder before changing anything.

   Data flow
   - NPCs come from npcs/*.yaml (listed in npcs/index.yaml). Re-fetched every 30 seconds.
   - Table state comes from Supabase (table public.tavern_state), one row per NPC per field.
     No row means the NPC is fresh. Every change is pushed to every open page through Realtime.
   - Writes go through database functions that check the shared table password. */

/* ---------- Configuration ---------- */
const CONFIG = {
  // Supabase dashboard > Project Settings > API Keys. Both values are public by design.
  // Never put the secret or service role key here.
  supabaseUrl: "https://YOUR-PROJECT-REF.supabase.co",
  supabaseKey: "sb_publishable_REPLACE_ME",
  yamlRefreshMs: 30000,
  retryMs: 20000,
};
const LOCAL_MODE = CONFIG.supabaseUrl.includes("YOUR-PROJECT-REF"); // preview without Supabase: state stays in this browser
const PASSWORD_KEY = "tavern-password";

/* ---------- Small helpers ---------- */
const $ = id => document.getElementById(id);
const esc = t => String(t ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const sign = v => (v >= 0 ? "+" : "") + v;
const mod = v => sign(Math.floor((v - 10) / 2));
const ORD = {1:"1st",2:"2nd",3:"3rd",4:"4th",5:"5th",6:"6th",7:"7th",8:"8th",9:"9th"};
const slug = t => String(t).toLowerCase().replace(/[^a-z]/g, "");
const CONDS = ["Blinded","Charmed","Deafened","Frightened","Grappled","Incapacitated","Invisible","Paralysed","Petrified","Poisoned","Prone","Restrained","Stunned","Exhaustion"];
const PANES = [
  ["stats","Stats",'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
  ["play","Play",'<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>'],
  ["actions","Actions",'<path d="M5 19 19 5M14 5h5v5M5 14l5 5"/>'],
  ["spells","Spells",'<path d="M12 3l2.2 5.6L20 9l-4.5 3.9L17 19l-5-3.2L7 19l1.5-6.1L4 9l5.8-.4z"/>']
];
const ICON_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const ICON_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>';
const ICON_MENU = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const store = {
  get(k){ try { return localStorage.getItem(k) } catch(e){ return null } },
  set(k,v){ try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k,v) } catch(e){} }
};

/* ---------- Backend: Supabase, or this browser when not configured ---------- */
function makeBackend(){
  if (LOCAL_MODE) {
    const KEY = "tavern-local-state";
    const read = () => { try { return JSON.parse(store.get(KEY)) || [] } catch(e){ return [] } };
    const write = rows => store.set(KEY, JSON.stringify(rows));
    const isDefault = v => v == null || v === 0 || v === false || v === "";
    const put = (rows, npc, field, value) => {
      const i = rows.findIndex(r => r.npc===npc && r.field===field);
      if (isDefault(value)) { if (i>=0) rows.splice(i,1); } else if (i>=0) rows[i].value = value; else rows.push({npc, field, value});
    };
    let listener = () => {};
    return {
      local: true,
      async load(){ return read(); },
      subscribe(onChange, onStatus){ listener = onChange; onStatus("SUBSCRIBED"); },
      async check(){ return true; },
      async set(pw, npc, field, value){ const rows = read(); put(rows, npc, field, value); write(rows); },
      async hp(pw, npc, amount, max){
        const rows = read(); const g = f => (rows.find(r => r.npc===npc && r.field===f) || {}).value || 0;
        let damage = g("damage"), temp = g("temp"), absorbed = 0; const wasDown = damage >= max;
        if (amount < 0){ absorbed = Math.min(temp, -amount); temp -= absorbed; damage = Math.min(max, damage + (-amount - absorbed)); }
        else { damage = Math.max(0, Math.min(damage, max) - amount); if (wasDown){ put(rows,npc,"death.s",0); put(rows,npc,"death.f",0); } }
        put(rows,npc,"damage",damage); put(rows,npc,"temp",temp); write(rows); return {damage, temp, absorbed};
      },
      async reset(pw, npc){ write(read().filter(r => r.npc!==npc)); }
    };
  }
  const client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, { auth: { persistSession:false, autoRefreshToken:false } });
  const rpc = async (fn, args) => { const { data, error } = await client.rpc(fn, args); if (error) throw error; return data; };
  return {
    local: false,
    async load(){
      const { data, error } = await client.from("tavern_state").select("npc,field,value");
      if (error) throw error; return data;
    },
    subscribe(onChange, onStatus){
      client.channel("tavern-state")
        .on("postgres_changes", { event:"*", schema:"public", table:"tavern_state" }, onChange)
        .subscribe(status => onStatus(status));
    },
    check: pw => rpc("tavern_check", { p_password: pw }),
    set: (pw, npc, field, value) => rpc("tavern_set", { p_password: pw, p_npc: npc, p_field: field, p_value: value }),
    hp: (pw, npc, amount, max) => rpc("tavern_hp", { p_password: pw, p_npc: npc, p_amount: amount, p_max: max }),
    reset: (pw, npc) => rpc("tavern_reset", { p_password: pw, p_npc: npc })
  };
}

/* ---------- App state ---------- */
let NPCS = [];            // parsed YAML, in index order
let BY_ID = {};
let yamlSignature = "";
let ROWS = {};            // { npc: { field: value } }
let backend = null;
let online = false;       // database reachable
let yamlError = "";
let password = store.get(PASSWORD_KEY);
let unlocked = false;
let current = null, pane = "stats", menuOpen = false, condOpen = null, confirmReset = null, unlockError = "";

const val = (id, field, def = 0) => (ROWS[id] && ROWS[id][field] != null) ? ROWS[id][field] : def;
function setLocal(id, field, value){
  ROWS[id] = ROWS[id] || {};
  if (value == null || value === 0 || value === false || value === "") delete ROWS[id][field]; else ROWS[id][field] = value;
}

/* Derived state */
const npcHp = n => Math.max(0, n.hp.max - val(n.id, "damage"));
const npcTemp = n => val(n.id, "temp");
const slotsLeft = (n, l) => Math.max(0, n.spellcasting.slots[l] - val(n.id, "slot."+l));
const armourOn = n => !!(n.interactive.mage_armour && val(n.id, "armour", false));
const acNow = n => armourOn(n) ? n.interactive.mage_armour.ac : n.ac;
const hasSpells = n => !!(n && n.spellcasting);
const conSave = n => (n.saves && n.saves.con) || 0;

/* ---------- Loading NPC YAML ---------- */
async function fetchText(path){
  const r = await fetch(path, { cache:"no-store" });
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  return r.text();
}
async function loadNpcs(){
  const indexText = await fetchText("npcs/index.yaml");
  const files = jsyaml.load(indexText) || [];
  const texts = await Promise.all(files.map(f => fetchText("npcs/" + f)));
  const sig = indexText + "\u0000" + texts.join("\u0000");
  if (sig === yamlSignature) return false;
  const list = texts.map((t, i) => {
    const n = jsyaml.load(t);
    const expected = files[i].replace(/\.ya?ml$/, "");
    if (!n || !n.id) throw new Error(`${files[i]} has no id`);
    if (n.id !== expected) throw new Error(`${files[i]} has id "${n.id}". It must match the file name ("${expected}").`);
    n.interactive = n.interactive || {};
    return n;
  });
  NPCS = list; BY_ID = Object.fromEntries(list.map(n => [n.id, n])); yamlSignature = sig;
  if (!BY_ID[current]) current = BY_ID[location.hash.slice(1)] ? location.hash.slice(1) : (list[0] && list[0].id);
  return true;
}

/* ---------- Rendering ---------- */
function renderBanner(){
  let h = "";
  if (yamlError) h += `<div class="banner"><b>The NPC files didn't load.</b> ${esc(yamlError)}</div>`;
  if (!online && !backend?.local) h += `<div class="banner"><b>The tavern's database can't be reached.</b> If it's session day, it may be asleep and need waking in Supabase. The sheets are read-only until it's back. Retrying every 20 seconds.</div>`;
  $("banner").innerHTML = h;
}
function renderLockbar(){
  document.body.classList.toggle("locked", !unlocked);
  $("lockbar").innerHTML = unlocked
    ? `<span>${backend?.local ? "Preview mode. Changes stay in this browser." : "Unlocked on this device."}</span><button class="btn lockbtn" data-act="lock">${ICON_OPEN} Lock</button>`
    : `<span>View only.</span><button class="btn lockbtn" data-act="unlock-open">${ICON_LOCK} Unlock to edit</button>`;
  document.querySelectorAll(".lockicon").forEach(b => { b.innerHTML = unlocked ? ICON_OPEN : ICON_LOCK; b.setAttribute("aria-label", unlocked ? "Lock this device" : "Unlock to edit"); b.dataset.act = unlocked ? "lock" : "unlock-open"; });
}
function renderUnlock(open){
  const f = $("unlock");
  if (!open){ f.hidden = true; $("uscrim").hidden = true; return; }
  f.innerHTML = `<h2 class="t-h1">Unlock to edit</h2>
    <p>Enter the table password. This device will remember it.</p>
    <label for="pw" class="sr">Table password</label>
    <input id="pw" type="password" autocomplete="current-password" required>
    ${unlockError ? `<p class="err" role="alert">${esc(unlockError)}</p>` : ""}
    <div class="row"><button type="button" class="btn" data-act="unlock-close">Cancel</button><button class="btn solid" type="submit">Unlock</button></div>`;
  f.hidden = false; $("uscrim").hidden = false;
  setTimeout(() => $("pw") && $("pw").focus(), 30);
}
function renderTabs(){
  $("tabs").innerHTML = NPCS.map(n => `<button class="tab" role="tab" id="tab-${n.id}" aria-selected="${n.id===current}" data-act="tab" data-id="${n.id}">
      <img src="${esc(n.portrait)}" alt=""><span><span class="t-h2">${esc(n.name)}</span><span class="meta num">${npcHp(n)}/${n.hp.max} HP${npcTemp(n)?` +${npcTemp(n)}`:""}${val(n.id,"conc","")?` · ${esc(val(n.id,"conc",""))}`:""}</span></span></button>`).join("");
}
function renderNav(){
  const n = BY_ID[current];
  const panes = PANES.filter(([k]) => k !== "spells" || hasSpells(n));
  $("nav").style.gridTemplateColumns = `repeat(${panes.length},minmax(0,1fr))`;
  $("nav").innerHTML = panes.map(([k,l,svg]) => `<button data-act="pane" data-p="${k}" aria-current="${k===pane}"><svg viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>${l}</button>`).join("");
}
function renderMenu(){
  $("menu").innerHTML = NPCS.map(n => `<button data-act="tab" data-id="${n.id}" aria-current="${n.id===current}"><img src="${esc(n.portrait)}" alt=""><span><span class="t-h1">${esc(n.name)}</span><i class="num">${esc(n.class)} · ${npcHp(n)}/${n.hp.max} HP</i></span></button>`).join("");
  $("menu").hidden = !menuOpen; $("scrim").hidden = !menuOpen;
  document.querySelectorAll(".burger").forEach(b => b.setAttribute("aria-expanded", menuOpen));
}
function miniHTML(n){
  const conc = val(n.id,"conc","");
  return `<img src="${esc(n.portrait)}" alt=""><div class="mn"><span class="t-h1">${esc(n.short || n.name)}</span><i class="num">${npcHp(n)}/${n.hp.max} HP${npcTemp(n)?` +${npcTemp(n)}`:""} · AC ${acNow(n)}${conc?` · ${esc(conc)}`:""}</i></div>
    <button class="lockicon" data-act="${unlocked?"lock":"unlock-open"}" aria-label="${unlocked?"Lock this device":"Unlock to edit"}">${unlocked?ICON_OPEN:ICON_LOCK}</button>
    <button class="burger" data-act="menu" aria-label="Choose a character" aria-expanded="${menuOpen}">${ICON_MENU}</button>`;
}
function stripHTML(n){
  const ma = n.interactive.mage_armour;
  return `<div class="box"><b class="t-h1 num">${acNow(n)}</b><span>Armour class</span><span>${armourOn(n) ? esc(ma.label) : esc(n.armour)}</span>${ma?`<button class="chip" data-w data-act="armour" data-id="${n.id}" aria-pressed="${armourOn(n)}">${esc(ma.label)}</button>`:""}</div>
    <div class="box"><b class="t-h1 num">${n.hp.max}</b><span>Max HP</span></div>
    <div class="box"><b class="t-h1">${esc(n.speed)}</b><span>Speed</span></div>
    <div class="box"><b class="t-h1 num">${mod(n.abilities.dex)}</b><span>Initiative</span></div>
    <div class="box"><b class="t-h1 num">+${n.proficiency}</b><span>Proficiency</span></div>
    ${hasSpells(n) ? `<div class="box"><b class="t-h1 num">${n.spellcasting.save_dc}</b><span>Spell save DC</span></div>` : `<div class="box"><b class="t-h1 num">${n.passive_perception ?? "–"}</b><span>Passive Perception</span></div>`}`;
}
/* Box trackers: `left` remain of `max`. Boxes are struck from the left as they're used. */
function marks(n, field, left, max, cls, label){
  const used = max - left;
  return Array.from({length:max}, (_,i) => { const u = i < used;
    return `<button class="mark ${cls} ${u?"used":""}" data-w data-act="mark" data-id="${n.id}" data-f="${field}" data-max="${max}" data-i="${i}" aria-pressed="${u}" aria-label="${esc(label)} ${i+1}: ${u?"used, tap to restore":"ready, tap to use"}"></button>`; }).join("")
    + `<span class="left num ${left===0?"out":""}">${left===0?"none left":left+" left"}</span>`;
}
function deathMarks(n, k, cls){
  const c = val(n.id, "death."+k);
  return [0,1,2].map(i => `<button class="mark ${cls} ${i<c?"used":""}" data-w data-act="death" data-id="${n.id}" data-k="${k}" data-i="${i}" aria-label="Death save ${k==="s"?"success":"failure"} ${i+1}"></button>`).join("");
}
function hpHTML(n){
  const it = n.interactive, hp = npcHp(n), temp = npcTemp(n), conc = val(n.id,"conc","");
  const pct = Math.max(0, Math.min(100, hp / n.hp.max * 100));
  const col = pct > 50 ? "var(--good)" : pct > 25 ? "var(--warn)" : "var(--danger)";
  const active = CONDS.filter(c => val(n.id, "cond."+slug(c), false));
  return `<div class="hp">
      ${it.hp ? `<div class="hpctl">
        <button class="btn heal" data-w data-act="hp" data-mode="heal" data-id="${n.id}">Heal</button>
        <label for="amt-${n.id}" class="sr">Amount</label>
        <input id="amt-${n.id}" type="number" inputmode="numeric" min="0" placeholder="0">
        <button class="btn dmg" data-w data-act="hp" data-mode="dmg" data-id="${n.id}">Damage</button>
      </div>` : ""}
      <div class="hpnums num">
        <div><span>Current</span><b class="big">${hp}</b></div>
        <div><span>Max</span><b class="big">${n.hp.max}</b></div>
        <div><span>Temp</span><b class="big">${temp||"–"}</b>${it.hp?`<button class="btn tmpbtn" data-w data-act="hp" data-mode="temp" data-id="${n.id}">Set</button>`:""}</div>
      </div>
      <div class="bar" aria-hidden="true"><i style="width:${pct}%;background:${col}"></i></div>
    </div>
    ${hp===0 && it.death_saves ? `<div class="down"><b>${esc(n.short||n.name)} is down.</b><div class="marks">Successes ${deathMarks(n,"s","ok")}</div><div class="marks">Failures ${deathMarks(n,"f","")}</div></div>` : ""}
    <div class="status">
      ${conc ? `<span class="conc">Concentrating on ${esc(conc)} <button data-w data-act="conc-clear" data-id="${n.id}" aria-label="End concentration">×</button></span>` : ""}
      ${active.map(k => `<span class="chip" aria-pressed="true">${k}</span>`).join("")}
    </div>
    ${it.conditions ? `<details class="conds" ${condOpen===n.id?"open":""}><summary>Conditions</summary><div class="chips">
      ${CONDS.map(k => `<button class="chip" data-w aria-pressed="${active.includes(k)}" data-act="cond" data-id="${n.id}" data-c="${slug(k)}">${k}</button>`).join("")}
    </div></details>` : ""}`;
}
function resHTML(n){
  const it = n.interactive; let h = "";
  if (it.spell_slots && hasSpells(n)) h += Object.keys(n.spellcasting.slots).map(l => `<div class="resrow"><div class="rl"><b>${ORD[l]}-level slots</b><i>Long rest</i></div><div class="marks">${marks(n,"slot."+l,slotsLeft(n,l),n.spellcasting.slots[l],"",ORD[l]+"-level slot")}</div></div>`).join("");
  (it.pools||[]).forEach(p => { const left = Math.max(0, p.max - val(n.id,"pool."+p.id)); h += `<div class="resrow"><div class="rl"><b>${esc(p.label)}</b><i>${p.rest==="short"?"Short rest":"Long rest"}</i></div>
    <div class="pool"><b class="num">${left}</b><i class="muted">of ${p.max} left</i>
    <input id="pool-${n.id}-${p.id}" type="number" inputmode="numeric" min="0" placeholder="0" aria-label="${esc(p.label)} points">
    <button class="btn" data-w data-act="pool" data-mode="spend" data-id="${n.id}" data-p="${p.id}">Spend</button>
    <button class="btn" data-w data-act="pool" data-mode="heal" data-id="${n.id}" data-p="${p.id}">Heal self</button></div></div>`; });
  (it.uses||[]).forEach(u => { h += `<div class="resrow"><div class="rl"><b>${esc(u.label)}</b><i>${u.rest==="short"?"Short rest":"Long rest"}</i></div><div class="marks">${marks(n,"use."+u.id,Math.max(0,u.max-val(n.id,"use."+u.id)),u.max,"gold",u.label)}</div></div>`; });
  if (it.portent){ const left = Array.from({length:it.portent}, (_,i) => !val(n.id,`portent.${i}.used`,false)).filter(Boolean).length;
    h += `<div class="resrow"><div class="rl"><b>Portent</b><i>New rolls each long rest</i></div><div class="portent">${Array.from({length:it.portent}, (_,i) => { const used = val(n.id,`portent.${i}.used`,false);
      return `<label class="${used?"spent":""}"><span class="sr">Portent roll ${i+1}</span><input id="portent-${n.id}-${i}" data-w data-portent="${n.id}" data-i="${i}" type="number" inputmode="numeric" min="1" max="20" placeholder="d20" value="${esc(val(n.id,`portent.${i}.roll`,""))}"><button class="mark ${used?"used":""}" data-w data-act="portent" data-id="${n.id}" data-i="${i}" aria-pressed="${used}" aria-label="Portent roll ${i+1}: ${used?"used, tap to restore":"ready, tap to use"}"></button></label>`; }).join("")}<span class="left">${left===0?"none left":left+" left"}</span></div></div>`; }
  if (it.hit_dice) h += `<div class="resrow"><div class="rl"><b>Hit dice</b><i>${n.hit_dice.count}${esc(n.hit_dice.die)}</i></div><div class="marks">${marks(n,"hd",Math.max(0,n.hit_dice.count-val(n.id,"hd")),n.hit_dice.count,"gold","Hit die")}</div></div>`;
  if (it.short_rest || it.reset) h += `<div class="rests">
    ${it.short_rest ? `<button class="btn" data-w data-act="short" data-id="${n.id}">Short rest</button>` : ""}
    ${it.reset ? (confirmReset===n.id
      ? `<span class="confirm">Reset ${esc(n.short||n.name)} to fresh? <button class="btn solid" data-w data-act="reset-yes" data-id="${n.id}">Reset</button><button class="btn" data-act="reset-no">Cancel</button></span>`
      : `<button class="btn" data-w data-act="reset" data-id="${n.id}">Long rest (reset)</button>`) : ""}</div>`;
  return h;
}
const entries = list => (list||[]).map(e => `<div class="entry"><p><b>${esc(e.name)}.</b> ${esc(e.text)}</p></div>`).join("");
function spellsHTML(n){
  const sc = n.spellcasting, levels = Object.keys(sc.spells || {});
  return levels.map(k => { const l = k === "cantrips" ? 0 : +k; const list = sc.spells[k] || [];
    return `<div class="slvl"><header><h3 class="t-h2">${l===0?"Cantrips":ORD[l]+" level"}</h3>${l>0 && sc.slots[l] && n.interactive.spell_slots ? `<span class="marks" id="sp-${n.id}-${l}">${marks(n,"slot."+l,slotsLeft(n,l),sc.slots[l],"",ORD[l]+"-level slot")}</span>` : l===0 ? `<i>At will</i>` : ""}</header>
    ${list.map(sp => `<div class="spell"><div><span class="sn">${esc(sp.name)}</span><span class="sm">${esc(sp.time)} · ${esc(sp.range)} · ${esc(sp.duration)}${sp.concentration?" · concentration":""}</span></div>
      ${l>0 && n.interactive.spell_slots ? `<button class="btn cast" data-w data-act="cast" data-id="${n.id}" data-l="${l}" data-n="${esc(sp.name)}" data-c="${sp.concentration?1:0}" data-arm="${sp.sets_armour?1:0}">Cast</button>` : "<span></span>"}
      <p>${esc(sp.text)}</p></div>`).join("")}</div>`; }).join("");
}
function sheetHTML(n){
  const abil = Object.entries(n.abilities).map(([k,v]) => `<div class="ab"><b>${k[0].toUpperCase()+k.slice(1)}</b><span class="t-h1 num">${mod(v)}</span><span class="sc num">${v}</span></div>`).join("");
  const profs = n.save_proficiencies || [];
  const saves = Object.entries(n.saves || {}).map(([k,v]) => `<span class="${profs.includes(k)?"prof":""}">${k[0].toUpperCase()+k.slice(1)} <span class="num">${sign(v)}</span></span>`).join("");
  const smite = n.interactive.divine_smite && hasSpells(n) ? `<div class="smites">${Object.keys(n.spellcasting.slots).map(l => `<button class="btn cast" data-w data-act="smite" data-id="${n.id}" data-l="${l}">Smite, ${ORD[l]} slot: ${1+(+l)}d8</button>`).join("")}</div>` : "";
  const sc = n.spellcasting;
  return `<section class="sheet" id="sheet-${n.id}" role="tabpanel" aria-labelledby="tab-${n.id}" data-show="${pane}" ${n.id===current?"":"hidden"}>
    <div class="mini" id="mini-${n.id}">${miniHTML(n)}</div>
    <article class="page">
      <div class="title"><h1 class="t-title">${esc(n.name)}</h1><p>${esc(n.subtitle)} · ${esc(n.class)}</p><hr class="taper"></div>
      <div class="strip" id="strip-${n.id}" data-pane="stats">${stripHTML(n)}</div>
      <div class="cols">
        <aside class="side">
          <figure class="portrait" data-pane="stats"><img src="${esc(n.portrait)}" alt="Portrait of ${esc(n.name)}"></figure>
          <div class="sect" data-pane="stats"><h2 class="t-h1">Abilities</h2><div class="abil">${abil}</div></div>
          <div class="sect" data-pane="stats"><h2 class="t-h1">Saving throws</h2><div class="saves">${saves}</div>${n.save_note?`<p class="note">${esc(n.save_note)}</p>`:""}</div>
          <div class="sect" data-pane="stats"><h2 class="t-h1">Details</h2><dl class="facts">
            <div><dt>Armour</dt><dd>${esc(n.armour)}${n.interactive.mage_armour?` (${esc(n.interactive.mage_armour.label)} gives AC ${n.interactive.mage_armour.ac})`:""}</dd></div>
            <div><dt>Hit points</dt><dd class="num">${n.hp.max} (${esc(n.hp.formula)})</dd></div>
            ${(n.details||[]).map(d => `<div><dt>${esc(d.label)}</dt><dd>${esc(d.text)}</dd></div>`).join("")}</dl></div>
          ${n.traits && n.traits.length ? `<div class="sect" data-pane="stats actions"><h2 class="t-h1">Traits</h2><div class="entries">${entries(n.traits)}</div></div>` : ""}
        </aside>
        <div class="main">
          <div class="sect" data-pane="play"><h2 class="t-h1">Hit points</h2><div class="block" id="hp-${n.id}">${hpHTML(n)}</div></div>
          <div class="sect" data-pane="play"><h2 class="t-h1">Resources</h2><div class="block res" id="res-${n.id}">${resHTML(n)}</div></div>
          <div class="sect" data-pane="actions"><h2 class="t-h1">Actions</h2><div class="entries">${entries(n.actions)}</div>
            ${n.bonus_actions && n.bonus_actions.length ? `<h3 class="t-h2 sub">Bonus actions</h3><div class="entries">${entries(n.bonus_actions)}</div>${smite}` : ""}
            ${n.reactions && n.reactions.length ? `<h3 class="t-h2 sub">Reactions</h3><div class="entries">${entries(n.reactions)}</div>` : ""}</div>
          ${sc ? `<div class="sect" data-pane="spells"><h2 class="t-h1">Spellcasting</h2>
            <p class="castinfo">${esc(sc.summary)}. ${esc(sc.ability)}, save DC <b class="num">${sc.save_dc}</b>, <b class="num">${esc(sc.attack)}</b> to hit.</p>
            ${spellsHTML(n)}</div>` : ""}
        </div>
      </div>
    </article>
  </section>`;
}
function renderAll(){
  if (!NPCS.length){ $("sheets").innerHTML = `<p class="empty">${yamlError ? "No NPCs to show." : "Opening the tavern…"}</p>`; return; }
  $("sheets").innerHTML = NPCS.map(sheetHTML).join("");
  renderTabs(); renderNav(); renderMenu(); renderLockbar();
}
/* Refresh only the parts that change with table state, so inputs and scroll survive. */
function refresh(id){
  const n = BY_ID[id]; if (!n || !$("sheet-"+id)) return;
  const keep = document.activeElement && document.activeElement.id;
  $("hp-"+id).innerHTML = hpHTML(n);
  $("res-"+id).innerHTML = resHTML(n);
  $("strip-"+id).innerHTML = stripHTML(n);
  if (hasSpells(n) && n.interactive.spell_slots) Object.keys(n.spellcasting.slots).forEach(l => { const el = $(`sp-${id}-${l}`); if (el) el.innerHTML = marks(n,"slot."+l,slotsLeft(n,l),n.spellcasting.slots[l],"",ORD[l]+"-level slot"); });
  $("mini-"+id).innerHTML = miniHTML(n);
  renderTabs(); renderMenu();
  if (keep && $(keep) && keep.startsWith("portent-")) $(keep).focus();
}

/* ---------- Toast ---------- */
let toastT;
function toast(msg){ const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3600); }

/* ---------- Writes ---------- */
function explain(err){
  if (err && err.code === "28P01") return "wrong-password";
  if (err && err.code === "28000") return "The table password hasn't been set up yet.";
  if (err && /fetch|network|Failed|timeout/i.test(String(err.message || err))) return "The database can't be reached, so that change wasn't saved.";
  return "That change wasn't saved. " + (err && err.message ? err.message : "");
}
async function guarded(fn){
  if (!unlocked){ openUnlock(); toast("Unlock with the table password to make changes."); return false; }
  if (!online && !backend.local){ toast("The database can't be reached, so changes are paused."); return false; }
  try { await fn(); return true; }
  catch(err){
    const why = explain(err);
    if (why === "wrong-password"){ lock(); unlockError = "The table password has changed. Enter the new one."; openUnlock(); }
    else toast(why);
    await reloadRows(); return false;
  }
}
/* Set fields optimistically, then save. Last write wins. */
async function write(id, changes){
  return guarded(async () => {
    changes.forEach(([f,v]) => setLocal(id, f, v)); refresh(id);
    for (const [f,v] of changes) await backend.set(password, id, f, v);
  });
}

/* ---------- Unlock ---------- */
function openUnlock(){ renderUnlock(true); }
function lock(){ unlocked = false; password = null; store.set(PASSWORD_KEY, null); renderLockbar(); NPCS.forEach(n => refresh(n.id)); }
async function tryUnlock(pw){
  try {
    const ok = await backend.check(pw);
    if (!ok){ unlockError = "That password isn't right. Check with the DM."; renderUnlock(true); return; }
    password = pw; unlocked = true; unlockError = ""; store.set(PASSWORD_KEY, pw);
    renderUnlock(false); renderLockbar(); NPCS.forEach(n => refresh(n.id)); toast("Unlocked. Changes now save for the whole table.");
  } catch(err){
    unlockError = explain(err) === "wrong-password" ? "That password isn't right." : "The database can't be reached right now, so the password can't be checked.";
    renderUnlock(true);
  }
}

/* ---------- Table state sync ---------- */
async function reloadRows(){
  try {
    const rows = await backend.load();
    ROWS = {}; rows.forEach(r => setLocal(r.npc, r.field, r.value));
    online = true;
  } catch(err){ online = false; }
  renderBanner(); NPCS.forEach(n => refresh(n.id));
  return online;
}
function onRealtime(payload){
  if (payload.eventType === "DELETE"){ const o = payload.old || {}; if (o.npc && o.field){ setLocal(o.npc, o.field, null); refresh(o.npc); } return; }
  const r = payload.new || {}; if (r.npc && r.field){ setLocal(r.npc, r.field, r.value); refresh(r.npc); }
}
let retryT;
function onStatus(status){
  if (status === "SUBSCRIBED"){ reloadRows(); return; }       // catch anything missed while disconnected
  if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED"){ online = false; renderBanner(); scheduleRetry(); }
}
function scheduleRetry(){
  clearTimeout(retryT);
  retryT = setTimeout(async () => { if (!(await reloadRows())) scheduleRetry(); }, CONFIG.retryMs);
}

/* ---------- Events ---------- */
function showChar(id){
  current = id; try { history.replaceState(null, "", "#"+id) } catch(e){}
  NPCS.forEach(n => $("sheet-"+n.id).hidden = n.id !== id);
  if (pane === "spells" && !hasSpells(BY_ID[id])) showPane("stats"); else renderNav();
  renderTabs(); window.scrollTo(0,0);
}
function showPane(p){ pane = p; document.querySelectorAll(".sheet").forEach(el => el.dataset.show = p); renderNav(); window.scrollTo(0,0); }
function lowestSlot(n, min){ return Object.keys(n.spellcasting.slots).map(Number).sort((a,b)=>a-b).find(l => l>=min && slotsLeft(n,l)>0); }

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id, n = BY_ID[id];
  const name = n ? (n.short || n.name) : "";

  if (act==="tab"){ menuOpen = false; renderMenu(); showChar(id); return; }
  if (act==="pane"){ showPane(b.dataset.p); return; }
  if (act==="menu"){ menuOpen = !menuOpen; renderMenu(); return; }
  if (act==="menu-close"){ menuOpen = false; renderMenu(); return; }
  if (act==="unlock-open"){ unlockError = ""; openUnlock(); return; }
  if (act==="unlock-close"){ renderUnlock(false); return; }
  if (act==="lock"){ lock(); toast("Locked on this device."); return; }
  if (act==="reset-no"){ const was = confirmReset; confirmReset = null; if (was) refresh(was); return; }
  if (act==="reset"){ if (!unlocked){ openUnlock(); return; } confirmReset = id; refresh(id); return; }

  if (act==="hp"){
    const inp = $("amt-"+id); const amt = Math.max(0, parseInt(inp.value,10) || 0);
    if (!amt){ toast("Enter an amount first."); inp.focus(); return; }
    const mode = b.dataset.mode;
    await guarded(async () => {
      if (mode === "temp"){ const t = Math.min(999, Math.max(npcTemp(n), amt)); setLocal(id,"temp",t); refresh(id); await backend.set(password, id, "temp", t); toast(`${name} has ${t} temporary HP. Temp HP doesn't stack.`); return; }
      const r = await backend.hp(password, id, mode==="dmg" ? -amt : amt, n.hp.max);
      setLocal(id,"damage",r.damage); setLocal(id,"temp",r.temp);
      if (mode==="heal"){ if (r.damage < n.hp.max){ setLocal(id,"death.s",0); setLocal(id,"death.f",0); } toast(`${name} heals. Now ${npcHp(n)} HP.`); refresh(id); return; }
      let msg = `${name} takes ${amt} damage${r.absorbed?` (${r.absorbed} from temp HP)`:""}.`;
      const conc = val(id,"conc","");
      if (r.damage >= n.hp.max){ msg += ` ${name} is down.`; if (conc){ msg += ` Concentration on ${conc} ends.`; setLocal(id,"conc",""); refresh(id); await backend.set(password, id, "conc", ""); } }
      else if (conc) msg += ` Concentration check: Con save DC ${Math.max(10, Math.floor(amt/2))} (${sign(conSave(n))}).`;
      refresh(id); toast(msg);
    });
    inp.value = ""; return;
  }
  if (act==="mark"){
    const f = b.dataset.f, max = +b.dataset.max, i = +b.dataset.i, used = val(id, f);
    await write(id, [[f, Math.min(max, i < used ? i : i+1)]]); return;
  }
  if (act==="death"){ const f = "death."+b.dataset.k, i = +b.dataset.i, c = val(id,f); const nv = i < c ? i : i+1;
    if (await write(id, [[f, nv]])){ if (b.dataset.k==="s" && nv===3) toast(`${name} is stable at 0 HP.`); if (b.dataset.k==="f" && nv===3) toast(`${name} has failed three death saves.`); } return; }
  if (act==="cond"){ const f = "cond."+b.dataset.c; condOpen = id; await write(id, [[f, !val(id,f,false)]]); return; }
  if (act==="armour"){ await write(id, [["armour", !armourOn(n)]]); return; }
  if (act==="conc-clear"){ const c = val(id,"conc",""); if (await write(id, [["conc",""]])) toast(`Concentration on ${c} ended.`); return; }
  if (act==="portent"){ const f = `portent.${b.dataset.i}.used`; const now = !val(id,f,false);
    if (await write(id, [[f, now]]) && now) toast(`Portent roll ${val(id,`portent.${b.dataset.i}.roll`,"?")} used.`); return; }
  if (act==="cast"){
    const l = +b.dataset.l, spell = b.dataset.n, lv = lowestSlot(n, l);
    if (!lv){ toast(`No ${ORD[l]}-level or higher slots left for ${spell}.`); return; }
    const changes = [["slot."+lv, val(id,"slot."+lv) + 1]]; let msg = `${spell} cast. One ${ORD[lv]}-level slot used.`;
    if (b.dataset.c==="1"){ const prev = val(id,"conc",""); changes.push(["conc", spell]); if (prev && prev !== spell) msg += ` Dropped ${prev}.`; }
    if (b.dataset.arm==="1" && n.interactive.mage_armour){ changes.push(["armour", true]); msg += ` AC is now ${n.interactive.mage_armour.ac}.`; }
    if (await write(id, changes)) toast(msg); return;
  }
  if (act==="smite"){
    const l = +b.dataset.l; if (!slotsLeft(n,l)){ toast(`No ${ORD[l]}-level slots left.`); return; }
    if (await write(id, [["slot."+l, val(id,"slot."+l) + 1]])) toast(`Divine Smite: ${1+l}d8 radiant, or ${2+l}d8 against a fiend or undead.`); return;
  }
  if (act==="pool"){
    const p = n.interactive.pools.find(x => x.id === b.dataset.p), inp = $(`pool-${id}-${p.id}`), amt = Math.max(0, parseInt(inp.value,10) || 0);
    const left = p.max - val(id,"pool."+p.id);
    if (!amt){ toast("Enter how many points to spend."); inp.focus(); return; }
    if (amt > left){ toast(`Only ${left} points left.`); return; }
    const ok = await write(id, [["pool."+p.id, val(id,"pool."+p.id) + amt]]); if (!ok) return;
    if (b.dataset.mode==="heal"){ await guarded(async () => { const r = await backend.hp(password, id, amt, n.hp.max); setLocal(id,"damage",r.damage); setLocal(id,"temp",r.temp); refresh(id); }); toast(`${name} heals ${amt}. ${left-amt} left in ${p.label}.`); }
    else toast(`${amt} spent from ${p.label}. ${left-amt} left.`);
    inp.value = ""; return;
  }
  if (act==="short"){
    const short = (n.interactive.uses||[]).filter(u => u.rest==="short").map(u => ["use."+u.id, 0])
      .concat((n.interactive.pools||[]).filter(p => p.rest==="short").map(p => ["pool."+p.id, 0]));
    if (await write(id, short)) toast(short.length ? `Short rest taken. ${[...(n.interactive.uses||[]),...(n.interactive.pools||[])].filter(x=>x.rest==="short").map(x=>x.label).join(", ")} restored.` : "Short rest taken. Tap hit dice to spend them."); return;
  }
  if (act==="reset-yes"){
    confirmReset = null;
    const ok = await guarded(async () => { await backend.reset(password, id); ROWS[id] = {}; refresh(id); });
    if (ok) toast(`${name} is fresh. HP, slots and features restored.${n.interactive.portent?" Roll two new d20s for Portent.":""}`);
    else refresh(id);
    return;
  }
});
document.addEventListener("submit", e => {
  if (e.target.id !== "unlock") return;
  e.preventDefault(); const pw = $("pw").value; if (pw) tryUnlock(pw);
});
/* Portent rolls save when the box loses focus or Enter is pressed. */
document.addEventListener("change", e => {
  const el = e.target; if (!el.matches("input[data-portent]")) return;
  const id = el.dataset.portent, f = `portent.${el.dataset.i}.roll`;
  const v = el.value === "" ? "" : String(Math.max(1, Math.min(20, parseInt(el.value,10) || 1)));
  write(id, [[f, v]]);
});
document.addEventListener("toggle", e => { if (e.target.matches && e.target.matches("details.conds")) condOpen = e.target.open ? e.target.closest(".sheet").id.slice(6) : null; }, true);
document.addEventListener("keydown", e => { if (e.key === "Escape"){ renderUnlock(false); if (menuOpen){ menuOpen = false; renderMenu(); } } });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reloadRows(); });

/* ---------- Start ---------- */
async function refreshYaml(){
  try { const changed = await loadNpcs(); yamlError = ""; if (changed) renderAll(); }
  catch(err){ yamlError = err.message; if (!NPCS.length) renderAll(); }
  renderBanner();
}
(async function start(){
  try { backend = makeBackend(); }
  catch(err){
    // The Supabase library didn't load (blocked or offline). Show the sheets read-only.
    const down = () => Promise.reject(new Error("Failed to fetch"));
    backend = { local:false, load:down, subscribe(){}, check:down, set:down, hp:down, reset:down };
  }
  renderLockbar();
  await refreshYaml();
  await reloadRows();
  if (!online) scheduleRetry();
  try { backend.subscribe(onRealtime, onStatus); } catch(err){ online = false; renderBanner(); scheduleRetry(); }
  if (password){
    try { if (await backend.check(password)){ unlocked = true; } else { store.set(PASSWORD_KEY, null); password = null; } }
    catch(err){ unlocked = true; }  // offline: keep the saved password and try it on the next write
    renderLockbar(); NPCS.forEach(n => refresh(n.id));
  }
  setInterval(refreshYaml, CONFIG.yamlRefreshMs);
})();
