/* Relay Ops — deliberately late-rendering vanilla JS.
   Dashboard: skeleton cards resolve to KPIs after ~800ms; the refresh button
   arrives in the same batch. Deliveries: rows stream in chunks, search
   filters live, clicking a row opens a detail panel. */

var RENDER_DELAY_MS = 800;

// ── Dashboard ────────────────────────────────────────────────────────────────
var kpiCards = document.getElementById('kpi-cards');
if (kpiCards) {
  setTimeout(function () {
    function fill(id, label, value) {
      var card = document.getElementById(id);
      card.className = 'card';
      card.innerHTML = '<h3>' + label + '</h3><p class="kpi">' + value + '</p>';
    }
    fill('kpi-open', 'Open deliveries', '12');
    fill('kpi-ontime', 'On-time rate', '96%');
    fill('kpi-fleet', 'Fleet in service', '8');

    var area = document.getElementById('refresh-area');
    area.innerHTML = '<button class="btn" id="refresh-stats">Refresh stats</button>'
      + '<p class="status ok hidden" id="refresh-status" role="status">Stats refreshed just now.</p>';
    document.getElementById('refresh-stats').addEventListener('click', function () {
      document.getElementById('refresh-status').classList.remove('hidden');
    });
  }, RENDER_DELAY_MS);
}

// ── Deliveries ───────────────────────────────────────────────────────────────
var rowsHost = document.getElementById('delivery-rows');
if (rowsHost) {
  var COURIERS = ['Amara', 'Ben', 'Carla', 'Dev', 'Elin'];
  var CITIES = ['Lisbon', 'Osaka', 'Austin', 'Oslo'];
  var STATUSES = ['in transit', 'delivered', 'at depot'];
  var DELIVERIES = [];
  for (var i = 1; i <= 20; i++) {
    DELIVERIES.push({
      id: 1000 + i,
      courier: COURIERS[i % COURIERS.length],
      city: CITIES[i % CITIES.length],
      status: STATUSES[i % STATUSES.length],
    });
  }

  function rowText(d) { return 'Delivery #' + d.id + ' — ' + d.courier + ' · ' + d.city; }

  function renderRows(filter) {
    rowsHost.innerHTML = '';
    var q = (filter || '').toLowerCase();
    var shown = DELIVERIES.filter(function (d) {
      return !q || d.courier.toLowerCase().indexOf(q) >= 0 || d.city.toLowerCase().indexOf(q) >= 0;
    });
    shown.forEach(function (d) {
      var li = document.createElement('li');
      li.id = 'row-' + d.id;
      li.textContent = rowText(d);
      li.addEventListener('click', function () {
        document.getElementById('detail-panel').classList.remove('hidden');
        document.getElementById('detail-title').textContent = 'Delivery #' + d.id;
        document.getElementById('detail-copy').textContent =
          d.courier + ' is carrying this one to ' + d.city + ' — currently ' + d.status + '.';
      });
      rowsHost.appendChild(li);
    });
    document.getElementById('list-state').textContent = shown.length + ' deliveries shown';
  }

  // Chunked initial render: 5 rows per 120ms tick after the base delay —
  // the list literally grows while a fast assertion could be looking at it.
  setTimeout(function () {
    var chunk = 0;
    var timer = setInterval(function () {
      chunk++;
      rowsHost.innerHTML = '';
      DELIVERIES.slice(0, chunk * 5).forEach(function (d) {
        var li = document.createElement('li');
        li.id = 'row-' + d.id;
        li.textContent = rowText(d);
        rowsHost.appendChild(li);
      });
      if (chunk * 5 >= DELIVERIES.length) {
        clearInterval(timer);
        renderRows(''); // final render wires click handlers + count line
        var search = document.getElementById('delivery-search');
        search.addEventListener('input', function () { renderRows(search.value); });
      }
    }, 120);
  }, RENDER_DELAY_MS);
}
