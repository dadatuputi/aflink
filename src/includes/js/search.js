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
  // Cleared once a row has been followed (or none matched), so later typing
  // in the box searches normally instead of auto-following the first match
  var autocompleted = (searchParams.has("q") && searchParams.get("q").includes('​'));

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
  $("#link-list .list-group-item a.main-link, #unofficial-list .list-group-item a.main-link").on('click', function(event) {
    var href = $(this).prop('href');
    $('#exit-modal .modal-header .title').text($(this).data('orig-text') || $(this).text());
    // The URL doubles as a working link: the navigation this click starts can
    // hang for a long time on a slow destination, and the modal is the only
    // thing on screen at that point. title= carries the full URL because the
    // display is truncated with an ellipsis.
    $('#exit-modal .link a').attr({ href: href, title: href }).text(href);

    // Record which link was used so the analytics page can rank resources.
    // Anonymous event; gtag delivers via sendBeacon so navigation isn't delayed.
    if (typeof gtag === 'function') {
      gtag('event', 'link_click', {
        link_title: $(this).data('orig-text') || $(this).text(),
        link_url: this.href,
        link_category: $(this).closest('.link-container').data('category')
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

  // Link details: the "…" after a summary opens a dialog with the full
  // description, filled from the row it sits in
  const detail_modal = new bootstrap.Modal(document.getElementById('detail-modal'));
  $('#link-list, #unofficial-list, #search-results').on('click', '.summary-more', function () {
    var $row = $(this).closest('.link-container');
    var $a = $row.find('a.main-link');
    var title = $a.data('orig-text') || $a.text();
    $('#detail-modal .modal-title').text(title);
    $('#detail-modal .meta').text($(this).data('meta') || '');
    $('#detail-modal .description').text($(this).data('description') || $row.find('.summary-text').data('orig-text') || '');
    $('#detail-modal .open-link').attr({ href: $a.attr('href'), title: $a.attr('href') }).data('link-title', title);
    detail_modal.show();
  });
  $('#detail-modal .open-link').on('click', function () {
    if (typeof gtag === 'function') {
      gtag('event', 'link_click', { link_title: $(this).data('link-title'), link_url: this.href, link_category: 'DETAILS' });
    }
  });

  // Matching rules live in search-match.js, which the autocomplete worker
  // imports too — keeping address-bar suggestions and on-page results in
  // agreement. Change matching there, never here.
  var parseQuery = AflinkSearch.parseQuery;
  var matchLink = AflinkSearch.matchLink;
  var matchRanges = AflinkSearch.matchRanges;
  var snippet = AflinkSearch.snippet;

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

  // Remember pristine header, title and summary text: search decorates them
  // with highlights or a description snippet, and matching must read the
  // original text
  $('#list-heading, .main-link, .summary-text').each(function () {
    $(this).data('orig-text', $(this).text());
  });

  // Every link row, in page order: official categories, then unofficial.
  // While searching, matching rows move into #search-results in ranked order
  // (the same order the address-bar suggestions use), each tagged with its
  // category; clearing the search puts them back where they came from.
  var $results = $('#search-results');
  var rows = $('#link-list .link-container, #unofficial-list .link-container').map(function (i) {
    var $row = $(this);
    var $cat = $row.siblings('.category');
    var unofficial = !$cat.length;
    var category = unofficial ? AflinkSearch.UNOFFICIAL_CATEGORY : $cat.text();
    var label = unofficial ? 'Unofficial' : category;
    var $tag = $('<span class="result-cat"></span>').text(label).toggleClass('unofficial', unofficial);
    $tag.data('orig-text', label);
    $row.find('.link-title').append($tag);
    $row.data({ order: i, home: this.parentNode, category: category });
    return this;
  }).get();

  // Search-results mode on or off. Off puts every row back in its category,
  // in page order (each category's header stays first in its group).
  function showResults(on) {
    $results.prop('hidden', !on);
    $('#link-list').prop('hidden', on);
    $('#unofficial').prop('hidden', on);
    var $h = $('#list-heading');
    $h.text(on ? 'Search results' : $h.data('orig-text'));
    if (!on) {
      $results.children('.more-results').remove();
      rows.forEach(function (row) {
        $(row).removeClass('folded').prop('hidden', false);
        $(row).data('home').appendChild(row);
      });
    }
  }

  // Description-only matches sit behind this button when better ones exist
  $results.on('click', '.more-results', function () {
    $results.children('.folded').removeClass('folded').prop('hidden', false);
    $(this).remove();
  });

  // Filter links based on search query
  $("#search-form").on(
    "change keyup paste search",
    function (event) {
      var value = $(this).val().toLowerCase();

      // Every whitespace-separated word must match; see search-match.js
      var words = parseQuery(value);

      // Match every row against the title, the URL, the category, the
      // summary or the description. Title matches are highlighted; a match
      // found only in the summary or description shows the matched passage
      // in place of the summary line.
      var hits = [];
      rows.forEach(function (row) {
        var $row = $(row);
        var $a = $row.find('a.main-link');
        var text = $a.data('orig-text');
        var $summary = $row.find('.summary-text');
        var summaryText = $summary.data('orig-text') || '';
        var description = $row.find('.summary-more').data('description') || '';
        var result = matchLink({
          title: text,
          url: $a.attr('href'),
          category: $row.data('category'),
          summary: summaryText,
          description: description
        }, words);
        if (result.matched && result.ranges.length) highlight($a, text, result.ranges);
        else $a.text(text);
        var excerpt = result.matched && !result.ranges.length && result.inText
          ? (snippet(summaryText, words) || snippet(description, words))
          : null;
        if (excerpt) highlight($summary, excerpt.text, excerpt.ranges);
        else $summary.text(summaryText);
        // The category tag shows why a category match is listed
        var $tag = $row.find('.result-cat');
        var tagText = $tag.data('orig-text');
        var tagRanges = matchRanges(tagText, words);
        if (tagRanges.length) highlight($tag, tagText, tagRanges);
        else $tag.text(tagText);
        if (result.matched) hits.push({ row: row, score: result.score, order: $row.data('order') });
      });

      // Best first; ties keep page order, as the worker's suggestions do
      hits.sort(function (x, y) { return y.score - x.score || x.order - y.order; });

      if (!words.length) {
        showResults(false);
      } else {
        // Rows that matched only in a summary or description fold behind a
        // button when anything matched better; if nothing did, they show
        var strongMin = AflinkSearch.RANK.strongPerWord * words.length;
        var strong = hits.filter(function (h) { return h.score >= strongMin; });
        var weak = hits.filter(function (h) { return h.score < strongMin; });
        if (!strong.length) { strong = weak; weak = []; }
        $results.children('.more-results').remove();
        $results.children('.link-container').detach();
        strong.forEach(function (h) { $(h.row).removeClass('folded').prop('hidden', false).appendTo($results); });
        if (weak.length) {
          $('<button type="button" class="list-group-item list-group-item-action more-results"></button>')
            .text(weak.length + ' more mention “' + $(this).val().trim() + '” in ' +
              (weak.length === 1 ? 'its description' : 'their descriptions'))
            .appendTo($results);
          weak.forEach(function (h) { $(h.row).addClass('folded').prop('hidden', true).appendTo($results); });
        }
        showResults(hits.length > 0);
        // Nothing matched: hide both lists under the "No results" note
        if (!hits.length) $('#link-list, #unofficial').prop('hidden', true);
      }

      // Follow the suggestion the user actually chose: the row whose title and
      // category match it, falling back to the top result when the suggestion
      // came from somewhere else (an older worker, a bookmarked ?q= URL)
      if (autocompleted) {
        autocompleted = false;
        if (hits.length) {
          var exact = hits.filter(function (h) {
            var $row = $(h.row);
            if (!sameText($row.find('a.main-link').data('orig-text'), picked.title)) return false;
            return !picked.category || sameText($row.data('category'), picked.category);
          });
          $((exact[0] || hits[0]).row).find('a.main-link')[0].click();
        }
      }

      // Update URL with new search params
      updateSearchParams($(this).val())

      // If nothing matched, say so
      if (words.length && !hits.length) {
        $("#list p").removeAttr('hidden');
        $("#list p em").text(value);
      } else {
        $("#list p").attr('hidden','hidden');
      }

      // On enter keypress, follow the top result
      if (
        value &&
        event.type === "keyup" &&
        event.originalEvent.key === "Enter"
      ) {
        var first = words.length ? (hits[0] && $(hits[0].row).find('a.main-link')[0])
          : $("#link-list a.main-link")[0];
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