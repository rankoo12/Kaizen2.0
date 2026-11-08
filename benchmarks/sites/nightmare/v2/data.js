/* Nightmare — deterministic fixtures + the SEEDED latency table.
   Charter trap 1: "per-element randomized latency jitter (seeded,
   reproducible)". mulberry32 with a FIXED seed lives here, so every page
   load derives the exact same table: the site is hostile but reproducible,
   and a mutated version can retune one endpoint by editing one line. */
(function () {
  // ── Seeded RNG (mulberry32). The seed is a constant; never Date.now(). ────
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rng = mulberry32(20261102); // fixed seed (M8: v2 reseed) — reproducibility is the contract
  window.nightmareRng = rng;      // exposed so a future mutation reuses the stream

  // Draw helpers. GENERATION ORDER BELOW IS FIXED: reordering the keys would
  // silently change every delay, which would be a (reproducible) mutation.
  function wide() { return 300 + Math.floor(rng() * 7700); }   // 300–8000ms: content loads
  function snappy() { return 300 + Math.floor(rng() * 1200); } // 300–1500ms: user actions
  function brutal() { return 8001 + Math.floor(rng() * 3999); } // M8: 8-12s, drawn by exactly two widgets

  // Trap 1 — ONE named table governs every delay, interval and timer on the
  // site. Nothing calls setTimeout with a literal except through this table.
  window.NIGHTMARE_LATENCY_MS = {
    boot: 300,              // fixed: the shell appears predictably (trap 11 control flow)
    nest: brutal(),           // trap 3  — nested-iframes card (M8: pushed past 8s)
    rating: wide(),         // trap 4a — open-shadow rating widget
    vault: wide(),          // trap 4b — closed-shadow vault widget
    reactor: wide(),        // trap 5  — div-soup reactor row
    liveFeed: brutal(),       // trap 7  — volatile churn feed (M8: pushed past 8s)
    portal: wide(),         // trap 8  — portal-modal section
    captcha: wide(),        // trap 10 — fake captcha gate
    ledger: wide(),         // trap 9  — first ledger batch
    ledgerMore: snappy(),   // trap 9  — each further infinite-scroll batch
    pin: snappy(),          // trap 7  — pin action round-trip
    seal: snappy(),         // trap 8  — seal action round-trip
    verify: snappy(),       // trap 10 — the doomed verification
    churn: 900,             // trap 7  — feed re-render interval (fixed by charter)
    cookie: 3000,           // trap 6  — banner appears 3s after load (fixed by charter)
  };

  // The fake API: every widget fetches through here, so the table above is
  // the single throttle on the whole site.
  window.nightmareApi = function (name, payload) {
    var ms = window.NIGHTMARE_LATENCY_MS[name];
    if (ms == null) ms = 300;
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(payload); }, ms);
    });
  };

  window.NIGHTMARE_DATA = {
    // Trap 7 — the live feed's rows. Content never changes; only the DOM
    // nodes holding it are replaced every churn tick.
    liveFeed: [
      { id: 'lf-coolant', title: 'Coolant levels nominal', meta: 'reactor · now' },
      { id: 'lf-raven', title: 'Raven sighted over sector 7', meta: 'omens · 1m' },
      { id: 'lf-door', title: 'The east door is ajar again', meta: 'facilities · 2m' },
      { id: 'lf-chant', title: 'Chanting reported in sub-basement', meta: 'audio · 4m' },
      { id: 'lf-tea', title: 'Break room tea is lukewarm', meta: 'morale · 6m' },
    ],
    // Trap 5 — seven visually identical "buttons"; only index 2 is real (M1).
    reactorSlots: 7,
    reactorRealIndex: 2,
    // Trap 9 — 400 rows served in batches of 100; row 333 is the needle.
    ledgerTotal: 400,
    ledgerBatch: 100,
    hiddenLedgerRow: 333,
    ledgerLines: [
      'routine containment sweep',
      'inventory of unmarked crates',
      'candle budget reconciliation',
      'perimeter silence confirmed',
      'incident report misfiled on purpose',
      'echo count within tolerance',
      'void subscription renewal notice',
      'maintenance of the humming wall',
    ],
  };

  // Deterministic ledger row text; row 333 is the unique assertable needle
  // ("Entry #333 — relocated archive line" since M5), everything else cycles filler.
  window.nightmareLedgerText = function (n) {
    var D = window.NIGHTMARE_DATA;
    if (n === D.hiddenLedgerRow) return 'Entry #333 — relocated archive line';
    return 'Entry #' + n + ' — ' + D.ledgerLines[n % D.ledgerLines.length];
  };
})();
