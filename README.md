# [aflink.us](https://aflink.us)

[![Searching aflink and toggling the dark theme](.github/demo.gif)](https://aflink.us)

---

## Changelog

- **Aug 2026** — ⌨️ Address-bar suggestions rebuilt on the page's own search rules: unofficial links are suggested, deleted ones no longer are, and picking a suggestion opens that exact link
- **Aug 2026** — ✈️ **Heraldry redesign**: new color scheme in the official USAF service colors — Ultramarine Blue & Air Force Yellow — across light and dark themes
- **Aug 2026** — 🌙 Dark mode, with a light/dark/auto toggle in the navbar; weekly automated link trust & rot checking
- **Aug 2026** — 📊 [Usage page](https://aflink.us/analytics) with 30-day/90-day/1-year stats; installable PWA with offline support; announcements; search now matches category names
- **Aug 2026** — 🔗 Unofficial section for community-curated third-party tools, with the same request/override workflows as official links
- **Dec 2025** — 🆔 Stable content IDs for every link, so overrides and deletions survive AF portal sync churn
- **Jul 2025** — ⌨️ Search autocomplete worker; `links.json` published with each build
- **Jun 2025** — 📝 Link override & deletion via GitHub issue forms — hover any link for the 📝/🗑️ icons; [overrides page](https://aflink.us/overrides) lists every change
- **Nov 2023** — 🔄 Automated weekly sync of links from the AF portal
- **Jul 2023** — 🪟 Transition modal when following a link
- **May 2023** — 🔍 Address-bar search suggestions (OpenSearch autocomplete)
- **Jan 2023** — 🤖 Links added automatically from approved GitHub issues
- **Jan 2022** — 🎨 Link categories & the OCP earth-tone theme; link request issue templates
- **May 2021** — ⚡ Tab-to-search from the browser address bar (`?q=` URLs), Enter opens the first result, autofocused search
- **Apr 2021** — 🚀 Initial launch: static mirror of the USAF portal quick links, rebuilt automatically via GitHub Actions

---

An accessible & simple page to find USAF links without needing to mess with the portal. 

Built using PUG templating, Github actions, and node. 

> _Saved XXXk Airmen over XXk hours by eliminating USAF portal logins! Promote now!_

# Link Requests

You may submit different link requests, all of which require a free Github account:

1. Add an `OTHER` link: 
    - [fill out this Github issue form](https://github.com/dadatuputi/aflink/issues/new?template=01_link_add.yaml)
    - When approved, this will add a link to the `OTHER` category
2. Override an existing AF Link
    - Click the `📝` icon when hovering over an existing link in categories other than `OTHER`
    - This will open a new issue with the details needed to match to the link
    - Provide the new Title or URL for the link
    - If you provide neither Title nor URL, this will act as a "deletion", making the link not appear in the list. This is useful for dead links etc.
    - When approved, the link will be overridden or deleted
3. Delete an existing custom link
    - Click the `🗑️` icon when hovering over a link in the `OTHER` category 
    - This will open a new issue with the details needed to match to the link
    - When approved, the link will be deleted