$(document).ready(function () {

  const searchParams = new URLSearchParams(window.location.search);

  function updateSearchParams(newParams) {
    var params = ""
    if (newParams) {
      searchParams.set("q", newParams);
      params = '?'+searchParams.toString()
    } else {
      searchParams.delete("q")
    }
    var newurl = window.location.origin+window.location.pathname+params
    window.history.replaceState({ path: newurl }, "", newurl);
  }

  // If search string has a hidden space anywhere inside it, it comes from autocomplete, so automatically go to the first result
  // https://bugzilla.mozilla.org/show_bug.cgi?id=386591#c32
  const autocompleted = (searchParams.has("q") && searchParams.get("q").includes('​'));
  
  // Show modal after clicking a link
  const my_modal = new bootstrap.Modal(document.getElementById('exit-modal'), {focus: false});
  $("#link-list .list-group-item a:first-child, #unofficial-list .list-group-item a:first-child").on('click', function(event) {
    $('#exit-modal .modal-header .title').text($(this).text());
    $('#exit-modal .link').text($(this).prop('href'));
    my_modal.toggle();
  });

  // Normalize a string for search: lowercase, accents folded, punctuation and
  // spaces dropped — so "e-mail" matches "eMail" and "af portal" matches
  // "AF Portal". Returns the normalized string plus a map from each normalized
  // character back to its index in the original, for match highlighting.
  function normalize(s) {
    var norm = "", map = [];
    for (var i = 0; i < s.length; i++) {
      var c = s[i].toLowerCase().normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");
      for (var j = 0; j < c.length; j++) {
        norm += c[j];
        map.push(i);
      }
    }
    return { norm: norm, map: map };
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  // Rebuild the title anchor's content with <mark> around the given original-
  // string index ranges (merged, in order). Ranges are [start, end] inclusive.
  function highlight($a, text, ranges) {
    ranges.sort(function (x, y) { return x[0] - y[0]; });
    var merged = [];
    ranges.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    });
    var html = "", pos = 0;
    merged.forEach(function (r) {
      html += escapeHtml(text.slice(pos, r[0])) + "<mark>" + escapeHtml(text.slice(r[0], r[1] + 1)) + "</mark>";
      pos = r[1] + 1;
    });
    $a.html(html + escapeHtml(text.slice(pos)));
  }

  // Filter links based on search query
  $("#search-form").on(
    "change keyup paste search",
    function (event) {
      var value = $(this).val().toLowerCase();

      // Every whitespace-separated word must match. A word matches on its whole
      // normalized form ("e-mail" → "email"), or failing that on all of its
      // multi-character punctuation-separated parts ("mail"; the lone "e" is
      // dropped so single characters never match on their own).
      var words = value.split(/\s+/).filter(Boolean).map(function (w) {
        return {
          whole: normalize(w).norm,
          parts: w.split(/[^a-z0-9]+/).map(function (p) { return normalize(p).norm; })
            .filter(function (p) { return p.length > 1; })
        };
      }).filter(function (w) { return w.whole; });

      // Hide everything
      $('#link-list .category, #link-list .link-container, #unofficial-list .link-container').toggle(false);

      // Show links where every word matches the title or the URL,
      // highlighting title matches
      var links = $('#link-list .link-container, #unofficial-list .link-container').filter(function(){
        var $a = $(this).find('a:first-child');
        var text = $a.text();
        var title = normalize(text);
        var url = normalize(($a.attr('href') || "").replace(/^https?:\/\//, "")).norm;
        // Tokens can also match the row's category name ("education" shows the
        // whole category); unofficial rows have no .category sibling and match
        // as "unofficial"
        var cat = normalize($(this).siblings('.category').text() || "unofficial").norm;
        var ranges = [];
        var ok = words.every(function (w) {
          var p = title.norm.indexOf(w.whole);
          if (p > -1) {
            ranges.push([title.map[p], title.map[p + w.whole.length - 1]]);
            return true;
          }
          if (url.indexOf(w.whole) > -1 || cat.indexOf(w.whole) > -1) return true;
          if (!w.parts.length) return false;
          var partRanges = [];
          var all = w.parts.every(function (t) {
            var q = title.norm.indexOf(t);
            if (q > -1) {
              partRanges.push([title.map[q], title.map[q + t.length - 1]]);
              return true;
            }
            return url.indexOf(t) > -1 || cat.indexOf(t) > -1;
          });
          if (all) {
            ranges.push.apply(ranges, partRanges);
            return true;
          }
          return false;
        });
        if (ok && ranges.length) highlight($a, text, ranges);
        else $a.text(text);
        return ok;
      })

      // Go to first link if autocomplete
      if (autocompleted && links[0]) {
        $(links[0]).find('a.main-link')[0].click();
      }
      links.toggle(true);

      // Show link category
      links.siblings('.category').toggle(true);

      // Hide the unofficial section entirely when none of its links match.
      // Count matches from the filter result, not :visible — rows inside the
      // hidden section always measure invisible, which would latch it hidden.
      $('#unofficial').toggle(links.filter('#unofficial-list .link-container').length > 0);

      // Update URL with new search params
      updateSearchParams($(this).val())

      // If no links displayed, show alert
      if (!$("#link-list a:visible, #unofficial-list a:visible")[0]) {
        $("#list p").removeAttr('hidden');
        $("#list p em").text(value);
      } else {
        $("#list p").attr('hidden','hidden');
      }

      // On enter keypress, follow first link (official list first in DOM order)
      if (
        value &&
        event.type === "keyup" &&
        event.originalEvent.key === "Enter"
      ) {
        var first = $("#link-list a:visible, #unofficial-list a:visible")[0];
        if (first) {
          first.click();
        }
      }
    }
  );

  // Update search field based on parameters on pageload
  if (searchParams.has("q") === true) {
    if (autocompleted) {
      // Remove all the characters after the hidden space, inclusive
      const query = searchParams.get("q");
      const cleanQuery = query.slice(0, query.indexOf('​'));
      searchParams.set("q", cleanQuery);
    }

    $("#search-form").val(searchParams.get("q")).change();
  }

});