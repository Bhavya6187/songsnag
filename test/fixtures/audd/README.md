# AudD fixtures

Responses of AudD's standard endpoint (`POST https://api.audd.io/`).

- `recorded-match.json`: a real answer to a request with `return=spotify`,
  recorded on 2026-11-15. The `spotify` block is cut down to the fields the
  code reads; the real one is a full Spotify track object.
- `doc-match-no-spotify.json`: not a recording. A match without the `spotify`
  block, which the docs allow for and no real answer has shown yet. The title
  and artist are ones AudD returned on 2026-11-15.
- `recorded-no-match.json`: the real answer when AudD does not know the audio.
- `doc-error-limit.json`, `doc-error-fingerprint.json`: built from the error
  shape and codes in https://docs.audd.io/ as read on 2026-11-15. No error
  has been recorded yet. Code 901 (and 900, an invalid token) fails every
  request the same way; code 300 is about one file.
