/* =============================================================
 * intake.js — RinkScore intake form
 *
 * Single long form -> nested JS object matching
 *   RINK/templates/intake_form.example.yaml (two top-level blocks:
 *   `meta:` and `tournament:`)
 *                  -> js-yaml dump
 *                  -> Blob download as <slug>_intake.yaml
 *
 * No backend, no autosave. Required gate:
 *   meta.theme, tournament.name, tournament.slug, tournament.points_scheme,
 *   tournament.hosting_organization, >=2 teams, >=1 rink venue.
 * ============================================================= */
(function () {
  'use strict';

  const form = document.getElementById('intake-form');
  if (!form) return;

  /* ---------------------------------------------------------------
   * Repeatable rows
   * ------------------------------------------------------------- */
  function wireRepeatable(root) {
    const name = root.getAttribute('data-repeatable')
              || root.getAttribute('data-repeatable-inline');
    const list = root.querySelector(':scope > [data-list]');
    const addBtn = root.querySelector(':scope > [data-add]');
    const tplId = 'tpl-' + name;
    const tpl = document.getElementById(tplId);
    if (!tpl) {
      console.warn('[intake] missing template:', tplId);
      return;
    }

    function add() {
      const node = tpl.content.firstElementChild.cloneNode(true);
      list.appendChild(node);
      node.querySelectorAll('[data-repeatable-inline]').forEach(wireRepeatable);
      node.querySelector('[data-remove]')?.addEventListener('click', () => {
        node.remove();
        refresh();
      });
      refresh();
    }

    if (addBtn) addBtn.addEventListener('click', add);
  }

  document.querySelectorAll('[data-repeatable]').forEach(wireRepeatable);

  /* ---------------------------------------------------------------
   * Slug auto-derive from tournament name.
   *   - As the client types the tournament name, slugify and write
   *     into the Short URL name field.
   *   - Once the client manually edits the Short URL name (any keystroke
   *     in that field), stop syncing so we don't clobber their override.
   *   - Setting .value programmatically does NOT fire the 'input' event,
   *     so the user-edit detector is reliable.
   * ------------------------------------------------------------- */
  (function () {
    const nameEl = form.querySelector('[name="tournament.name"]');
    const slugEl = form.querySelector('[name="tournament.slug"]');
    if (!nameEl || !slugEl) return;
    let slugManuallyEdited = false;
    const previewEl = document.getElementById('slug-preview');
    function updatePreview() {
      if (!previewEl) return;
      previewEl.textContent = slugEl.value || '<short-url-name>';
    }
    slugEl.addEventListener('input', () => {
      slugManuallyEdited = true;
      updatePreview();
    });
    nameEl.addEventListener('input', () => {
      if (slugManuallyEdited) return;
      slugEl.value = slugify(nameEl.value);
      updatePreview();
    });
    updatePreview();
  })();

  /* ---------------------------------------------------------------
   * Custom-domain question — two-tier conditional.
   *   wanted=yes   → reveal the "do you own one?" follow-up
   *   owns=yes     → reveal the Domain text input
   *   wanted=no    → hide both follow-up sections (and clear inner state)
   * ------------------------------------------------------------- */
  function updateCustomDomainVisibility() {
    const followup = document.getElementById('custom-domain-followup');
    const domainField = document.getElementById('custom-domain-field');
    if (!followup || !domainField) return;

    const wanted = form.querySelector('[name="custom_domain.wanted"]:checked');
    const wants = wanted && wanted.value === 'yes';
    followup.hidden = !wants;

    if (!wants) {
      // Reset inner state so a YAML built afterwards doesn't carry stale answers.
      form.querySelectorAll('[name="custom_domain.owns"]').forEach(r => { r.checked = false; });
      const dom = form.querySelector('[name="custom_domain.domain"]');
      if (dom) dom.value = '';
      domainField.hidden = true;
      return;
    }

    const owns = form.querySelector('[name="custom_domain.owns"]:checked');
    domainField.hidden = !owns;
  }
  form.querySelectorAll('[name="custom_domain.wanted"], [name="custom_domain.owns"]').forEach(r =>
    r.addEventListener('change', updateCustomDomainVisibility)
  );

  /* ---------------------------------------------------------------
   * Design section — two independent toggles.
   *   logo_status   = "need"  → reveal logo-direction textarea
   *   theme_status  = "have"  → reveal theme-pick dropdown
   *   theme_status  = "need"  → reveal theme-describe textarea
   * ------------------------------------------------------------- */
  function updateDesignVisibility() {
    const logoDir = document.getElementById('logo-direction-field');
    const themePick = document.getElementById('theme-pick-field');
    const themeDesc = document.getElementById('theme-describe-field');
    if (!logoDir || !themePick || !themeDesc) return;

    const logo = form.querySelector('[name="design.logo_status"]:checked');
    logoDir.hidden = !(logo && logo.value === 'need');

    const theme = form.querySelector('[name="design.theme_status"]:checked');
    themePick.hidden = !(theme && theme.value === 'have');
    themeDesc.hidden = !(theme && theme.value === 'need');
  }
  form.querySelectorAll('[name="design.logo_status"], [name="design.theme_status"]').forEach(r =>
    r.addEventListener('change', updateDesignVisibility)
  );

  /* ---------------------------------------------------------------
   * Teams — pool-count toggle.
   *   pool_count >= 2 → reveal "teams per pool", hide "total"
   *                   → reveal Pool / division field on each team card
   *   pool_count == 1 → reveal "total", hide "per pool"
   *                   → hide Pool / division on team cards
   *   pool_count blank → hide both follow-ups, hide pool field on cards
   * ------------------------------------------------------------- */
  function updateTeamsVisibility() {
    const perPool = document.getElementById('teams-per-pool-field');
    const total = document.getElementById('teams-total-field');
    if (!perPool || !total) return;
    const poolEl = form.querySelector('[name="teams.pool_count"]');
    const n = parseInt(poolEl?.value, 10);
    const multiPool = Number.isFinite(n) && n >= 2;
    const singlePool = Number.isFinite(n) && n === 1;
    perPool.hidden = !multiPool;
    total.hidden = !singlePool;
    document.querySelectorAll('.team-card .team-pool-field').forEach(el => {
      el.hidden = !multiPool;
    });
    autoAssignPools();
  }

  // Auto-distribute teams across pools — Pool A for the first per_pool
  // teams, Pool B for the next, and so on. Only fills BLANK pool fields,
  // so a user override survives subsequent autorun.
  function autoAssignPools() {
    const poolCount = parseInt(val('teams.pool_count'), 10);
    if (!Number.isFinite(poolCount) || poolCount < 2) return;
    const perPool = parseInt(val('teams.per_pool'), 10);
    if (!Number.isFinite(perPool) || perPool < 1) return;
    document.querySelectorAll('#teams-repeatable [data-list] > .team-card').forEach((card, idx) => {
      const trackEl = card.querySelector('[data-key="track"]');
      if (!trackEl) return;
      if (trackEl.value.trim() !== '') return;  // preserve user override
      const letter = String.fromCharCode(65 + Math.floor(idx / perPool));
      trackEl.value = 'Pool ' + letter;
    });
  }

  form.querySelector('[name="teams.pool_count"]')?.addEventListener('input', updateTeamsVisibility);
  form.querySelector('[name="teams.per_pool"]')?.addEventListener('input', autoAssignPools);
  // Also re-apply when a new team card is added (so the pool field on the
  // freshly-cloned card matches current pool_count state).
  document.getElementById('teams-repeatable')?.querySelector('[data-add]')
    ?.addEventListener('click', () => setTimeout(updateTeamsVisibility, 0));

  /* ---------------------------------------------------------------
   * Initial cards on page load — show one venue card so the user
   * doesn't have to click "+ Add venue" to see what's there.
   * ------------------------------------------------------------- */
  form.querySelector('[data-repeatable="tournament.venues"] [data-add]')?.click();

  /* ---------------------------------------------------------------
   * Game-schedule dropdowns — Away/Home pull team names from the
   * Teams section; Venue pulls rink names from the Venues section.
   * Repopulate on every input event AND when a new game card is
   * added. Selected values are preserved when the option list refreshes.
   * ------------------------------------------------------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function teamOptions() {
    return readRepeatableList('tournament.teams').filter(t => t.name).map(t => t.name);
  }
  function venueOptions() {
    return readRepeatableList('tournament.venues').filter(v => v.name && v.kind === 'rink').map(v => v.name);
  }
  function populateSelect(sel, options, placeholder) {
    const current = sel.value;
    sel.innerHTML =
      `<option value="">${placeholder}</option>` +
      options.map(o =>
        `<option value="${escapeHtml(o)}"${o === current ? ' selected' : ''}>${escapeHtml(o)}</option>`
      ).join('');
  }
  function refreshGameSelects() {
    const teams = teamOptions();
    const venues = venueOptions();
    document.querySelectorAll('#games-repeatable [data-list] > .game-card').forEach(card => {
      const away  = card.querySelector('[data-key="away"]');
      const home  = card.querySelector('[data-key="home"]');
      const venue = card.querySelector('[data-key="venue"]');
      // Exclude whatever team is picked on the opposite side so a team
      // can't accidentally be selected against itself.
      if (away && home) {
        const awayPick = away.value;
        const homePick = home.value;
        populateSelect(away, teams.filter(t => t !== homePick), '— choose team —');
        populateSelect(home, teams.filter(t => t !== awayPick), '— choose team —');
      }
      if (venue) populateSelect(venue, venues, '— choose venue —');

      // Game-type UI: when kind != round-robin, teams are optional (TBD until
      // round-robin standings determine matchups) and a custom label appears
      // for kind=other. Round-robin (default) keeps the strict team requirement.
      const kindEl  = card.querySelector('[data-key="kind"]');
      const labelEl = card.querySelector('.game-label-field');
      const kind    = kindEl ? kindEl.value : 'round-robin';
      const isMedal = kind && kind !== 'round-robin';
      card.querySelectorAll('.team-optional').forEach(el => { el.hidden = !isMedal; });
      if (labelEl) labelEl.hidden = (kind !== 'other');
    });
  }
  // Re-bind on every input — team/venue name changes flow through here.
  form.addEventListener('input', refreshGameSelects);
  // Re-bind when a new game card is added (the cloned card's selects start empty).
  document.getElementById('games-repeatable')?.querySelector('[data-add]')
    ?.addEventListener('click', () => setTimeout(refreshGameSelects, 0));

  /* ---------------------------------------------------------------
   * Field harvesting
   * ------------------------------------------------------------- */
  function val(name) {
    const el = form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (!el) return '';
    return (el.value || '').trim();
  }

  function readItem(item) {
    const out = {};
    item.querySelectorAll('[data-key]').forEach(el => {
      const key = el.getAttribute('data-key');
      if (el.type === 'checkbox') {
        out[key] = !!el.checked;
      } else {
        out[key] = (el.value || '').trim();
      }
    });
    return out;
  }

  function readRepeatableList(name) {
    const root = form.querySelector(`[data-repeatable="${CSS.escape(name)}"]`);
    if (!root) return [];
    const items = root.querySelectorAll(':scope > [data-list] > .repeat-item');
    return Array.from(items).map(readItem);
  }

  function dropEmpty(rows, primary) {
    return rows.filter(r => r[primary] && String(r[primary]).trim().length > 0);
  }

  // Strip empty-string / null / undefined values from an object so the YAML
  // doesn't carry blank lines for every untouched optional field.
  function pruneEmpty(obj) {
    const out = {};
    for (const k in obj) {
      const v = obj[k];
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' && v.trim() === '') continue;
      out[k] = v;
    }
    return out;
  }

  /* ---------------------------------------------------------------
   * Build payload — `tournament:` block only.
   *
   * The `meta:` block (theme, year, target, custom_domain) is in-house
   * scaffolding data, NOT client information. Heewon prepends it on
   * his end before running `/RINK scaffold`.
   * ------------------------------------------------------------- */
  function build() {
    const teams = dropEmpty(readRepeatableList('tournament.teams'), 'name').map(t => {
      const obj = {
        name:        t.name,
        hometown:    t.hometown || '',
        description: t.description || '',
        track:       t.track || '',
      };
      // Optional lat/lon — emit only when both are filled in (and parse as numbers).
      // If omitted, the auditor geocodes from `hometown` via Nominatim (auditor §3a).
      const lat = parseFloat(t.lat);
      const lon = parseFloat(t.lon);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) { obj.lat = lat; obj.lon = lon; }
      return obj;
    });

    const venues = dropEmpty(readRepeatableList('tournament.venues'), 'name').map(v => ({
      kind:    v.kind || 'rink',
      name:    v.name,
      city:    v.city || '',
      address: v.address || '',
    }));

    // Games — round-robin needs at least 'away'; medal/other games may have
    // TBD teams (the round-robin decides the matchup), so keep the row if it
    // has any timeslot or venue committed.
    const games = readRepeatableList('tournament.games').filter(g => {
      const isMedal = g.kind && g.kind !== 'round-robin';
      if (isMedal) return !!(g.date || g.time || g.venue);
      return !!g.away;
    }).map(g => {
      const isMedal = g.kind && g.kind !== 'round-robin';
      const game = {
        away:  g.away || (isMedal ? 'TBD' : ''),
        home:  g.home || (isMedal ? 'TBD' : ''),
        date:  g.date || '',
        time:  g.time || '',
        venue: g.venue || '',
        ice:   g.ice || '',
      };
      if (g.kind === 'bronze') game.medal = 'bronze';
      if (g.kind === 'gold')   game.medal = 'gold';
      if (g.kind === 'other' && g.label) game.label = g.label;
      return game;
    });

    // Events — bulletin-board entries (welcome reception, team dinner, awards
    // banquet, etc.). Only `name` is required; date/time/venue/address are
    // optional. Map intake `time` → gem `start_time` to match the gem schema.
    const events = dropEmpty(readRepeatableList('tournament.events'), 'name').map(e => ({
      name:       e.name,
      date:       e.date    || '',
      start_time: e.time    || '',
      venue:      e.venue   || '',
      address:    e.address || '',
    }));

    const fundraisers = dropEmpty(readRepeatableList('tournament.fundraisers'), 'title').map(f => ({
      title:     f.title,
      kind:      f.kind || 'fundraiser',
      where_how: f.where_how || '',
      link:      f.link || '',
    }));

    const sponsors = dropEmpty(readRepeatableList('tournament.sponsors'), 'name').map(s => ({
      name: s.name,
      link: s.link || '',
    }));

    const social = dropEmpty(readRepeatableList('tournament.social'), 'url').map(s => ({
      platform: s.platform || 'other',
      url:      s.url,
    }));

    // Build the tournament block with only fields the client actually filled.
    // pruneEmpty drops empty strings so the YAML doesn't carry blank lines
    // for every untouched optional field.
    const tournament = pruneEmpty({
      name:                 val('tournament.name'),
      slug:                 val('tournament.slug'),
      tagline:              val('tournament.tagline'),
      established:          val('tournament.established'),
      edition:              val('tournament.edition'),
      age_division:         val('tournament.age_division'),
      skill_tier:           val('tournament.skill_tier'),
      hosting_organization: val('tournament.hosting_organization'),
      sanctioning_body:     val('tournament.sanctioning_body'),
    });
    if (teams.length)       tournament.teams       = teams;
    if (venues.length)      tournament.venues      = venues;
    if (games.length)       tournament.games       = games;
    if (events.length)      tournament.events      = events;
    if (fundraisers.length) tournament.fundraisers = fundraisers;
    if (sponsors.length)    tournament.sponsors    = sponsors;
    if (social.length)      tournament.social      = social;

    // Design block — logo + theme intent from the Design fieldset.
    const design = {};
    const logoStatus = form.querySelector('[name="design.logo_status"]:checked')?.value;
    if (logoStatus) {
      design.logo_status = logoStatus;
      if (logoStatus === 'need') {
        const dir = val('design.logo_direction');
        if (dir) design.logo_direction = dir;
      }
    }
    const themeStatus = form.querySelector('[name="design.theme_status"]:checked')?.value;
    if (themeStatus) {
      design.theme_status = themeStatus;
      if (themeStatus === 'have') {
        const t = val('design.theme');
        if (t) design.theme = t;
      } else if (themeStatus === 'need') {
        const td = val('design.theme_description');
        if (td) design.theme_description = td;
      }
    }

    const payload = { tournament };
    if (Object.keys(design).length) payload.design = design;
    return payload;
  }

  function slugify(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  /* ---------------------------------------------------------------
   * Required gate
   * ------------------------------------------------------------- */
  function missingRequired() {
    const missing = [];

    // --- Web address / URL ---
    const customDomainAnswer = form.querySelector('[name="custom_domain.wanted"]:checked')?.value;
    if (!customDomainAnswer) missing.push('custom URL answer');
    const wantsCustomDomain = customDomainAnswer === 'yes';
    if (wantsCustomDomain) {
      const ownsAnswer = form.querySelector('[name="custom_domain.owns"]:checked')?.value;
      if (!ownsAnswer) missing.push('domain ownership answer');
      if (!val('custom_domain.domain')) missing.push('domain');
    }

    // --- Tournament identity ---
    if (!val('tournament.name')) missing.push('tournament name');
    // Short URL name is only required when there's no custom domain.
    if (!wantsCustomDomain && !val('tournament.slug')) missing.push('short URL name');
    if (!val('tournament.hosting_organization')) missing.push('hosting organization');

    // --- Design ---
    const logoStatus = form.querySelector('[name="design.logo_status"]:checked')?.value;
    if (!logoStatus) missing.push('logo answer');
    if (logoStatus === 'need' && !val('design.logo_direction')) missing.push('logo direction');
    const themeStatus = form.querySelector('[name="design.theme_status"]:checked')?.value;
    if (!themeStatus) missing.push('theme answer');
    if (themeStatus === 'have' && !val('design.theme')) missing.push('theme pick');
    if (themeStatus === 'need' && !val('design.theme_description')) missing.push('theme description');

    // --- Teams & Venues ---
    const teamRows = readRepeatableList('tournament.teams').filter(t => t.name);
    if (teamRows.length < 2) missing.push('at least 2 teams');
    // Each named team must have an intro filled in.
    const teamsMissingIntro = teamRows.filter(t => !t.description).length;
    if (teamsMissingIntro > 0) missing.push('team intro for ' + teamsMissingIntro + ' team(s)');
    const venueRows = readRepeatableList('tournament.venues');
    const rinks = venueRows.filter(v => v.name && v.kind === 'rink');
    if (rinks.length < 1) missing.push('at least 1 rink venue');
    // Any venue row with partial data is invalid (must have name + city + address together).
    const partialVenues = venueRows.filter(v => {
      const any = v.name || v.city || v.address;
      const all = v.name && v.city && v.address;
      return any && !all;
    }).length;
    if (partialVenues > 0) missing.push('name + city + address for ' + partialVenues + ' venue(s)');

    // --- Teams count consistency ---
    const poolCount = parseInt(val('teams.pool_count'), 10);
    if (Number.isFinite(poolCount)) {
      if (poolCount === 1 && !val('teams.total')) missing.push('total team count');
      if (poolCount >= 2 && !val('teams.per_pool')) missing.push('teams per pool');

      let expectedTotal = 0;
      if (poolCount === 1) {
        const total = parseInt(val('teams.total'), 10);
        if (Number.isFinite(total)) expectedTotal = total;
      } else if (poolCount >= 2) {
        const perPool = parseInt(val('teams.per_pool'), 10);
        if (Number.isFinite(perPool)) expectedTotal = poolCount * perPool;
      }
      if (expectedTotal > 0 && teamRows.length !== expectedTotal) {
        missing.push('team count mismatch (you said ' + expectedTotal + ', registered ' + teamRows.length + ')');
      }

      // Multi-pool only: every team needs a pool assigned, and each pool
      // must have exactly per_pool teams.
      if (poolCount >= 2) {
        const teamsWithoutPool = teamRows.filter(t => !t.track).length;
        if (teamsWithoutPool > 0) missing.push('pool assignment for ' + teamsWithoutPool + ' team(s)');

        const perPool = parseInt(val('teams.per_pool'), 10);
        if (Number.isFinite(perPool)) {
          const byPool = {};
          teamRows.forEach(t => {
            const p = (t.track || '').trim();
            if (p) byPool[p] = (byPool[p] || 0) + 1;
          });
          const wrong = Object.entries(byPool).filter(([_, n]) => n !== perPool);
          if (wrong.length > 0) {
            const detail = wrong.map(([p, n]) => p + ': ' + n + '/' + perPool).join(', ');
            missing.push('pool size mismatch (' + detail + ')');
          }
        }
      }
    }

    // --- Game schedule completeness ---
    // A team can't play itself (skip medal/playoff games where teams may be TBD).
    const allGameRows = readRepeatableList('tournament.games');
    const sameTeamGames = allGameRows.filter(g => {
      const isMedal = g.kind && g.kind !== 'round-robin';
      return !isMedal && g.away && g.home && g.away === g.home;
    }).length;
    if (sameTeamGames > 0) missing.push(sameTeamGames + ' game(s) with same team on both sides');

    // Each event row with any data must have at minimum the event name (the
    // bulletin-board headline). Date/time/venue/address are all optional.
    const eventRowsWithDataNoName = readRepeatableList('tournament.events').filter(e => {
      const any = e.date || e.time || e.venue || e.address;
      return any && !e.name;
    }).length;
    if (eventRowsWithDataNoName > 0) missing.push(eventRowsWithDataNoName + ' event(s) missing an event name');

    // Each game card that has any data must have its required fields:
    //   - Round robin: away + home + date + time + venue (ice optional).
    //   - Medal/other: date + time + venue (teams optional, decided by round-robin standings).
    //   - kind=other ALSO needs a non-empty label.
    const incompleteGames = allGameRows.filter(g => {
      const isMedal = g.kind && g.kind !== 'round-robin';
      const any = g.away || g.home || g.date || g.time || g.venue || g.ice || g.label;
      if (!any) return false;
      if (isMedal) {
        const all = g.date && g.time && g.venue && (g.kind !== 'other' || g.label);
        return !all;
      }
      const all = g.away && g.home && g.date && g.time && g.venue;
      return !all;
    }).length;
    if (incompleteGames > 0) missing.push('complete info for ' + incompleteGames + ' game(s)');

    return missing;
  }

  /* ---------------------------------------------------------------
   * Warnings — checked on Download click, surfaced as a confirm()
   * dialog. Non-blocking: user can choose to proceed.
   *
   *   - Round-robin shortfall: actual games < expected RR minimum
   *   - Schedule conflicts: same team in two games at the same slot
   *   - Venue conflicts: same venue+ice at the same slot
   *
   * Round-robin: a venue can have multiple sheets, so we don't block
   * venue overlap — but flag it. Same for team overlap (a team can't
   * physically play two games at once, but data entry mistakes happen).
   * ------------------------------------------------------------- */
  function gatherWarnings() {
    const warnings = [];
    const teams = readRepeatableList('tournament.teams').filter(t => t.name);
    // Round-robin count compares against expected matchups — exclude medal/playoff
    // games (kind != round-robin) since their team selections may be TBD.
    const rrGames = readRepeatableList('tournament.games')
      .filter(g => (!g.kind || g.kind === 'round-robin') && g.away && g.home);
    const allRealGames = readRepeatableList('tournament.games')
      .filter(g => g.away && g.home);
    const poolCount = parseInt(val('teams.pool_count'), 10);

    // Expected round-robin minimum.
    let expectedRR = 0;
    if (poolCount === 1) {
      expectedRR = teams.length * (teams.length - 1) / 2;
    } else if (poolCount >= 2) {
      const byPool = {};
      teams.forEach(t => {
        const p = (t.track || '').trim();
        if (p) byPool[p] = (byPool[p] || 0) + 1;
      });
      expectedRR = Object.values(byPool).reduce((sum, n) => sum + n * (n - 1) / 2, 0);
    }
    if (expectedRR > 0 && rrGames.length < expectedRR) {
      warnings.push(
        'Only ' + rrGames.length + ' round-robin games entered. A single round-robin requires ' +
        expectedRR + ' games. Are some matchups missing?'
      );
    }

    // Schedule conflicts — same team in two games at the same date+time.
    // Skip medal/playoff games (TBD teams can't conflict).
    const teamSlots = {};
    allRealGames.forEach((g, i) => {
      if (g.kind && g.kind !== 'round-robin') return;
      if (!g.date || !g.time) return;
      const slot = g.date + ' ' + g.time;
      [g.away, g.home].forEach(team => {
        if (!team || team === 'TBD') return;
        const key = team + '@@' + slot;
        if (!teamSlots[key]) teamSlots[key] = [];
        teamSlots[key].push(i + 1);
      });
    });
    Object.entries(teamSlots).forEach(([key, gameNums]) => {
      if (gameNums.length > 1) {
        const [team, slot] = key.split('@@');
        warnings.push(team + ' is scheduled in games ' + gameNums.join(', ') + ' at the same time (' + slot + ').');
      }
    });

    // Venue+ice conflicts — same sheet in two games at the same slot.
    // Use ALL games (including medal/TBD) because ice time + venue are booked
    // in advance regardless of which teams play.
    const venueSlots = {};
    const allGamesForVenueCheck = readRepeatableList('tournament.games');
    allGamesForVenueCheck.forEach((g, i) => {
      if (!g.date || !g.time || !g.venue) return;
      const slot = g.date + ' ' + g.time;
      const key = g.venue + ' / ' + (g.ice || '(no ice specified)') + '@@' + slot;
      if (!venueSlots[key]) venueSlots[key] = [];
      venueSlots[key].push(i + 1);
    });
    Object.entries(venueSlots).forEach(([key, gameNums]) => {
      if (gameNums.length > 1) {
        const [where, slot] = key.split('@@');
        warnings.push('Venue conflict: ' + where + ' is double-booked at ' + slot + ' (games ' + gameNums.join(', ') + ').');
      }
    });

    return warnings;
  }

  /* ---------------------------------------------------------------
   * Render / download
   * ------------------------------------------------------------- */
  function toYaml(payload) {
    return jsyaml.dump(payload, { lineWidth: 100, noRefs: true, sortKeys: false });
  }

  function setStatus(msg, cls) {
    const s = document.getElementById('form-status');
    if (s) {
      s.textContent = msg;
      s.className = 'status' + (cls ? ' ' + cls : '');
    } else if (cls === 'error') {
      // Status pill removed from the page — surface blocking errors via alert
      // so the user still gets feedback when Download is clicked.
      alert(msg);
    }
  }

  function previewYaml() {
    document.getElementById('yaml-preview').textContent = toYaml(build());
  }

  function refresh() {
    const missing = missingRequired();
    if (missing.length === 0) {
      setStatus('Ready to download.', 'ok');
    } else {
      setStatus('Required: ' + missing.join(', ') + '.', '');
    }
    previewYaml();
    updatePackageChecklist();
  }

  /* ---------------------------------------------------------------
   * Package checklist — dynamic list of files the host needs to email
   * alongside the YAML. Re-computed on every input change.
   *
   *   Always:      the downloaded YAML
   *   Conditional: tournament logo (only if "have one")
   *                team logos (one per named team)
   *                sponsor logos (one per named sponsor)
   *                hero banner (always optional)
   * ------------------------------------------------------------- */
  function updatePackageChecklist() {
    const box = document.getElementById('package-checklist');
    if (!box) return;

    const tname = val('tournament.name');
    // Filename + URL preview both use the Short URL name only (not the
    // tournament's full name) so Heewon can compare incoming filenames
    // against existing slugs to spot URL conflicts.
    const slug = slugify(val('tournament.slug')) || 'tournament';

    const items = [];

    items.push(
      'The downloaded file <code>' + escapeHtml(slug) + '_intake.yaml</code>'
    );

    items.push(
      'Tournament handbook (PDF) — we use this to set up <strong>your tie-breaker rules</strong>.'
    );

    const logoStatus = form.querySelector('[name="design.logo_status"]:checked')?.value;
    if (logoStatus === 'have') {
      items.push('Tournament logo — SVG preferred, or high-res PNG');
    }

    const teams = readRepeatableList('tournament.teams').filter(t => t.name);
    teams.forEach(t => {
      items.push('Team logo for <strong>' + escapeHtml(t.name) + '</strong>');
    });

    const sponsors = readRepeatableList('tournament.sponsors').filter(s => s.name);
    sponsors.forEach(s => {
      items.push('<em>(optional)</em> Sponsor logo for <strong>' + escapeHtml(s.name) + '</strong>');
    });

    // Show the image-naming note ONLY when the checklist actually contains
    // image items (tournament logo, team logos, or sponsor logos).
    const hasImages = (logoStatus === 'have') || teams.length > 0 || sponsors.length > 0;
    const note = hasImages
      ? '<p class="checklist-note">' +
          'A small ask: please name each image file so it\'s clear which team or sponsor it belongs to ' +
          '(e.g. <code>calgary-flames.png</code>).' +
        '</p>'
      : '';

    box.innerHTML =
      '<div class="checklist-head">' +
        '<p>Thanks for choosing RinkScore! To get started, please send the complete package below to ' +
        '<a href="mailto:hello@rinkscore.ca"><strong>hello@rinkscore.ca</strong></a>. ' +
        'We\'ll get back to you within 72 hours. Thank you!</p>' +
        '<button type="button" id="print-checklist-btn" class="btn-mini">Print checklist</button>' +
      '</div>' +
      '<ul class="checklist-items">' +
      items.map(i =>
        '<li><label><input type="checkbox"><span>' + i + '</span></label></li>'
      ).join('') +
      '</ul>' +
      note;

    // Re-bind print handler each refresh (innerHTML wipes the previous one).
    document.getElementById('print-checklist-btn')
      ?.addEventListener('click', () => printChecklist(items, tname));
  }

  /* ---------------------------------------------------------------
   * Print only the package checklist (not the whole intake page).
   * Opens a new window with a clean printable version, triggers
   * print, and closes afterwards.
   * ------------------------------------------------------------- */
  function printChecklist(items, tournamentName) {
    const win = window.open('', '_blank');
    if (!win) return;
    const title = (tournamentName ? escapeHtml(tournamentName) + ' — ' : '') +
                  'RinkScore email package checklist';
    win.document.write(
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>' + title + '</title>' +
      '<style>' +
        'body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#14171a;max-width:680px;margin:2rem auto;padding:0 1.5rem;}' +
        'h1{font-size:1.3rem;margin:0 0 0.4rem;}' +
        '.sub{color:#7a838c;margin:0 0 1.5rem;font-size:0.95rem;}' +
        'ul{list-style:none;padding:0;margin:0;}' +
        'li{margin:0.7rem 0;display:flex;align-items:flex-start;gap:0.7rem;}' +
        'li::before{content:"\\2610";font-size:1.4rem;line-height:1;}' +
        'code{background:#f0f2f5;padding:0.05rem 0.4rem;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em;}' +
        '@media print { body { margin: 1rem auto; } }' +
      '</style>' +
      '</head><body>' +
      '<h1>Email package checklist</h1>' +
      '<p class="sub">Send to <strong>hello@rinkscore.ca</strong>' +
      (tournamentName ? ' for <strong>' + escapeHtml(tournamentName) + '</strong>' : '') + '</p>' +
      '<ul>' + items.map(i => '<li><span>' + i + '</span></li>').join('') + '</ul>' +
      '<script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};};<\/script>' +
      '</body></html>'
    );
    win.document.close();
  }

  function downloadYaml() {
    const missing = missingRequired();
    if (missing.length) {
      alert('Missing required:\n\n• ' + missing.join('\n• '));
      return;
    }
    const warnings = gatherWarnings();
    if (warnings.length) {
      const proceed = confirm(
        'Heads up — please review:\n\n• ' + warnings.join('\n• ') +
        '\n\nDownload anyway?'
      );
      if (!proceed) return;
    }
    const payload = build();
    const yaml = toYaml(payload);
    // Filename = Short URL name (not tournament's full name) so an incoming
    // YAML filename can be compared 1:1 against existing tournament slugs
    // to spot URL conflicts before scaffolding.
    const slug = slugify(val('tournament.slug')) || 'tournament';
    const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = slug + '_intake.yaml';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus('Downloaded ' + a.download + ' — email it to hello@rinkscore.ca with your assets.', 'ok');
  }

  document.getElementById('download-btn').addEventListener('click', downloadYaml);
  form.addEventListener('input', refresh);
  refresh();
})();
