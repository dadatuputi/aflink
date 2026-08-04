// Progressive enhancement for /analytics: the build ships a static 30-day
// view; this script unhides the range presets and re-renders the tiles and
// charts from the embedded JSON when a preset is chosen.
(function () {
  var dataEl = document.getElementById('analytics-data');
  var presets = document.getElementById('range-presets');
  if (!dataEl || !presets) return;

  var data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (e) {
    return; // leave the server-rendered view alone
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(s) { return Number(s.slice(6, 8)) + ' ' + MONTHS[Number(s.slice(4, 6)) - 1]; }
  function fmtNum(n) { return n.toLocaleString('en-US'); }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderTrend(days) {
    var window = data.daily.slice(-days);
    // Bucket long ranges so the chart keeps readable column widths
    var bucket = days > 120 ? 7 : 1;
    var buckets = [];
    for (var i = 0; i < window.length; i += bucket) {
      var users = 0;
      for (var j = i; j < Math.min(i + bucket, window.length); j++) users += window[j].users;
      buckets.push({ users: users, date: window[i].date });
    }
    var max = 1, maxIdx = 0;
    buckets.forEach(function (b, i) { if (b.users > max) { max = b.users; maxIdx = i; } });

    var chart = document.getElementById('trend-chart');
    chart.innerHTML = '';
    buckets.forEach(function (b, i) {
      var col = document.createElement('i');
      if (i === maxIdx) col.className = 'hi';
      col.style.height = Math.max(2, Math.round(b.users / max * 100)) + '%';
      col.title = (bucket > 1 ? 'week of ' : '') + fmtDate(b.date) + ': ' + fmtNum(b.users) +
        (i === maxIdx ? (bucket > 1 ? ' (busiest week)' : ' (busiest day)') : '');
      chart.appendChild(col);
    });

    setText('trend-title', bucket > 1 ? 'Weekly visitors' : 'Daily visitors');
    var axis = document.getElementById('trend-axis');
    if (axis && window.length) {
      axis.innerHTML = '';
      [window[0].date, window[window.length - 1].date].forEach(function (d) {
        var s = document.createElement('span');
        s.textContent = fmtDate(d);
        axis.appendChild(s);
      });
    }
  }

  function renderRank(id, rows, labelKey, withCategory) {
    var host = document.getElementById(id);
    if (!host) return;
    if (!rows.length) {
      host.textContent = 'No click data collected yet.';
      return;
    }
    var max = rows[0].clicks || 1;
    var wrap = document.createElement('div');
    wrap.className = 'rank';
    wrap.id = id;
    rows.forEach(function (row) {
      var r = document.createElement('div');
      r.className = 'r';
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = row[labelKey];
      if (withCategory && row.category) {
        var c = document.createElement('span');
        c.className = 'cat';
        c.textContent = row.category;
        t.appendChild(c);
      }
      var bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.width = Math.max(2, Math.round(row.clicks / max * 100)) + '%';
      var n = document.createElement('span');
      n.className = 'n';
      n.textContent = fmtNum(row.clicks);
      r.appendChild(t); r.appendChild(bar); r.appendChild(n);
      wrap.appendChild(r);
    });
    host.replaceWith(wrap);
  }

  function render(days) {
    var r = data.ranges[String(days)];
    if (!r) return;
    setText('stat-users', fmtNum(r.totals.users));
    setText('stat-pageviews', fmtNum(r.totals.pageviews));
    setText('stat-clicks', fmtNum(r.totals.linkClicks));
    renderTrend(days);
    renderRank('rank-links', r.topLinks.slice(0, 10), 'title', true);
    renderRank('rank-cats', r.categories, 'category', false);
  }

  // The build renders only the presets the data span supports; with a single
  // option there is nothing to switch, so the group stays hidden
  if (presets.querySelectorAll('button[data-range]').length > 1) {
    presets.hidden = false;
  }
  presets.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-range]');
    if (!btn) return;
    presets.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    render(Number(btn.getAttribute('data-range')));
  });
})();
