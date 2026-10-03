# Tavern

Live NPC sheets for the table, at **studio-rhys.com/tavern**.

Players open the page on their own phones, tablets and laptops. The clickable pieces (HP, spell slots, death saves, conditions and so on) update on every screen within a second. Everything else on a sheet is read-only, and only changes when the NPC's YAML file is edited and pushed.

---

## Contents

1. [How it works](#how-it-works)
2. [Session-day checklist](#session-day-checklist)
3. [Common jobs](#common-jobs)
4. [Files](#files)
5. [NPC YAML reference](#npc-yaml-reference)
6. [Supabase](#supabase)
7. [First-time setup](#first-time-setup)
8. [Decisions](#decisions)
9. [Caveats and known limits](#caveats-and-known-limits)
10. [Troubleshooting](#troubleshooting)

---

## How it works

- **The page** is plain HTML, CSS and JavaScript with no build step. It loads two libraries from jsDelivr: `@supabase/supabase-js` 2.117.2 and `js-yaml` 4.1.0. Both are pinned to exact versions in `index.html`.
- **NPC data** lives in `npcs/*.yaml`. `npcs/index.yaml` lists which files to load, in tab order, because a static site can't list a folder. Open pages re-fetch the YAML every 30 seconds with `cache: 'no-store'` and redraw if anything changed. Table state isn't touched when this happens.
- **Table state** lives in one Supabase table, `public.tavern_state`, with one row per NPC per field. No row means "fresh": full HP, all slots, no conditions.
- **Reading** is open to anyone. **Writing** only happens through database functions that check the shared table password.
- **Realtime** pushes every insert, update and delete to every open page. When a page reconnects, or a phone wakes up, it reloads the whole table to catch anything it missed.

---

## Session-day checklist

1. Open the Supabase dashboard. If the project says it's **paused**, choose **Restore project** and wait a few minutes. Free projects pause after 7 days without activity.
2. Open studio-rhys.com/tavern and check there's no red banner at the top.
3. Give the players the table password. They tap **Unlock to edit** once, and each device remembers it.

---

## Common jobs

### Change an NPC (stats, spells, text)
Edit `tavern/npcs/<id>.yaml`, then commit and push. Open pages pick it up within about 30 seconds, without a refresh. Never change the `id`.

### Add an NPC
1. Copy an existing YAML file, for example `npcs/kessa.yaml`, to `npcs/<newid>.yaml`. Use lowercase letters, digits, `-` or `_` only.
2. Set `id: <newid>` to match the file name exactly.
3. Add a portrait to `portraits/`, roughly 640 × 960 px JPEG, under 150 KB.
4. Add `- <newid>.yaml` to `npcs/index.yaml` where you want the tab.
5. Commit and push.

No Supabase change is needed.

### Remove an NPC from the page
Delete its line from `npcs/index.yaml` and push. Its saved state stays in Supabase. To clear that state as well, use the **Long rest (reset)** button first, or run:

```sql
delete from public.tavern_state where npc = 'the-id';
```

### Change the table password
Supabase dashboard → **SQL Editor** → run this, with the new password in place of the placeholder:

```sql
insert into tavern_private.settings (id, password_hash)
values (1, extensions.crypt('new table password', extensions.gen_salt('bf')))
on conflict (id) do update set password_hash = excluded.password_hash;
```

Devices that remembered the old password are locked on their next change, and asked for the new one.

Don't save the real password into any file in the repo. The SQL Editor keeps a query history in your Supabase account, so you may want to delete that query from the history afterwards.

### Reset one NPC
On the sheet, tap **Long rest (reset)**, then **Reset**. This deletes all of that NPC's rows, so HP, slots, conditions, uses, Portent and hit dice all return to fresh.

### Reset everything
```sql
delete from public.tavern_state;
```

### See what's stored
Supabase dashboard → **Table Editor** → `tavern_state`. Or run:

```sql
select npc, field, value, updated_at from public.tavern_state order by npc, field;
```

---

## Files

```
tavern/
  index.html          page shell, CDN scripts, noindex meta
  app.js              everything the page does; Supabase URL and key at the top
  style.css           Player's Handbook look; desktop, tablet and phone layouts
  README.md           this file
  npcs/
    index.yaml        which NPC files to load, in tab order
    matthew.yaml
    toro.yaml
    kessa.yaml
    telmet.yaml
  portraits/
    matthew.jpg  toro.jpg  kessa.jpg  telmet.jpg
  setup/
    supabase.sql      creates the table, policies, functions and realtime
```

Everything under `tavern/` lives outside `/css/`, `/images/` and `/fonts/`, so the long cache rules in the site's `_headers` file don't apply. Cloudflare Pages' default for other files is to revalidate on every load, so a push shows up straight away.

**Every file in this folder is publicly reachable**, including this README and `setup/supabase.sql`. Neither contains anything secret.

---

## NPC YAML reference

Every field below is read-only on the page unless it's listed under `interactive`.

```yaml
id: toro                       # must equal the file name; never change it (state is stored against it)
name: Toro                     # shown as the page title
short: Toro                    # used in the phone header and messages
portrait: portraits/toro.jpg   # path relative to tavern/
subtitle: Medium humanoid (copper dragonborn), wizard, neutral good
class: Wizard 7
armour: None
ac: 9
hp: { max: 40, formula: "7d6 + 14" }
hit_dice: { count: 7, die: d6 }
speed: 30 ft
proficiency: 3
passive_perception: 10         # shown in the top strip for NPCs without spellcasting
abilities: { str: 10, dex: 8, con: 14, int: 20, wis: 10, cha: 8 }
saves: { str: 0, dex: -1, con: 2, int: 8, wis: 3, cha: -1 }   # final bonuses
save_proficiencies: [int, wis] # shown in bold
save_note: optional line under the saves
details:                       # free label and text rows under Details
  - { label: Skills, text: "Arcana +8, History +8" }
traits:        [{ name: ..., text: ... }]
actions:       [{ name: ..., text: ... }]
bonus_actions: [{ name: ..., text: ... }]   # optional
reactions:     [{ name: ..., text: ... }]   # optional
spellcasting:                  # optional; leave out for non-casters
  summary: 7th-level wizard
  ability: Intelligence
  save_dc: 16
  attack: "+8"
  slots: { 1: 4, 2: 3, 3: 3, 4: 1 }
  spells:
    cantrips: [ ... ]
    1:
      - name: Mage Armor
        time: 1 action
        range: Touch
        duration: 8 hours
        concentration: true    # optional; casting it sets Concentration
        sets_armour: true      # optional; casting it turns on the Mage Armour toggle
        text: ...
interactive:                   # which clickable pieces this NPC has
  hp: true                     # Heal, Damage and Temp HP controls
  death_saves: true            # shown only at 0 HP
  conditions: true
  hit_dice: true
  concentration: true
  spell_slots: true            # slot boxes and Cast buttons (needs spellcasting.slots)
  divine_smite: true           # Smite buttons under Bonus actions
  mage_armour: { ac: 12, label: Mage Armor }
  pools:                       # number pools like Lay on Hands
    - { id: loh, label: Lay on Hands, max: 35, rest: long }
  uses:                        # limited-use features
    - { id: breath, label: Breath Weapon, max: 3, rest: long }   # rest: short or long
  portent: 2                   # number of Portent dice
  short_rest: true             # Short rest button: restores uses and pools marked rest: short
  reset: true                  # Long rest (reset) button, with a confirmation step
```

YAML tips:
- Quote text that contains a colon followed by a space, for example `"Hit: 11 (2d6 + 4)"`, or YAML misreads it.
- `id` values inside `pools` and `uses` become part of the stored field name. Keep them short, lowercase and stable.
- If a file fails to load, open pages keep showing the last good version and display a banner naming the problem.

---

## Supabase

### Table

`public.tavern_state`

| column | type | notes |
|---|---|---|
| npc | text | NPC id, from the YAML file name |
| field | text | see the field list below |
| value | jsonb | number, true or false, or short text |
| updated_at | timestamptz | set on every write |

The primary key is (npc, field). Row level security is on, with one policy: anyone can `select`. There are no insert, update or delete policies, and table privileges for `anon` and `authenticated` are select-only.

### Stored fields

A field only exists while it holds a non-default value. Writing `0`, `false` or empty text deletes the row.

| field | kind | stores | range |
|---|---|---|---|
| `damage` | number | damage taken (HP = max − damage) | 0–999 |
| `temp` | number | temporary HP | 0–999 |
| `pool.<id>` | number | points spent from a pool | 0–999 |
| `slot.<level>` | counter | spell slots used at that level | 0–20 |
| `hd` | counter | hit dice used | 0–20 |
| `use.<id>` | counter | uses spent | 0–20 |
| `death.s`, `death.f` | counter | death save successes and failures | 0–20 (page caps at 3) |
| `cond.<name>` | toggle | condition on, for example `cond.prone` | true or false |
| `armour` | toggle | Mage Armour on | true or false |
| `portent.<n>.used` | toggle | Portent die spent | true or false |
| `conc` | text | spell being concentrated on | up to 60 characters |
| `portent.<n>.roll` | text | the recorded d20 | up to 60 characters |

Everything is stored as *used* or *taken*, so no row means "fresh".

### Functions

All of these are `security definer`, check the password first, and are callable by the public `anon` role.

| function | what it does |
|---|---|
| `tavern_check(p_password)` | returns true if the password is right. Used by the Unlock form. |
| `tavern_set(p_password, p_npc, p_field, p_value)` | writes one field. Rejects unknown field names, the wrong value type and out-of-range values. |
| `tavern_hp(p_password, p_npc, p_amount, p_max)` | damage (negative amount) or heal (positive) in one locked step. Damage comes out of temp HP first. Healing from 0 HP clears death saves. |
| `tavern_reset(p_password, p_npc)` | deletes all of one NPC's rows. |

Private helpers live in the `tavern_private` schema, which the API can't reach: `check_password`, `field_kind`, `put` and `check_npc`. The password hash is in `tavern_private.settings`. It's a single row, hashed with pgcrypto `crypt` using bcrypt.

### Keys

`app.js` holds the **Project URL** and the **publishable key** (`sb_publishable_…`). Both are public by design. Row level security and the password-checking functions are what protect the data.

**Never** put the secret key (`sb_secret_…`) or the legacy `service_role` key in the repo or the page.

---

## First-time setup

### 1. Create the Supabase project
1. In supabase.com/dashboard, choose **New project**.
2. Name it `tavern`.
3. Pick a region near you, for example Central EU (Frankfurt).
4. Set a strong database password. This is not the table password; store it in your password manager.
5. Wait for the project to finish provisioning.

### 2. Create the database objects
1. Go to **SQL Editor** → **New query**.
2. Paste the whole of `tavern/setup/supabase.sql` and choose **Run**. You should see "Success. No rows returned".
3. Run the password statement from [Change the table password](#change-the-table-password) with your chosen table password.

### 3. Check Realtime and the API
- **Database** → **Publications** → `supabase_realtime` should list `tavern_state`. The setup script adds it.
- **Project Settings** → **Data API**: `public` should be in the exposed schemas. It is by default.

### 4. Connect the page
1. Go to **Project Settings** → **API Keys**.
2. Copy the **Project URL** and the **publishable key**.
3. Paste them into the `CONFIG` block at the top of `tavern/app.js`.

### 5. Hide the page from search engines
- `index.html` already carries `<meta name="robots" content="noindex, nofollow">`.
- Add this line to the site's `robots.txt`, under `User-agent: *`:
  ```
  Disallow: /tavern/
  ```
- Leave `/tavern/` out of the sitemap and the navigation.
- Optionally, add this block to the site's `_headers` file so every file in the folder, YAML and README included, carries a noindex header:
  ```
  /tavern/*
    X-Robots-Tag: noindex, nofollow
  ```

### 6. Deploy
In the Mac terminal, from your local copy of the repo:

```bash
git add tavern robots.txt _headers
git commit -m "Add tavern NPC sheets"
git push
```

Cloudflare Pages deploys from `main` within a minute or two.

### 7. Test
1. Open studio-rhys.com/tavern on two devices.
2. Unlock one of them and tap a spell slot box. The other screen should cross the same box within a second.
3. Enter a wrong password on the second device. You should see "That password isn't right".

### Previewing locally
From the repo root:

```bash
cd tavern && python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` straight from Finder won't work, because browsers block fetching the YAML from `file://`.

While `CONFIG.supabaseUrl` still contains `YOUR-PROJECT-REF`, the page runs in **preview mode**. Any password unlocks it, and state is kept only in that browser. Once the real URL and key are in, local previews read and write the live table.

---

## Decisions

- **Separate folder, no build step.** It fits the existing plain-HTML site. Files sit in `/tavern/` so the site's long cache rules don't apply.
- **YAML in the repo for NPC data.** It's edited by Rhys only, versioned in git, and has no admin screen to build or secure.
- **`npcs/index.yaml` lists the files**, because a static host can't list a folder.
- **The NPC id is the file name, and it's permanent.** State is keyed by id.
- **There's no hidden or revealed state.** Only NPCs the players may see get added.
- **One shared table password**, with no accounts, logins or DM page. It's asked for once and remembered per device in localStorage. Without it the page is view-only.
- **All writes go through password-checking functions.** The table itself is read-only to the public.
- **Field names are allow-listed in the database** (`tavern_private.field_kind`), along with value types and ranges.
- **State is stored as "used" or "taken", and a missing row means fresh.** This makes reset a simple delete, and new NPCs need no setup.
- **Last write wins** for everything except HP. If two people tap at once, the later tap stands and everyone sees it.
- **HP uses plus and minus amounts** (`tavern_hp`) under a per-NPC lock, so two hits landing at the same moment both count.
- **Every toggle is reversible.** Tapping a crossed box restores it.
- **Nothing resets on its own.** State stays until someone changes it.
- **Long rest is the reset button.** It wipes the NPC to fresh, which also restores all hit dice. That's more generous than the rules, which restore half, and was accepted for simplicity.
- **Short rest** restores only the uses and pools marked `rest: short`. Players spend hit dice by tapping the boxes.
- **Notes were dropped.** Free text shared in real time would overwrite people mid-typing.
- **Rules are 5.5e (2024).** These are NPC versions, deliberately lighter than full PCs. For example, there's no Channel Divinity, Arcane Recovery, Second Wind, Luck or Heroic Inspiration, and backgrounds give no ability score increases.
- **Type is limited to four styles:** title (the NPC's name, plus the big HP numbers), heading 1 (section headings and stat numbers), heading 2 (sub-headings such as spell levels), and body, with bold and italic doing the rest.
- **The phone layout** has a sticky mini header with a lock button and a menu for switching NPCs, and a bottom tab bar (Stats, Play, Actions, Spells), opening on Stats. Spells is hidden for non-casters. Tablets in portrait keep the two-column desktop layout.

---

## Caveats and known limits

- **Free Supabase projects pause after 7 days without activity.** Restore the project in the dashboard before each session. While it's paused, the page shows a banner, stays read-only and retries every 20 seconds.
- **The password is only as strong as you make it**, and there's no lockout. Someone with the page URL and enough patience could try passwords against `tavern_check`. Use a long phrase rather than a single word. The worst they could do is change NPC trackers, which `delete from public.tavern_state` undoes.
- **The password sits in plain text in each device's localStorage.** Tapping **Lock** clears it from that device.
- **The database checks types and ranges, not each NPC's own limits.** It doesn't know that Toro has only one 4th-level slot; the page enforces that from the YAML.
- **`tavern_hp` trusts the hit point maximum the page sends.** It's clamped to 1–999.
- **Last write wins for non-HP fields.** Two people casting at the same instant can record one slot instead of two.
- **Concentration messages** after damage, smite dice and similar text are shown only on the device that made the change. Other screens just see the new state.
- **The Portent roll saves when the box loses focus**, so press Enter or tap elsewhere after typing it.
- **Renaming an NPC's id orphans its state.** Clear the old rows with the delete statement above.
- **There's no history or undo log** beyond tapping again. Supabase's daily backups on the free plan are the only safety net.
- **The CDN libraries are pinned.** If jsDelivr is ever blocked on a venue network, the page shows the sheets read-only. To upgrade supabase-js, change the version in `index.html` and test with two devices.

---

## Troubleshooting

| what you see | likely cause | fix |
|---|---|---|
| Red banner: database can't be reached | project paused, or no internet | restore the project in Supabase; the page retries every 20 s |
| Red banner: NPC files didn't load | YAML syntax error, or a file listed in `index.yaml` is missing | the banner names the file; fix it and push |
| "id must match the file name" | `id:` differs from the file name | make them identical |
| "That password isn't right" | wrong or changed password | check the password, or set a new one with the SQL above |
| "The table password hasn't been set up yet" | the `settings` row is missing | run the password statement |
| Taps work but other screens don't update | `tavern_state` isn't in the realtime publication | re-run `setup/supabase.sql`, or add the table under Database → Publications |
| An NPC change isn't showing | browser or CDN cache | wait 30 s; check the commit reached GitHub and Cloudflare Pages finished deploying |
| Page always in preview mode | the `CONFIG` placeholders are still in `app.js` | paste the real URL and publishable key |
