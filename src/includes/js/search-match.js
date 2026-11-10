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
  // starts[k] says whether normalized character k begins a word.
  function normalize(s) {
    var norm = "", map = [], starts = [], prev = false;
    s = s == null ? "" : String(s);
    for (var i = 0; i < s.length; i++) {
      var c = s[i].toLowerCase().normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");
      for (var j = 0; j < c.length; j++) {
        norm += c[j];
        map.push(i);
        starts.push(!prev && j === 0);
      }
      prev = c.length > 0;
    }
    return { norm: norm, map: map, starts: starts };
  }

  // First index of t in n.norm that begins a word, or -1
  function indexAtWordStart(n, t) {
    var p = -1;
    while ((p = n.norm.indexOf(t, p + 1)) > -1) {
      if (n.starts[p]) return p;
    }
    return -1;
  }

  // Best title tier for t: whole title 100, title start 90, later word start
  // 70, inside a word 40
  function titleTier(title, t) {
    if (title.norm === t) return 100;
    if (title.norm.indexOf(t) === 0) return 90;
    var best = 0, p = -1;
    while ((p = title.norm.indexOf(t, p + 1)) > -1) {
      best = Math.max(best, title.starts[p] ? 70 : 40);
      if (best === 70) break;
    }
    return best;
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
  // link's summary or description, so "deployment" finds LOGMOD. In the
  // summary and description a match must start at a word, so "utap" doesn't
  // match "about: appointment".
  //
  // link: { title, url, category, summary, description }. Returns
  // { matched, ranges, inText, score }: ranges are [start, end] index pairs
  // into the ORIGINAL title for highlighting; an empty ranges array on a
  // match means it matched only elsewhere. inText says whether some word
  // matched the summary or description, which is when the page shows a
  // snippet. score ranks matches, higher first (see RANK).
  function matchLink(link, words) {
    var title = normalize(link.title);
    var url = normalize(String(link.url == null ? "" : link.url).replace(/^https?:\/\//, "")).norm;
    var cat = normalize(link.category).norm;
    var text = normalize(String(link.summary == null ? "" : link.summary) + " " +
      String(link.description == null ? "" : link.description));
    var ranges = [];
    var inText = false;
    var score = 0;

    // Where t matches and its tier, or null
    function place(t) {
      var p = title.norm.indexOf(t);
      if (p > -1) return { tier: titleTier(title, t), range: [title.map[p], title.map[p + t.length - 1]] };
      if (url.indexOf(t) > -1 || cat.indexOf(t) > -1) return { tier: RANK.urlOrCategory };
      if (indexAtWordStart(text, t) > -1) return { tier: RANK.text, inText: true };
      return null;
    }

    var matched = words.every(function (w) {
      var hit = place(w.whole);
      if (hit) {
        if (hit.range) ranges.push(hit.range);
        if (hit.inText) inText = true;
        score += hit.tier;
        return true;
      }
      if (!w.parts.length) return false;
      var hits = [];
      var all = w.parts.every(function (t) {
        var h = place(t);
        if (h) hits.push(h);
        return !!h;
      });
      if (!all) return false;
      // Found only in pieces: scored by the weakest piece, discounted
      var weakest = Infinity;
      hits.forEach(function (h) {
        if (h.range) ranges.push(h.range);
        if (h.inText) inText = true;
        weakest = Math.min(weakest, h.tier);
      });
      score += Math.round(weakest * RANK.partsFactor);
      return true;
    });

    if (!matched) return { matched: false, ranges: ranges, inText: inText, score: 0 };
    // Bonus when the words appear together as a phrase in the title
    if (words.length > 1) {
      var phrase = words.map(function (w) { return w.whole; }).join("");
      if (title.norm.indexOf(phrase) > -1) score += RANK.phrase;
    }
    return { matched: true, ranges: ranges, inText: inText, score: score };
  }

  // A link's score is the sum of each word's tier (title tiers: titleTier).
  // Page and worker sort by it, ties in page order.
  var RANK = {
    urlOrCategory: 25,
    text: 15,
    partsFactor: 0.8,
    phrase: 50,
    // Per word; below this a row matched only in text and the page folds it
    strongPerWord: 25
  };

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
        var p = indexAtWordStart(n, t);
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
    RANK: RANK,
    snippet: snippet,
    // The page has no category header for unofficial rows and matches them as
    // "unofficial"; the worker labels their suggestions with this name.
    UNOFFICIAL_CATEGORY: "UNOFFICIAL"
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
