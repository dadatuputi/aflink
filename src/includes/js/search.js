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

  // A suggestion is "<title>​ {CATEGORY}" (see search_worker/src/index.js).
  // Both halves matter: the title becomes the query, and the category picks the
  // right row when several links share a title or contain each other's names —
  // without it, choosing "milSuite" in the address bar can open a different link
  // that merely matched first.
  var picked = { title: null, category: null };
  if (autocompleted) {
    var raw = searchParams.get("q");
    var split = raw.indexOf('​');
    picked.title = raw.slice(0, split);
    var tail = raw.slice(split).match(/\{(.*)\}\s*$/);
    picked.category = tail ? tail[1] : null;
  }
  
  // Show modal after clicking a link
  const my_modal = new bootstrap.Modal(document.getElementById('exit-modal'), {focus: false});
  $("#link-list .list-group-item a:first-child, #unofficial-list .list-group-item a:first-child").on('click', function(event) {
    var href = $(this).prop('href');
    $('#exit-modal .modal-header .title').text($(this).text());
    // The URL doubles as a working link: the navigation this click starts can
    // hang for a long time on a slow destination, and the modal is the only
    // thing on screen at that point. title= carries the full URL because the
    // display is truncated with an ellipsis.
    $('#exit-modal .link a').attr({ href: href, title: href }).text(href);

    // Record which link was used so the analytics page can rank resources.
    // Anonymous event; gtag delivers via sendBeacon so navigation isn't delayed.
    if (typeof gtag === 'function') {
      var $cat = $(this).closest('.link-container').siblings('.category');
      gtag('event', 'link_click', {
        link_title: $(this).text(),
        link_url: this.href,
        link_category: $cat.length ? ($cat.data('orig-text') || $cat.text()) : 'UNOFFICIAL'
      });
    }

    my_modal.show();
  });

  // Coming back (Back button, bfcache restore) can hand us the page with the
  // modal still up, and toggle() would then hide it on the next click instead
  // of showing it. Always start from hidden; hide() is a no-op when it is.
  $(window).on('pageshow', function () {
    my_modal.hide();
  });

  // Matching rules live in search-match.js, which the autocomplete worker
  // imports too — keeping address-bar suggestions and on-page results in
  // agreement. Change matching there, never here.
  var parseQuery = AflinkSearch.parseQuery;
  var matchLink = AflinkSearch.matchLink;
  var matchRanges = AflinkSearch.matchRanges;

  function sameText(a, b) {
    return String(a == null ? "" : a).trim().toLowerCase() ===
      String(b == null ? "" : b).trim().toLowerCase();
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

  // Remember pristine header text: search decorates headers with a highlight
  // and a CATEGORY MATCH pill, and matching must read the original text
  $('#link-list .category, #unofficial h2').each(function () {
    $(this).data('orig-text', $(this).text());
  });

  // Filter links based on search query
  $("#search-form").on(
    "change keyup paste search",
    function (event) {
      var value = $(this).val().toLowerCase();

      // Every whitespace-separated word must match; see search-match.js
      var words = parseQuery(value);

      // Hide everything
      $('#link-list .category, #link-list .link-container, #unofficial-list .link-container').toggle(false);

      // Show links where every word matches the title or the URL,
      // highlighting title matches
      var links = $('#link-list .link-container, #unofficial-list .link-container').filter(function(){
        var $a = $(this).find('a:first-child');
        var text = $a.text();
        // Words can also match the row's category name ("education" shows the
        // whole category); unofficial rows have no .category sibling and match
        // as "unofficial"
        var $cat = $(this).siblings('.category');
        var result = matchLink({
          title: text,
          url: $a.attr('href'),
          category: $cat.length ? $cat.data('orig-text') : "unofficial"
        }, words);
        if (result.matched && result.ranges.length) highlight($a, text, result.ranges);
        else $a.text(text);
        return result.matched;
      })

      // Follow the suggestion the user actually chose: the row whose title and
      // category match it, falling back to the first result when the suggestion
      // came from somewhere else (an older worker, a bookmarked ?q= URL)
      if (autocompleted && links.length) {
        var exact = links.filter(function () {
          var $a = $(this).find('a:first-child');
          if (!sameText($a.text(), picked.title)) return false;
          if (!picked.category) return true;
          var $c = $(this).siblings('.category');
          return sameText($c.length ? $c.data('orig-text') : AflinkSearch.UNOFFICIAL_CATEGORY, picked.category);
        });
        $(exact[0] || links[0]).find('a.main-link')[0].click();
      }
      links.toggle(true);

      // Show link category
      links.siblings('.category').toggle(true);

      // Decorate headers whose name matched a query word: highlight the
      // matched text and append a CATEGORY MATCH pill
      $('#link-list .category, #unofficial h2').each(function () {
        var $h = $(this);
        var htext = $h.data('orig-text');
        var hranges = matchRanges(htext, words);
        if (hranges.length) {
          highlight($h, htext, hranges);
          $h.append('<span class="category-match-pill">Category match</span>');
        } else {
          $h.text(htext);
        }
      });

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
      // Search on the suggestion's title alone — the category suffix after the
      // hidden space is for picking the row, not for matching
      searchParams.set("q", picked.title);
    }

    $("#search-form").val(searchParams.get("q")).change();
  }

});