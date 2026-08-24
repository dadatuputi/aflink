// Shared search matching — the single source of truth for "does this link
// match what was typed", used by BOTH:
//
//   * the page  (src/includes/js/search.js, inlined by src/includes/foot.pug)
//   * the address-bar autocomplete worker (search_worker/src/index.js)
//
// The two must agree: a suggestion the worker offers is resolved by loading
// the page with that title as the query, and the page then auto-follows its
// first result. Anything the worker suggests but the page cannot find is a
// dead suggestion, so matching rules live here and nowhere else.
//
// This file runs in two very different places, so it stays plain script text:
// no import/export (the page inlines it into a classic <script>), and it
// publishes itself on globalThis, which the worker picks up via a
// side-effect import.
(function (root) {
  "use strict";

  // Normalize a string for search: lowercase, accents folded, punctuation and
  // spaces dropped — so "e-mail" matches "eMail" and "af portal" matches
  // "AF Portal". Returns the normalized string plus a map from each normalized
  // character back to its index in the original, for match highlighting.
  function normalize(s) {
    var norm = "", map = [];
    s = s == null ? "" : String(s);
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

  // Split a query into the words that must ALL match. A word matches on its
  // whole normalized form ("e-mail" → "email"), or failing that on all of its
  // multi-character punctuation-separated parts ("mail"; the lone "e" is
  // dropped so single characters never match on their own).
  function parseQuery(value) {
    return String(value == null ? "" : value).toLowerCase()
      .split(/\s+/).filter(Boolean).map(function (w) {
        return {
          whole: normalize(w).norm,
          parts: w.split(/[^a-z0-9]+/).map(function (p) { return normalize(p).norm; })
            .filter(function (p) { return p.length > 1; })
        };
      }).filter(function (w) { return w.whole; });
  }

  // Does this link match every query word? A word may match the title, the
  // URL (scheme stripped), or the link's category name — "education" pulls up
  // the whole category, "unofficial" the whole unofficial section.
  //
  // link: { title, url, category }. Returns { matched, ranges }, where ranges
  // are [start, end] index pairs into the ORIGINAL title for highlighting;
  // an empty ranges array on a match means it matched only on URL/category.
  function matchLink(link, words) {
    var title = normalize(link.title);
    var url = normalize(String(link.url == null ? "" : link.url).replace(/^https?:\/\//, "")).norm;
    var cat = normalize(link.category).norm;
    var ranges = [];
    var matched = words.every(function (w) {
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
    return { matched: matched, ranges: ranges };
  }

  // Ranges for whichever query words appear in a plain string — used to
  // decorate category headers, which highlight partial matches rather than
  // requiring every word like a link row does.
  function matchRanges(text, words) {
    var n = normalize(text), ranges = [];
    words.forEach(function (w) {
      var p = n.norm.indexOf(w.whole);
      if (p > -1) {
        ranges.push([n.map[p], n.map[p + w.whole.length - 1]]);
        return;
      }
      if (!w.parts.length) return;
      var pr = [];
      var all = w.parts.every(function (t) {
        var q = n.norm.indexOf(t);
        if (q > -1) {
          pr.push([n.map[q], n.map[q + t.length - 1]]);
          return true;
        }
        return false;
      });
      if (all) ranges.push.apply(ranges, pr);
    });
    return ranges;
  }

  root.AflinkSearch = {
    normalize: normalize,
    parseQuery: parseQuery,
    matchLink: matchLink,
    matchRanges: matchRanges,
    // The page has no category header for unofficial rows and matches them as
    // "unofficial"; the worker labels their suggestions with this name.
    UNOFFICIAL_CATEGORY: "UNOFFICIAL"
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
