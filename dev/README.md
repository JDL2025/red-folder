# Developer notes (for Claude sessions)

Nothing in this folder is used by the live vault.

- `test-vault.js`: end-to-end browser test (Playwright + Chromium) that runs the real
  `index.html` against a simulated Google Drive and Google sign-in, and opens the
  generated USB copy (`offline.html` + data) from disk with all network blocked.
  Paths at the top of the file point to Claude's working folder; adjust `OUT` to
  the folder that holds `index.html`, `offline.html` and `jszip.min.js`.
- Live files: `index.html` (the vault), `jszip.min.js` (ZIP export), `offline.html`
  (template for the USB copy; the vault fills in the encrypted data).
