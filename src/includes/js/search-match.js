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
  // URL (scheme stripped), the link's category name — "education" pulls up
  // the whole category, "unofficial" the whole unofficial section — or the
  // link's summary or description, so "deployment" finds LOGMOD.
  //
  // link: { title, url, category, summary, description }. Returns
  // { matched, ranges, inText }: ranges are [start, end] index pairs into the
  // ORIGINAL title for highlighting; an empty ranges array on a match means
  // it matched only elsewhere. inText says whether some word matched the
  // summary or description, which is when the page shows a snippet.
  function matchLink(link, words) {
    var title = normalize(link.title);
    var url = normalize(String(link.url == null ? "" : link.url).replace(/^https?:\/\//, "")).norm;
    var cat = normalize(link.category).norm;
    var text = normalize(String(link.summary == null ? "" : link.summary) + " " +
      String(link.description == null ? "" : link.description)).norm;
    var ranges = [];
    var inText = false;
    var matched = words.every(function (w) {
      var p = title.norm.indexOf(w.whole);
      if (p > -1) {
        ranges.push([title.map[p], title.map[p + w.whole.length - 1]]);
        return true;
      }
      if (url.indexOf(w.whole) > -1 || cat.indexOf(w.whole) > -1) return true;
      if (text.indexOf(w.whole) > -1) {
        inText = true;
        return true;
      }
      if (!w.parts.length) return false;
      var partRanges = [];
      var partInText = false;
      var all = w.parts.every(function (t) {
        var q = title.norm.indexOf(t);
        if (q > -1) {
          partRanges.push([title.map[q], title.map[q + t.length - 1]]);
          return true;
        }
        if (url.indexOf(t) > -1 || cat.indexOf(t) > -1) return true;
        if (text.indexOf(t) > -1) {
          partInText = true;
          return true;
        }
        return false;
      });
      if (all) {
        ranges.push.apply(ranges, partRanges);
        if (partInText) inText = true;
        return true;
      }
      return false;
    });
    return { matched: matched, ranges: ranges, inText: inText };
  }

  // A short excerpt of `text` around the first query word found in it, with
  // highlight ranges into the excerpt — what the page shows under a title
  // when the match came from the summary or description rather than the
  // title. Returns null when no word appears in the text.
  function snippet(text, words, radius) {
    text = String(text == null ? "" : text);
    radius = radius || 60;
    var n = normalize(text), hit = null;
    words.some(function (w) {
      return [w.whole].concat(w.parts).some(function (t) {
        var p = n.norm.indexOf(t);
        if (p > -1) {
          hit = [n.map[p], n.map[p + t.length - 1]];
          return true;
        }
        return false;
      });
    });
    if (!hit) return null;
    var start = Math.max(0, hit[0] - radius);
    var end = Math.min(text.length, hit[1] + 1 + radius);
    // Cut on word boundaries so the excerpt does not start or end mid-word
    if (start > 0) {
      var s = text.lastIndexOf(" ", start);
      if (s > -1 && s + 1 <= hit[0]) start = s + 1;
    }
    if (end < text.length) {
      var e = text.indexOf(" ", end);
      if (e > -1) end = e;
    }
    var lead = start > 0 ? "…" : "";
    var excerpt = lead + text.slice(start, end) + (end < text.length ? "…" : "");
    return { text: excerpt, ranges: matchRanges(excerpt, words) };
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
    snippet: snippet,
    // The page has no category header for unofficial rows and matches them as
    // "unofficial"; the worker labels their suggestions with this name.
    UNOFFICIAL_CATEGORY: "UNOFFICIAL"
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
